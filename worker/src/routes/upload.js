import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';

// ============================================================
// POST /api/admin/upload/logo — upload logo (owner)
// POST /api/super/practices/:id/logo — upload logo (super-admin for any practice)
//
// Content-Type: multipart/form-data (field "file")
// OR          : application/octet-stream with X-Filename header
//
// Returns: { logo_url: "https://..." }
// ============================================================

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

async function extractFile(request) {
  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.startsWith('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return null;
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      type: file.type || 'application/octet-stream',
      name: file.name || 'logo',
    };
  }

  // Fallback: raw bytes
  const filename = request.headers.get('X-Filename') || 'logo';
  const bytes = new Uint8Array(await request.arrayBuffer());
  return {
    bytes,
    type: contentType || 'application/octet-stream',
    name: filename,
  };
}

async function uploadLogoToR2(env, practiceSlug, file) {
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    throw Object.assign(new Error(`Dateiformat nicht erlaubt (${file.type}). Erlaubt: PNG, JPG, SVG, WebP.`), { status: 400 });
  }
  if (file.bytes.byteLength > MAX_BYTES) {
    throw Object.assign(new Error(`Datei zu groß (${(file.bytes.byteLength/1024/1024).toFixed(1)} MB). Max ${MAX_BYTES/1024/1024} MB.`), { status: 413 });
  }
  if (file.bytes.byteLength < 50) {
    throw Object.assign(new Error('Datei zu klein / leer.'), { status: 400 });
  }

  // Key: praxmate/logos/{slug}-{timestamp}.{ext}
  // Timestamp ensures cache-busting when logo changes
  const key = `praxmate/logos/${practiceSlug}-${Date.now()}.${ext}`;

  await env.R2.put(key, file.bytes, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  // Public URL — served via the public R2 bucket subdomain
  // Hasi uses `pub-{...}.r2.dev` OR the bound custom domain.
  // We use the bound domain variable set in wrangler config.
  const baseUrl = env.R2_PUBLIC_URL || 'https://pub-2a0c9e3d5b0f49d6b6e8f2a5c7d9e3f1.r2.dev';
  return `${baseUrl}/${key}`;
}

// ============================================================
// HANDLER: practice owner uploads their own logo
// ============================================================
export async function handleOwnerLogoUpload(env, request) {
  const user = await requireAuth(env, request);
  if (user.role !== 'owner') {
    return jsonError('Nur der Inhaber kann das Logo ändern.', request, 403);
  }

  const file = await extractFile(request);
  if (!file) return jsonError('Keine Datei empfangen', request, 400);

  // Look up practice slug
  const practice = await env.DB.prepare(
    `SELECT slug, logo_url FROM practices WHERE id = ?`
  ).bind(user.practice_id).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  try {
    const logoUrl = await uploadLogoToR2(env, practice.slug, file);

    // Update practice
    await env.DB.prepare(`UPDATE practices SET logo_url = ? WHERE id = ?`)
      .bind(logoUrl, user.practice_id).run();

    // Delete old logo if it's in our R2
    if (practice.logo_url && practice.logo_url.includes('/praxmate/logos/')) {
      try {
        const oldKey = practice.logo_url.split('/').slice(-3).join('/');
        await env.R2.delete(oldKey);
      } catch {} // ignore cleanup errors
    }

    await logAudit(env, {
      practice_id: user.practice_id,
      actor_type: 'user',
      actor_id: user.user_id,
      action: 'practice.logo_updated',
      meta: { logo_url: logoUrl },
      request,
    });

    return jsonResponse({ logo_url: logoUrl }, request);
  } catch (e) {
    return jsonError(e.message, request, e.status || 500);
  }
}

// ============================================================
// HANDLER: super-admin uploads for any practice
// ============================================================
export async function handleSuperLogoUpload(env, request, practiceId) {
  const user = await requireAuth(env, request);
  if (user.email !== 'h.guencavdi@hasi-elektronic.de') {
    return jsonError('Nur Super-Admin.', request, 403);
  }

  const file = await extractFile(request);
  if (!file) return jsonError('Keine Datei empfangen', request, 400);

  const practice = await env.DB.prepare(
    `SELECT slug, logo_url FROM practices WHERE id = ?`
  ).bind(practiceId).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  try {
    const logoUrl = await uploadLogoToR2(env, practice.slug, file);
    await env.DB.prepare(`UPDATE practices SET logo_url = ? WHERE id = ?`)
      .bind(logoUrl, practiceId).run();

    if (practice.logo_url && practice.logo_url.includes('/praxmate/logos/')) {
      try {
        const oldKey = practice.logo_url.split('/').slice(-3).join('/');
        await env.R2.delete(oldKey);
      } catch {}
    }

    await logAudit(env, {
      practice_id: practiceId,
      actor_type: 'user',
      actor_id: user.user_id,
      action: 'practice.logo_updated',
      meta: { by: user.email, logo_url: logoUrl },
      request,
    });

    return jsonResponse({ logo_url: logoUrl }, request);
  } catch (e) {
    return jsonError(e.message, request, e.status || 500);
  }
}

// ============================================================
// HANDLER: remove logo (both owner + super)
// ============================================================
export async function handleLogoDelete(env, request, practiceIdOrSelf) {
  const user = await requireAuth(env, request);
  const isSuper = user.email === 'h.guencavdi@hasi-elektronic.de';

  let practiceId;
  if (practiceIdOrSelf === 'self') {
    if (user.role !== 'owner') return jsonError('Nur Inhaber.', request, 403);
    practiceId = user.practice_id;
  } else {
    if (!isSuper) return jsonError('Nur Super-Admin.', request, 403);
    practiceId = practiceIdOrSelf;
  }

  const practice = await env.DB.prepare(
    `SELECT logo_url FROM practices WHERE id = ?`
  ).bind(practiceId).first();

  if (practice?.logo_url && practice.logo_url.includes('/praxmate/logos/')) {
    try {
      const oldKey = practice.logo_url.split('/').slice(-3).join('/');
      await env.R2.delete(oldKey);
    } catch {}
  }

  await env.DB.prepare(`UPDATE practices SET logo_url = NULL WHERE id = ?`)
    .bind(practiceId).run();

  await logAudit(env, {
    practice_id: practiceId,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'practice.logo_removed',
    request,
  });

  return jsonResponse({ ok: true }, request);
}

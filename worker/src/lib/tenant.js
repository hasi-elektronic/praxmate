// ============================================================
// TENANT RESOLVER
// ============================================================
// Every public API request is scoped to a single practice.
// The practice is determined from:
//   1. X-Praxmate-Practice header (for testing/explicit)
//   2. The "Origin" header's hostname (during real-world use)
//   3. A 'practice' query param (fallback for ?practice=hild)
//
// Examples:
//   Origin: https://hild.praxmate.de          → practice "hild"
//   Origin: https://termin.zahnarzthild.de    → check practice_domains table
//   Origin: https://praxmate.pages.dev        → must pass ?practice=hild or X-Praxmate-Practice: hild
//
// For admin endpoints, the tenant is determined from the authenticated
// user's session (user.practice_id) — see auth.js.
// ============================================================

export async function resolvePracticeFromRequest(env, request) {
  // 1. Explicit header (for dev/testing)
  const headerSlug = request.headers.get('X-Praxmate-Practice');
  if (headerSlug) {
    const p = await getPracticeBySlug(env, headerSlug);
    if (p) return p;
  }

  // 2. Hostname (Origin OR url)
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  let hostname = origin ? new URL(origin).hostname : url.hostname;

  // First check exact custom domain match
  const customDomain = await env.DB.prepare(`
    SELECT p.*
    FROM practice_domains d
    JOIN practices p ON p.id = d.practice_id
    WHERE d.hostname = ? AND d.verified = 1
    LIMIT 1
  `).bind(hostname).first();
  if (customDomain) return customDomain;

  // Then subdomain of praxmate.de: "hild.praxmate.de" → slug "hild"
  const praxmateMatch = hostname.match(/^([a-z0-9-]+)\.praxmate\.de$/);
  if (praxmateMatch) {
    const slug = praxmateMatch[1];
    // Skip reserved subdomains (www, api, admin, app)
    if (!['www', 'api', 'admin', 'app', 'mail'].includes(slug)) {
      const p = await getPracticeBySlug(env, slug);
      if (p) return p;
    }
  }

  // 3. Query param fallback (for praxmate.pages.dev during development)
  const queryParam = url.searchParams.get('practice');
  if (queryParam) {
    const p = await getPracticeBySlug(env, queryParam);
    if (p) return p;
  }

  return null;
}

export async function getPracticeBySlug(env, slug) {
  return await env.DB.prepare(`
    SELECT id, slug, name, specialty, street, postal_code, city, country,
           phone, email, website, brand_primary, brand_accent, brand_ink,
           logo_url, legal_name, tax_id, responsible_person,
           professional_chamber, timezone, locale, plan, plan_status
    FROM practices
    WHERE slug = ? AND plan_status != 'suspended'
    LIMIT 1
  `).bind(slug).first();
}

export async function getPracticeById(env, id) {
  return await env.DB.prepare(`
    SELECT id, slug, name, specialty, street, postal_code, city, country,
           phone, email, website, brand_primary, brand_accent, brand_ink,
           logo_url, legal_name, tax_id, responsible_person,
           professional_chamber, timezone, locale, plan, plan_status
    FROM practices
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

/**
 * Middleware: require a resolved practice for public endpoints.
 * Returns the practice or throws via the passed jsonError function.
 */
export async function requirePractice(env, request) {
  const practice = await resolvePracticeFromRequest(env, request);
  if (!practice) {
    const error = new Error('Praxis konnte nicht ermittelt werden. Bitte über die Praxis-URL zugreifen.');
    error.status = 404;
    throw error;
  }
  return practice;
}

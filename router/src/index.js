// ============================================================
// PRAXMATE TENANT ROUTER
// ============================================================
// Two routing modes:
//
//   1. Wildcard subdomain — *.praxmate.de
//      e.g. hild.praxmate.de    → slug "hild"
//      Slug derived from the leftmost label.
//
//   2. Custom hostname — registered in D1 practice_domains
//      e.g. termin.zahnarzthild.de → slug "hild" (looked up)
//      Customer adds CNAME to praxmate.pages.dev, we look up the
//      hostname → tenant mapping and inject X-Praxmate-Practice header.
//
// Either way the request is forwarded to praxmate.pages.dev with the
// browser address bar preserved.  Client JS already reads either
//   - window.location.hostname (subdomain mode)
//   - x-praxmate-practice header — wait, the browser can't read that
// For the custom-domain case we instead also pass `?practice=<slug>`
// in the URL so the front-end's resolvePracticeSlug() sees it.
// ============================================================

const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'blog', 'status', 'docs',
  'support', 'cdn', 'static', 'assets', 'm', 'mobile', 'help',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

// Tiny in-memory KV-style cache so we don't hammer D1 on every request.
// Workers isolate cache lifetime ≈ minutes; that's fine for hostname →
// slug mappings which change rarely.
const HOSTNAME_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveCustomHostname(env, hostname) {
  const now = Date.now();
  const cached = HOSTNAME_CACHE.get(hostname);
  if (cached && cached.expires > now) return cached.slug;

  const row = await env.DB.prepare(`
    SELECT pr.slug
    FROM practice_domains pd
    JOIN practices pr ON pr.id = pd.practice_id
    WHERE pd.hostname = ? AND pd.verified = 1 AND pr.plan_status != 'suspended'
    LIMIT 1
  `).bind(hostname).first();

  const slug = row?.slug || null;
  HOSTNAME_CACHE.set(hostname, { slug, expires: now + CACHE_TTL_MS });
  return slug;
}

async function proxy(request, slug, opts = {}) {
  // Forward to Pages. For custom domains we add ?practice=<slug>
  // so the SPA's resolvePracticeSlug() picks up the tenant.
  const target = new URL(request.url);
  target.hostname = 'praxmate.pages.dev';
  if (opts.injectPracticeParam && slug && !target.searchParams.has('practice')) {
    target.searchParams.set('practice', slug);
  }
  const init = {
    method: request.method,
    headers: request.headers,
    body: ['GET','HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  };
  return fetch(new Request(target.toString(), init));
}

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // ----- Mode 1: *.praxmate.de wildcard -----
    const sub = host.match(/^([a-z0-9-]+)\.praxmate\.de$/);
    if (sub) {
      const slug = sub[1];
      if (RESERVED.has(slug))    return new Response('Reserved subdomain', { status: 404 });
      if (!SLUG_RE.test(slug))   return new Response('Invalid practice URL', { status: 400 });
      // No need to inject — the SPA reads the slug from window.location.hostname
      return proxy(request, slug, { injectPracticeParam: false });
    }

    // ----- Mode 2: custom hostname (e.g. termin.zahnarzthild.de) -----
    // Look up the host in practice_domains. If found, inject ?practice=<slug>.
    const slug = await resolveCustomHostname(env, host);
    if (slug) {
      return proxy(request, slug, { injectPracticeParam: true });
    }

    // No match — refuse politely so an accidental DNS misconfig doesn't
    // serve random Pages content from our domain.
    return new Response(
      'This hostname is not registered with Praxmate.\n' +
      'Contact support@praxmate.de to attach your domain.',
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },
};

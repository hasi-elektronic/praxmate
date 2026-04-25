// ============================================================
// PRAXMATE TENANT ROUTER (wildcard subdomain handler)
// ============================================================
// Purpose: serve `<slug>.praxmate.de` for every tenant via a single
// transparent proxy to the Pages project.
//
// Why a Worker and not a Pages custom domain:
//   CF Pages does NOT accept wildcard custom domains via the standard
//   "Set up a custom domain" UI/API (you'd have to add each subdomain
//   one by one). Worker Routes do support the `*.host.tld/*` pattern,
//   so we register one Worker Route on the praxmate.de zone and let
//   the worker proxy to praxmate.pages.dev internally.
//
// What it does on every request:
//   1. Match host against *.praxmate.de
//   2. Block reserved subdomains (www, api, admin, ...) → 404
//   3. Forward path + headers to https://praxmate.pages.dev/<path>
//   4. Stream response back unchanged
//
// The browser address bar stays at <slug>.praxmate.de; the client-side
// JS reads `window.location.hostname` and uses the slug for tenant-
// scoped API calls. No code changes elsewhere needed.
// ============================================================

const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'blog', 'status', 'docs',
  'support', 'cdn', 'static', 'assets', 'm', 'mobile', 'help',
]);

// Slug rules (mirrors signup validation):
//   2-30 chars, lowercase letters/digits/dashes, no leading/trailing dash
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // The route is *.praxmate.de/*, but be defensive
    const m = host.match(/^([a-z0-9-]+)\.praxmate\.de$/);
    if (!m) {
      return new Response('Not found', { status: 404 });
    }

    const slug = m[1];

    // Block reserved hosts
    if (RESERVED.has(slug)) {
      return new Response('Reserved subdomain', { status: 404 });
    }

    // Slug must be valid — defends against typos and injection attempts
    if (!SLUG_RE.test(slug)) {
      return new Response('Invalid practice URL', { status: 400 });
    }

    // Forward the request to Pages, preserving method, body, headers.
    const target = new URL(request.url);
    target.hostname = 'praxmate.pages.dev';

    const init = {
      method: request.method,
      headers: request.headers,
      body: ['GET','HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    };
    // Cloudflare's fetch needs a fresh Request object so cf-related
    // metadata is recomputed for the new origin.
    return fetch(new Request(target.toString(), init));
  },
};

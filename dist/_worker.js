// ==============================================================
// Praxmate — Pages Advanced Mode edge router
// ==============================================================
// praxmate.com  → transparently serves /en/* (EN content, URL stays .com)
// praxmate.de   → serves root (DE content)
// Anything under /api/, /praxis/, /admin/, or explicit /en/ is passed through.
// ==============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // Only rewrite for the .com hostname
    const isCom = host === 'praxmate.com' || host === 'www.praxmate.com';
    if (!isCom) {
      return env.ASSETS.fetch(request);
    }

    // Normalize www → apex (301)
    if (host === 'www.praxmate.com') {
      url.hostname = 'praxmate.com';
      return Response.redirect(url.toString(), 301);
    }

    const p = url.pathname;

    // Paths that must NEVER be rewritten:
    //   /en/...      already English, pass through
    //   /praxis/...  customer admin (DE UI, tenant-scoped)
    //   /admin/...   super-admin
    //   /api/...     any API proxy (unused here, but defensive)
    //   /widget.js   embeddable widget
    //   assets with a file extension that look like a build artifact
    const passthrough =
      p.startsWith('/en/') ||
      p === '/en' ||
      p.startsWith('/tr/') ||
      p === '/tr' ||
      p.startsWith('/praxis/') ||
      p.startsWith('/admin/') ||
      p.startsWith('/api/') ||
      p === '/signup.html' ||    // single-file trilingual signup (locale auto-detected)
      p === '/widget.js' ||
      p === '/_headers' ||
      p === '/_redirects';

    if (passthrough) {
      return env.ASSETS.fetch(request);
    }

    // Rewrite: prepend /en to the path, fetch the EN asset, serve with .com URL unchanged
    const rewritten = new URL(request.url);
    rewritten.pathname = '/en' + (p === '/' ? '/' : p);

    const response = await env.ASSETS.fetch(new Request(rewritten.toString(), request));

    // If the EN asset doesn't exist (404), fall back to root (DE) so we
    // don't blackhole content that only lives at the non-localized path.
    if (response.status === 404) {
      return env.ASSETS.fetch(request);
    }
    return response;
  },
};

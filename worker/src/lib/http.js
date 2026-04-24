// Response helpers
// All admin endpoints use credentials:include → need origin-specific CORS
// Public endpoints can use '*'

const ALLOWED_ORIGINS = [
  /^https:\/\/praxmate\.de$/,                         // root domain (landing, /demo page)
  /^https:\/\/[a-z0-9-]+\.praxmate\.de$/,             // tenant subdomains (hild.praxmate.de ...)
  /^https:\/\/praxmate\.pages\.dev$/,
  /^https:\/\/[a-z0-9-]+\.praxmate\.pages\.dev$/,
  /^https:\/\/[a-f0-9]{8}\.praxmate\.pages\.dev$/,
  /^http:\/\/localhost:\d+$/,
];

// Security headers applied to every API response.
// HSTS only gets served over HTTPS by CF, so including it always is safe.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
};

export function corsHeaders(request, credentials = true) {
  const origin = request.headers.get('Origin');
  const allowed = origin && ALLOWED_ORIGINS.some(re => re.test(origin));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : (credentials ? 'https://praxmate.pages.dev' : '*'),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Praxmate-Practice',
    'Access-Control-Allow-Credentials': credentials ? 'true' : 'false',
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
    ...SECURITY_HEADERS,
  };
}

export function jsonResponse(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

export function jsonError(message, request, status = 400, extra = {}) {
  return jsonResponse({ error: message, ...extra }, request, status);
}

export function handleOptions(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export function getUserAgent(request) {
  return (request.headers.get('User-Agent') || 'unknown').slice(0, 255);
}

// ============================================================================
// AE TWA - WORKER.JS - RELAY (AEI + AEEA FUSED), Final, First edition - REVISED
// Cloudflare Worker. Stateless relay plus minimal relay info page.
// One system. Backend authoritative. No synthetic bars ever.
//
// Fusion:
//   - AEI seed loop: prime -> outward lattice -> Hopf -> s2=r2 -> DbZ -> I
//     -> SelfEvolution. Frontend for AEI is the TWA entry page.
//   - AEEA market engine: bars -> 13 normalised indicators + Ichimoku ->
//     m/n/delta (max 14: 13 loop + 1 Ichimoku; thresholds 69.33/30.66) ->
//     regime -> BBx58 (null until 58 bars) -> P_arc -> signal iff delta-gate ->
//     orders/trailing/FVG.
//   - Fused on ONE ordered feed: each tick in arrival order advances the
//     AEEA bar ring AND is lifted to exact Fraction x for the AEI seed loop
//     via x = abs(price - prevPrice)/10000 (or 1/100 when zero).
//   - This worker does NOT implement any of that. It only proxies the one
//     ordered state from the backend to the frontend. Backend authoritative.
//     Frontend never computes truth and never sends x. It only renders /miniapp-state.
//     x is lifted in the backend from backend price and prevPrice.
//
// Audit directives, enforced in this file:
//   - NO SYNTHETIC BARS EVER. No random walk, no fallback synthetic, no
//     standalone synthetic, no synthetic in worker, app, or frontend.
//     Worker never generates bars, never fills gaps, never returns a
//     placeholder lattice 0, never returns a fake 100.00 indicator value.
//     If the backend returns a synthetic payload, worker returns 502.
//   - BACKEND AUTHORITATIVE. Frontend never computes truth. Worker never
//     computes truth. Worker never modifies backend JSON. It forwards the
//     backend body verbatim (original text, not re-serialised) so exact
//     Fraction strings from the backend are preserved byte for byte.
//   - LATTICE [] EQUALS WAITING, NEVER 0. Same for price null, BB null,
//     grid null. WAITING values pass through untouched. Only a numeric
//     lattice_points of 0, or a synthetic flag of true, is rejected.
//   - ONE FORMATTER FOR APP AND BOT. format_aea in the backend is the only
//     formatter. Worker has no formatter, no signal logic, no price logic.
//   - ONE ORDERED STREAM. Consumed once, in arrival order. Never shuffled,
//     never replayed, never batched. Worker adds no ordering, no queue, no
//     replay, no batching, no cache. Every API response carries
//     Cache-Control: no-store. Worker never caches /miniapp-state.
//   - ONE STATE. GET /miniapp-state returns ordered feed, bars, indicators,
//     seed, CS, aea_notification in one tick. Worker proxies that one state
//     verbatim. It does not merge, split, or synthesise state from parts.
//   - NO LOCAL-ONLY PATHS. Teach, Say, Step, Handshake, Crawler-enqueue,
//     Reset, Order all go through backend. Worker has no local Teach, Say,
//     Step, Handshake, Crawler, Reset, or Order implementation. Every one
//     of those paths is proxied to the backend, or 404 if unknown.
//   - NO FAKE 100.00 VALUES. 13D grid returns null per indicator until it
//     has enough real bars. Worker never fills nulls, never fills 100.00.
//   - AUTH: Header only. X-Telegram-Init-Data. Never query-string auth.
//     Worker forwards X-Telegram-Init-Data and Authorization (TMA) headers
//     verbatim to the backend. Worker never validates, never logs, never
//     stores, never echoes, and never puts auth into a query string or a
//     response body. Worker strips auth_init_data, auth, and backend params
//     from the upstream query string so auth can never leak in a URL.
//     Backend validates HMAC, auth_date within 86400s, and allowlist.
//   - CORS: Do not reflect Origin when ALLOWED_ORIGIN is '*'. Vary: Origin
//     always. When ALLOWED_ORIGIN is a list, only an exact match is
//     reflected, with credentials. A non-matching Origin is never
//     reflected. Worker never reflects an arbitrary Origin.
//   - LIVENESS VS CONFIG: /health is public, no relay URL, no shard pool,
//     no user ids, no Telegram DB details. /config requires auth (backend
//     enforces it) and returns non-sensitive config only. Worker never
//     returns the backend URL, the relay URL, a shard pool, a user id, or
//     a token in any response, log, or error.
//   - NO BACKEND URL IN THIS FILE. No backend host, no relay host, no
//     frontend host appears in this file, plain, base64, or encoded.
//     Backend is supplied at runtime only via env BACKEND_URL. Allowed
//     origin is supplied at runtime only via env ALLOWED_ORIGIN. The root
//     path returns generic relay text with no backend URL in it.
//   - NO SECRETS IN THIS FILE. No bot token, no relay key, no password.
//     env RELAY_KEY, when set, is forwarded to the backend only as an
//     upstream header. It is never required from the client, never logged,
//     never echoed, never returned.
//
// Env (set in the Worker dashboard or via wrangler secret / vars):
//   - BACKEND_URL: backend base URL, no trailing slash. Required.
//     Example shape is documented in the deploy guide, not in this file.
//   - ALLOWED_ORIGIN: '*' (default) or one origin or a comma-separated
//     list of exact origins. When '*', Allow-Origin is '*' and no
//     credentials are sent. When a list, only exact matches are reflected.
//   - RELAY_KEY: optional shared secret. When set, sent to the backend only
//     as X-Relay-Key on the upstream fetch. Never required from the client.
//
// Endpoints (exact allowlist - anything not listed here is 404):
//   GET:    /health, /miniapp-state, /cs-state, /cs-feedback, /ohlcv, /signals,
//           /diagnostics, /orders, /log, /toasts, /lattice-state, /seed-state,
//           /fibration-state, /symbolic-state, /observer-integral,
//           /evolution-state, /crawler-state, /aea-notification, /config,
//           /probe, /fvg, /state, /projection, /regime-map, /indicators,
//           /settings
//   POST:   /cs-feedback, /step, /handshake, /teach, /say,
//           /crawler-enqueue, /reset, /order, /order/close, /notify-aea,
//           /encode-syllable, /log
//   DELETE: /orders, /fvg/<id>
//   OPTIONS: CORS preflight for any listed path. Any other method is 405.
//   GET /: generic relay text, no backend URL. GET /robots.txt: disallow.
//   GET /favicon.ico: 204, no body.
//
// Errors:
//   - Backend unreachable or timed out: 502, {ok:false, status:'waiting',
//     reason:'Backend unreachable, WAITING, no synthetic bars'}. Never 200
//     with fake data. Never a synthetic bar. Never a placeholder lattice.
//   - Backend returns synthetic payload: 502, {ok:false, status:'waiting',
//     reason:'Backend returned synthetic payload, rejected by audit'}.
//   - Backend returns any other status (401, 400, 404, 500, ...): passed
//     through verbatim, status and body unchanged, so the backend stays
//     authoritative and auth failures are never masked as waiting.
//   - BACKEND_URL not set: 502, {ok:false, error:'BACKEND_URL not set',
//     status:'waiting'}. Never 200 with fake data.
//   - Unknown path: 404, {ok:false, error:'not_found',
//     hint:'Use /miniapp-state, single truth'}.
//   - Unsupported method: 405, {ok:false, error:'method_not_allowed'}.
//
// Deploy: wrangler deploy. No build. No bundler. No node_modules.
// Version: Final, First edition - Revised (bounded-precision exact rational
//   backend; this worker is unchanged in behaviour except the audit fixes
//   listed in the header: auth forwarding, CORS allowlist, no URL leak,
//   full endpoint allowlist, verbatim body, no-store, query auth stripping,
//   synthetic deep check, upstream timeout).
// ============================================================================

var UPSTREAM_TIMEOUT_MS = 30000;
var WORKER_NAME = 'AE-TWA-Worker/1.0-final-first';

var GET_ROUTES = {
  '/health': true,
  '/miniapp-state': true,
  '/cs-state': true,
  '/cs-feedback': true,
  '/ohlcv': true,
  '/signals': true,
  '/diagnostics': true,
  '/orders': true,
  '/log': true,
  '/toasts': true,
  '/lattice-state': true,
  '/seed-state': true,
  '/fibration-state': true,
  '/symbolic-state': true,
  '/observer-integral': true,
  '/evolution-state': true,
  '/crawler-state': true,
  '/aea-notification': true,
  '/config': true,
  '/probe': true,
  '/fvg': true,
  '/state': true,
  '/projection': true,
  '/regime-map': true,
  '/indicators': true,
  '/settings': true
};

var POST_ROUTES = {
  '/cs-feedback': true,
  '/step': true,
  '/handshake': true,
  '/teach': true,
  '/say': true,
  '/crawler-enqueue': true,
  '/reset': true,
  '/order': true,
  '/order/close': true,
  '/notify-aea': true,
  '/encode-syllable': true,
  '/log': true
};

var DELETE_ROUTES = {
  '/orders': true
};

function parseAllowedOrigins(env) {
  var raw = '';
  try {
    raw = (env && env.ALLOWED_ORIGIN) ? String(env.ALLOWED_ORIGIN) : '';
  } catch (e) {
    raw = '';
  }
  raw = raw.trim();
  if (!raw || raw === '*') {
    return { mode: 'star', list: [] };
  }
  var list = [];
  var parts = raw.split(',');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p) {
      list.push(p);
    }
  }
  if (!list.length) {
    return { mode: 'star', list: [] };
  }
  return { mode: 'list', list: list };
}

function corsHeaders(requestOrigin, env) {
  var parsed = parseAllowedOrigins(env);
  var headers = {};
  headers['Vary'] = 'Origin';
  headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Telegram-Init-Data, Authorization';
  headers['Access-Control-Max-Age'] = '86400';
  if (parsed.mode === 'star') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }
  var origin = requestOrigin || '';
  var matched = false;
  for (var i = 0; i < parsed.list.length; i++) {
    if (origin && origin === parsed.list[i]) {
      matched = true;
      break;
    }
  }
  if (matched) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    return headers;
  }
  // Unmatched origin: omit Allow-Origin entirely. Browser blocks the response.
  // Never fall back to list[0] and never reflect an arbitrary origin.
  return headers;
}

function jsonResponse(status, obj, requestOrigin, env, extraHeaders) {
  var headers = corsHeaders(requestOrigin, env);
  headers['Content-Type'] = 'application/json';
  headers['Cache-Control'] = 'no-store';
  headers['Pragma'] = 'no-cache';
  if (extraHeaders) {
    var keys = Object.keys(extraHeaders);
    for (var i = 0; i < keys.length; i++) {
      headers[keys[i]] = extraHeaders[keys[i]];
    }
  }
  var body = '';
  try {
    body = JSON.stringify(obj);
  } catch (e) {
    body = JSON.stringify({ ok: false, error: 'json_encode' });
  }
  return new Response(body, { status: status, headers: headers });
}

function waitingResponse(requestOrigin, env, reason) {
  return jsonResponse(502, {
    ok: false,
    status: 'waiting',
    reason: reason || 'Backend unreachable, WAITING, no synthetic bars'
  }, requestOrigin, env);
}

function syntheticRejectedResponse(requestOrigin, env) {
  return jsonResponse(502, {
    ok: false,
    status: 'waiting',
    reason: 'Backend returned synthetic payload, rejected by audit'
  }, requestOrigin, env);
}

function containsSynthetic(value, depth) {
  if (depth > 20) {
    return false;
  }
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      if (containsSynthetic(value[i], depth + 1)) {
        return true;
      }
    }
    return false;
  }
  if (typeof value === 'object') {
    if (value.synthetic === true) {
      return true;
    }
    if (value.lattice_points === 0) {
      return true;
    }
    if (value.lattice === 0) {
      return true;
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      if (containsSynthetic(value[keys[k]], depth + 1)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

function isSyntheticPayload(obj) {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  return containsSynthetic(obj, 0);
}

function normalizeBackend(env) {
  var backend = '';
  try {
    backend = (env && env.BACKEND_URL) ? String(env.BACKEND_URL).trim() : '';
  } catch (e) {
    backend = '';
  }
  while (backend.length > 0 && backend.charAt(backend.length - 1) === '/') {
    backend = backend.slice(0, backend.length - 1);
  }
  if (!backend) {
    return '';
  }
  if (!/^https?:\/\//i.test(backend)) {
    return '';
  }
  return backend;
}

function cleanUpstreamSearch(search) {
  var params = new URLSearchParams(search || '');
  params.delete('auth_init_data');
  params.delete('auth');
  params.delete('backend');
  var out = params.toString();
  return out ? ('?' + out) : '';
}

function normalizePathname(rawPath) {
  var path = rawPath || '/';
  if (path.length > 1) {
    while (path.length > 1 && path.charAt(path.length - 1) === '/') {
      path = path.slice(0, path.length - 1);
    }
  }
  return path;
}

async function proxyToBackend(request, env, pathname, search, method) {
  var requestOrigin = '';
  try {
    requestOrigin = request.headers.get('Origin') || '';
  } catch (e) {
    requestOrigin = '';
  }
  var backend = normalizeBackend(env);
  if (!backend) {
    return jsonResponse(502, {
      ok: false,
      error: 'BACKEND_URL not set',
      status: 'waiting'
    }, requestOrigin, env);
  }
  var target = backend + pathname + cleanUpstreamSearch(search);
  var upstreamHeaders = {};
  upstreamHeaders['User-Agent'] = WORKER_NAME;
  upstreamHeaders['Accept'] = 'application/json';
  try {
    var initData = request.headers.get('X-Telegram-Init-Data');
    if (initData) {
      upstreamHeaders['X-Telegram-Init-Data'] = initData;
    }
  } catch (e) {}
  try {
    var authHeader = request.headers.get('Authorization');
    if (authHeader) {
      upstreamHeaders['Authorization'] = authHeader;
    }
  } catch (e) {}
  try {
    var contentType = request.headers.get('Content-Type');
    if (contentType) {
      upstreamHeaders['Content-Type'] = contentType;
    }
  } catch (e) {}
  try {
    if (env && env.RELAY_KEY) {
      upstreamHeaders['X-Relay-Key'] = String(env.RELAY_KEY);
    }
  } catch (e) {}
  var body = undefined;
  if (method === 'POST' || method === 'DELETE') {
    try {
      body = await request.arrayBuffer();
      if (body && body.byteLength === 0) {
        body = undefined;
      }
    } catch (e) {
      body = undefined;
    }
  }
  var controller = null;
  var timeoutId = null;
  try {
    if (typeof AbortController !== 'undefined') {
      controller = new AbortController();
      timeoutId = setTimeout(function () {
        try { controller.abort(); } catch (e) {}
      }, UPSTREAM_TIMEOUT_MS);
    }
  } catch (e) {
    controller = null;
    timeoutId = null;
  }
  var upstream = null;
  try {
    var fetchOptions = {
      method: method,
      headers: upstreamHeaders
    };
    if (body !== undefined) {
      fetchOptions.body = body;
    }
    if (controller) {
      fetchOptions.signal = controller.signal;
    }
    upstream = await fetch(target, fetchOptions);
  } catch (e) {
    if (timeoutId) {
      try { clearTimeout(timeoutId); } catch (ignored) {}
    }
    return waitingResponse(requestOrigin, env, 'Backend unreachable, WAITING, no synthetic bars');
  }
  if (timeoutId) {
    try { clearTimeout(timeoutId); } catch (ignored) {}
  }
  var status = 502;
  var upstreamContentType = '';
  var text = '';
  try {
    status = upstream.status;
  } catch (e) {
    status = 502;
  }
  try {
    upstreamContentType = upstream.headers.get('Content-Type') || '';
  } catch (e) {
    upstreamContentType = '';
  }
  try {
    text = await upstream.text();
  } catch (e) {
    return waitingResponse(requestOrigin, env, 'Backend returned no readable body, WAITING, no synthetic bars');
  }
  var looksJson = false;
  try {
    if (upstreamContentType && upstreamContentType.indexOf('application/json') !== -1) {
      looksJson = true;
    } else {
      var trimmed = text.replace(/^\s+/, '');
      if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        looksJson = true;
      }
    }
  } catch (e) {
    looksJson = false;
  }
  if (looksJson && text) {
    var parsed = null;
    var parseOk = false;
    try {
      parsed = JSON.parse(text);
      parseOk = true;
    } catch (e) {
      parseOk = false;
    }
    if (parseOk && isSyntheticPayload(parsed)) {
      return syntheticRejectedResponse(requestOrigin, env);
    }
  }
  var outHeaders = corsHeaders(requestOrigin, env);
  outHeaders['Cache-Control'] = 'no-store';
  outHeaders['Pragma'] = 'no-cache';
  if (upstreamContentType) {
    outHeaders['Content-Type'] = upstreamContentType;
  } else {
    outHeaders['Content-Type'] = 'application/json';
  }
  return new Response(text, { status: status, headers: outHeaders });
}

export default {
  async fetch(request, env, ctx) {
    var url = null;
    try {
      url = new URL(request.url);
    } catch (e) {
      return jsonResponse(400, { ok: false, error: 'bad_request' }, '', env);
    }
    var requestOrigin = '';
    try {
      requestOrigin = request.headers.get('Origin') || '';
    } catch (e) {
      requestOrigin = '';
    }
    var method = (request.method || 'GET').toUpperCase();
    var pathname = normalizePathname(url.pathname);
    var search = url.search || '';
    if (method === 'OPTIONS') {
      var preflight = corsHeaders(requestOrigin, env);
      preflight['Content-Length'] = '0';
      preflight['Cache-Control'] = 'no-store';
      return new Response(null, { status: 204, headers: preflight });
    }
    if (method === 'HEAD') {
      if (pathname === '/health') {
        var headRes = await proxyToBackend(request, env, '/health', search, 'GET');
        var headHeaders = {};
        try {
          headRes.headers.forEach(function (value, key) {
            headHeaders[key] = value;
          });
        } catch (e) {}
        return new Response(null, { status: headRes.status, headers: headHeaders });
      }
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' }, requestOrigin, env, {
        'Allow': 'GET, POST, DELETE, OPTIONS'
      });
    }
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' }, requestOrigin, env, {
        'Allow': 'GET, POST, DELETE, OPTIONS'
      });
    }
    if (pathname === '/') {
      var rootHeaders = corsHeaders(requestOrigin, env);
      rootHeaders['Content-Type'] = 'text/plain; charset=utf-8';
      rootHeaders['Cache-Control'] = 'no-store';
      return new Response(
        'AE TWA Relay. Backend authoritative. Use /miniapp-state for single truth. No synthetic bars.',
        { status: 200, headers: rootHeaders }
      );
    }
    if (pathname === '/favicon.ico') {
      var favHeaders = corsHeaders(requestOrigin, env);
      favHeaders['Content-Length'] = '0';
      favHeaders['Cache-Control'] = 'no-store';
      return new Response(null, { status: 204, headers: favHeaders });
    }
    if (pathname === '/robots.txt') {
      var robotsHeaders = corsHeaders(requestOrigin, env);
      robotsHeaders['Content-Type'] = 'text/plain; charset=utf-8';
      robotsHeaders['Cache-Control'] = 'no-store';
      return new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: robotsHeaders });
    }
    if (method === 'GET' && GET_ROUTES[pathname]) {
      return proxyToBackend(request, env, pathname, search, 'GET');
    }
    if (method === 'POST' && POST_ROUTES[pathname]) {
      return proxyToBackend(request, env, pathname, search, 'POST');
    }
    if (method === 'DELETE' && (DELETE_ROUTES[pathname] || pathname.indexOf('/fvg/') === 0)) {
      return proxyToBackend(request, env, pathname, search, 'DELETE');
    }
    return jsonResponse(404, {
      ok: false,
      error: 'not_found',
      hint: 'Use /miniapp-state, single truth'
    }, requestOrigin, env);
  }
};

// ============================================================================
// AE TWA - WORKER.JS - RELAY (AEI + AEEA FUSED)
// Cloudflare Worker. Stateless relay plus minimal relay info page.
// One system. Backend authoritative. No synthetic bars ever.
//
// Fusion:
//   - AEI seed loop: prime -> outward lattice -> Hopf -> s2=r2 -> DbZ -> I
//     -> SelfEvolution. Frontend for AEI is the TWA entry page.
//   - AEEA market engine: bars -> 13 normalised indicators + Ichimoku ->
//     m/n/delta (max 14: 13 loop + 1 Ichimoku; thresholds 69.33/30.66) ->
//     regime -> BB family 3-60 -> P_arc -> signal iff H/L gate ->
//     orders/trailing/FVG.
//   - Fused on ONE ordered feed: each tick in arrival order advances the
//     AEEA bar ring AND is lifted to exact Fraction x for the AEI seed loop
//     via x lifted in backend from crawler hash primary, price fallback labelled, 1/100 when delta zero.
//   - This worker does NOT implement any of that. It only proxies the one
//     ordered state from the backend to the frontend. Backend authoritative.
//     Frontend never computes truth and never sends x. It only renders /miniapp-state.
//     x is lifted in the backend only: crawler-hash first (x_source='crawler-hash'), else price-fallback |Δprice|/10000 (x_source='price-fallback'), else 1/100 tick-fallback. Price-fallback x is never presented as FG x. Frontend never computes or sends x.
//
// Identity: AEEA TWA is FF itself. AEI TWA is FG itself. AE TWA is
//   the FF/FG fusion. FF takes precedence for market engine. FG takes
//   precedence for seed loop.
// Intelligence gate (FG, backend): I >= 2/3. Unity is I = 1.
//   Coherence gate is s = r, checked as s2 = r2. Worker never computes
//   I. It forwards backend state verbatim.
// Constraints in this file:
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
//     Worker forwards X-Telegram-Init-Data and Authorization headers
//     verbatim to the backend. Worker never validates, never logs, never
//     stores, never echoes, and never puts auth into a query string or a
//     response body. Worker strips auth_init_data, auth, backend, initData,
//     and init_data params from the upstream query string so auth can never
//     leak in a URL.
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
//   GET:    /?symbol=...&kind=... (FF price relay, upstream for backend poller only; frontend must use /miniapp-state), /?url=... (FG crawler relay, returns title, content_hash, links), /health, /miniapp-state, /cs-state, /cs-feedback, /ohlcv, /signals,
//           /diagnostics, /orders, /log, /toasts, /lattice-state, /seed-state,
//           /fibration-state, /symbolic-state, /observer-integral,
//           /evolution-state, /crawler-state, /aea-notification, /config,
//           /probe, /fvg, /state, /projection, /regime-map, /indicators,
//           /settings
//   POST:   /cs-feedback, /step, /handshake, /teach, /say,
//           /crawler-enqueue, /reset, /order, /order/close, /notify-aea,
//           /encode-syllable, /log, /fvg, /symbol, /projection/refresh
//   DELETE: /orders, /fvg/<id>
//   OPTIONS: CORS preflight for listed paths only. Unlisted path: 404. Any other method is 405.
//   GET /: generic relay text, no backend URL. GET /robots.txt: disallow.
//   GET /favicon.ico: 204, no body.
//
// Errors:
//   - Backend unreachable or timed out: 502, {ok:false, status:'waiting',
//     reason:'Backend unreachable, WAITING, no synthetic bars'}. Never 200
//     with fake data. Never a synthetic bar. Never a placeholder lattice.
//   - Backend returns synthetic payload: 502, {ok:false, status:'waiting',
//     reason:'Backend returned synthetic payload, rejected by Constraints'}.
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
// ============================================================================

var UPSTREAM_TIMEOUT_MS = 30000;
var WORKER_NAME = 'AE-TWA-Worker';

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
  '/log': true,
  '/fvg': true,
  '/symbol': true,
  '/projection/refresh': true
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
  headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept, X-Telegram-Init-Data, X-Relay-Key, X-Limit, X-Since';
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
    reason: 'Backend returned synthetic payload, rejected by Constraints'
  }, requestOrigin, env);
}

function containsSynthetic(value, depth) {
  // FIX (audit): only a synthetic flag of true, or a numeric zero
  // lattice_points / lattice, is synthetic. An empty array is WAITING,
  // never synthetic: LATTICE [] EQUALS WAITING, NEVER 0. placeholder:true
  // is not a synthetic flag. [] must pass through as a 200 WAITING body,
  // not become a 502.
  if (depth > 50) {
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
  if (typeof value === 'string') {
    return false;
  }
  if (typeof value === 'object') {
    if (value.synthetic === true || value.synthetic === 'true') {
      return true;
    }
    if (value.lattice_points === 0 || value.lattice_points === '0') {
      return true;
    }
    if (value.lattice === 0 || value.lattice === '0') {
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


// --- FF PRICE RELAY ---
// CRYPTO_MAP: canonical symbol -> {kraken pair, binance pair, coingecko id}
// Pruned live-triple set. CoinGecko-only entries serve usd_24h_vol under volume, not tick volume.
var CRYPTO_MAP = {
  "BTC-USD": {kraken: "XBTUSD", binance: "BTCUSDT", coingecko: "bitcoin"},
  "ETH-USD": {kraken: "ETHUSD", binance: "ETHUSDT", coingecko: "ethereum"},
  "XRP-USD": {kraken: "XRPUSD", binance: "XRPUSDT", coingecko: "ripple"},
  "ADA-USD": {kraken: "ADAUSD", binance: "ADAUSDT", coingecko: "cardano"},
  "SOL-USD": {kraken: "SOLUSD", binance: "SOLUSDT", coingecko: "solana"},
  "DOGE-USD": {kraken: "DOGEUSD", binance: "DOGEUSDT", coingecko: "dogecoin"},
  "LTC-USD": {kraken: "LTCUSD", binance: "LTCUSDT", coingecko: "litecoin"},
  "LINK-USD": {kraken: "LINKUSD", binance: "LINKUSDT", coingecko: "chainlink"},
  "DOT-USD": {kraken: "DOTUSD", binance: "DOTUSDT", coingecko: "polkadot"},
  "AVAX-USD": {kraken: "AVAXUSD", binance: "AVAXUSDT", coingecko: "avalanche-2"},
  "MATIC-USD": {kraken: "MATICUSD", binance: "MATICUSDT", coingecko: "matic-network"},
  "UNI-USD": {kraken: "UNIUSD", binance: "UNIUSDT", coingecko: "uniswap"},
  "ATOM-USD": {kraken: "ATOMUSD", binance: "ATOMUSDT", coingecko: "cosmos"},
  "NEAR-USD": {kraken: "NEARUSD", binance: "NEARUSDT", coingecko: "near"},
  "FIL-USD": {kraken: "FILUSD", binance: "FILUSDT", coingecko: "filecoin"},
  "ETC-USD": {kraken: "ETCUSD", binance: "ETCUSDT", coingecko: "ethereum-classic"},
  "ICP-USD": {kraken: "ICPUSD", binance: "ICPUSDT", coingecko: "internet-computer"},
  "XLM-USD": {kraken: "XLMUSD", binance: "XLMUSDT", coingecko: "stellar"},
  "HBAR-USD": {kraken: "HBARUSD", binance: "HBARUSDT", coingecko: "hedera-hashgraph"},
  "ARB-USD": {kraken: "ARBUSDT", binance: "ARBUSDT", coingecko: "arbitrum"},
  "OP-USD": {kraken: "OPUSDT", binance: "OPUSDT", coingecko: "optimism"},
  "SUI-USD": {kraken: "SUIUSDT", binance: "SUIUSDT", coingecko: "sui"},
  "APT-USD": {kraken: "APTUSDT", binance: "APTUSDT", coingecko: "aptos"},
  "PEPE-USD": {kraken: "PEPEUSDT", binance: "PEPEUSDT", coingecko: "pepe"},
  "SHIB-USD": {kraken: "SHIBUSDT", binance: "SHIBUSDT", coingecko: "shiba-inu"},
  "BCH-USD": {kraken: "BCHUSD", binance: "BCHUSDT", coingecko: "bitcoin-cash"},
  "TRX-USD": {kraken: "TRXUSD", binance: "TRXUSDT", coingecko: "tron"},
  "NEO-USD": {kraken: "NEOUSD", binance: "NEOUSDT", coingecko: "neo"},
  "EOS-USD": {kraken: "EOSUSD", binance: "EOSUSDT", coingecko: "eos"},
  "AAVE-USD": {kraken: "AAVEUSD", binance: "AAVEUSDT", coingecko: "aave"},
  "MKR-USD": {kraken: "MKRUSD", binance: "MKRUSDT", coingecko: "maker"},
  "COMP-USD": {kraken: "COMPUSD", binance: "COMPUSDT", coingecko: "compound-governance-token"},
  "CRV-USD": {kraken: "CRVUSD", binance: "CRVUSDT", coingecko: "curve-dao-token"},
  "SNX-USD": {kraken: "SNXUSD", binance: "SNXUSDT", coingecko: "synthetix-network-token"},
  "SUSHI-USD": {kraken: "SUSHIUSD", binance: "SUSHIUSDT", coingecko: "sushi"},
  "YFI-USD": {kraken: "YFIUSD", binance: "YFIUSDT", coingecko: "yearn-finance"},
  "WIF-USD": {kraken: "WIFUSDT", binance: "WIFUSDT", coingecko: "dogwifcoin"},
  "BONK-USD": {kraken: "BONKUSDT", binance: "BONKUSDT", coingecko: "bonk"},
  "FLOKI-USD": {kraken: "FLOKIUSDT", binance: "FLOKIUSDT", coingecko: "floki"},
  "TAO-USD": {kraken: "TAOUSDT", binance: "TAOUSDT", coingecko: "bittensor"},
  "JUP-USD": {kraken: "JUPUSDT", binance: "JUPUSDT", coingecko: "jupiter-exchange-solana"},
  "PYTH-USD": {kraken: "PYTHUSDT", binance: "PYTHUSDT", coingecko: "pyth-network"},
  "FET-USD": {kraken: "FETUSDT", binance: "FETUSDT", coingecko: "fetch-ai"},
  "GRT-USD": {kraken: "GRTUSD", binance: "GRTUSDT", coingecko: "the-graph"},
  "LDO-USD": {kraken: "LDOUSDT", binance: "LDOUSDT", coingecko: "lido-dao"},
  "RNDR-USD": {kraken: "RNDRUSDT", binance: "RNDRUSDT", coingecko: "render-token"},
  "WLD-USD": {kraken: "WLDUSDT", binance: "WLDUSDT", coingecko: "worldcoin-wld"},
  "USDT-USD": {kraken: "USDTUSD", binance: "USDTUSDT", coingecko: "tether"},
  "USDC-USD": {kraken: "USDCUSD", binance: "USDCUSDT", coingecko: "usd-coin"},
  "DAI-USD": {kraken: "DAIUSD", binance: "DAIUSDT", coingecko: "dai"},
  "BNB-USD": {kraken: null, binance: null, coingecko: "binancecoin"},
  "OKB-USD": {kraken: null, binance: null, coingecko: "okb"},
  "HT-USD": {kraken: null, binance: null, coingecko: "huobi-token"},
  "KCS-USD": {kraken: null, binance: null, coingecko: "kucoin-shares"}
};
var EQUITIES_MAP = {
  "AAPL": "aapl.us", "MSFT": "msft.us", "GOOGL": "googl.us", "AMZN": "amzn.us", "META": "meta.us",
  "NVDA": "nvda.us", "TSLA": "tsla.us", "BRK-B": "brk-b.us", "BRK-A": "brk-a.us",
  "JPM": "jpm.us", "V": "v.us", "JNJ": "jnj.us", "WMT": "wmt.us", "MA": "ma.us"
};
async function fetchKraken(pair){
  var r = await fetch("https://api.kraken.com/0/public/Ticker?pair=" + encodeURIComponent(pair), {headers: {"Accept": "application/json"}});
  if(!r.ok) throw new Error("kraken http " + r.status);
  var j = await r.json();
  if(j.error && j.error.length) throw new Error("kraken " + j.error.join(","));
  var keys = Object.keys(j.result || {});
  if(!keys.length) throw new Error("kraken empty result");
  var t = j.result[keys[0]];
  var bid = parseFloat((t.b && t.b[0]) || t.c[0]);
  var ask = parseFloat((t.a && t.a[0]) || t.c[0]);
  var last = parseFloat(t.c[0]);
  var vol = parseFloat((t.v && t.v[1]) || (t.v && t.v[0]) || 0);
  return {price: last, bid: bid, ask: ask, volume: vol, provider: "Kraken"};
}
async function fetchBinance(pair){
  var r = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=" + encodeURIComponent(pair), {headers: {"Accept": "application/json"}});
  if(!r.ok) throw new Error("binance http " + r.status);
  var j = await r.json();
  return {price: parseFloat(j.lastPrice), bid: parseFloat(j.bidPrice), ask: parseFloat(j.askPrice), volume: parseFloat(j.volume || 0), provider: "Binance"};
}
async function fetchCoinGecko(id){
  var r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(id) + "&vs_currencies=usd&include_24hr_vol=true", {headers: {"Accept": "application/json"}});
  if(!r.ok) throw new Error("coingecko http " + r.status);
  var j = await r.json();
  var e = j[id]; if(!e || e.usd === undefined) throw new Error("coingecko no usd");
  // CoinGecko-only entries: no tick, volume is usd_24h_vol. Labelled as such.
  return {price: parseFloat(e.usd), bid: parseFloat(e.usd), ask: parseFloat(e.usd), volume: parseFloat(e.usd_24h_vol || 0), provider: "CoinGecko", volume_note: "usd_24h_vol, not tick volume"};
}
async function fetchYahoo(symbol){
  var y = symbol.replace("-USD", "USD=X").replace("/", "");
  // For non-crypto Yahoo symbols, use the symbol as-is if it already looks like a Yahoo ticker.
  if(symbol.indexOf("=F") !== -1 || symbol.indexOf("^") === 0 || /^[A-Z]+$/.test(symbol)) y = symbol;
  var r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(y), {headers: {"Accept": "application/json"}});
  if(!r.ok) throw new Error("yahoo http " + r.status);
  var j = await r.json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  var meta = res && res.meta;
  if(!meta || meta.regularMarketPrice === undefined) throw new Error("yahoo no price");
  return {price: parseFloat(meta.regularMarketPrice), bid: parseFloat(meta.regularMarketPrice), ask: parseFloat(meta.regularMarketPrice), volume: parseFloat(meta.regularMarketVolume || 0), provider: "Yahoo"};
}
async function fetchStooq(symbol){
  var s = EQUITIES_MAP[symbol] || (symbol.toLowerCase().replace("-", ".") + ".us");
  var r = await fetch("https://stooq.com/q/l/?s=" + encodeURIComponent(s) + "&f=sd2t2ohlcv&h&e=json", {headers: {"Accept": "application/json"}});
  if(!r.ok) throw new Error("stooq http " + r.status);
  var j = await r.json();
  var row = j.symbols && j.symbols[0];
  if(!row || row.close === undefined || row.close === "N/D") throw new Error("stooq no close");
  return {price: parseFloat(row.close), bid: parseFloat(row.close), ask: parseFloat(row.close), volume: parseFloat(row.volume || 0), provider: "Stooq"};
}
var CRAWLER_BLOCKLIST = ["meta.wikimedia.org", "wikimedia.org/w/api", "thumb.wikimedia.org", "upload.wikimedia.org", "featuredfeed"];
var CRAWLER_MAX_HTML_BYTES = 524288;
var CRAWLER_MAX_LINKS = 64;
var CRAWLER_TIMEOUT_MS = 10000;
async function handleCrawlerRelay(url, env){
  var target = url.searchParams.get("url") || "";
  if(!target) return new Response(JSON.stringify({ok: false, url: target, error: "missing_url", status: 400}), {status: 400, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  if(!/^https?:\/\//i.test(target)) return new Response(JSON.stringify({ok: false, url: target, error: "invalid_url", status: 400}), {status: 400, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  for(var i=0;i<CRAWLER_BLOCKLIST.length;i++){ if(target.indexOf(CRAWLER_BLOCKLIST[i])!==-1) return new Response(JSON.stringify({ok: false, url: target, error: "url_blocklisted", status: 403}), {status: 403, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}}); }
  var start = Date.now();
  var controller = new AbortController();
  var timer = setTimeout(function(){ try{ controller.abort(); }catch(e){} }, CRAWLER_TIMEOUT_MS);
  try{
    var r = await fetch(target, {headers: {"User-Agent": "Mozilla/5.0 (compatible; AEI-Crawler/1.0)", "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9"}, redirect: "follow", signal: controller.signal});
    clearTimeout(timer);
    var ctype = (r.headers.get("Content-Type") || "").toLowerCase();
    var isHtml = (ctype.indexOf("html")!==-1 || ctype.indexOf("xml")!==-1 || ctype.indexOf("text")!==-1);
    var buf = await r.arrayBuffer();
    var sliced = buf.slice(0, CRAWLER_MAX_HTML_BYTES);
    var text = "";
    try{ text = new TextDecoder("utf-8").decode(sliced); }catch(e){ text = ""; }
    var title = "";
    if(isHtml){
      var tm = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if(tm && tm[1]) title = tm[1].replace(/<[^>]+>/g, "").trim().slice(0,200);
      if(!title){
        var hm = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if(hm && hm[1]) title = hm[1].replace(/<[^>]+>/g, "").trim().slice(0,200);
      }
      if(!title){
        var lines = text.replace(/<[^>]+>/g, " ").split(/\n/);
        for(var li=0; li<lines.length; li++){ var l = lines[li].trim(); if(l){ title = l.slice(0,200); break; } }
      }
      if(!title) title = target;
    } else {
      title = "";
    }
    var links = [];
    if(isHtml){
      var re = /href\s*=\s*["']([^"']+)["']/gi;
      var lm;
      while((lm = re.exec(text)) !== null && links.length < CRAWLER_MAX_LINKS){
        var href = lm[1];
        try{
          var abs = new URL(href, target).toString();
          if(abs.indexOf("http")===0 && links.indexOf(abs)===-1) links.push(abs);
        }catch(e){}
      }
    }
    var hashHex = "";
    try{
      var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      var bytes = new Uint8Array(digest);
      for(var bi=0; bi<bytes.length; bi++){ var h = bytes[bi].toString(16); if(h.length===1) h = "0"+h; hashHex += h; }
    }catch(e){ hashHex = ""; }
    var body = {ok: true, url: target, title: title, content_hash: hashHex, links: links, text_length: text.length, provider: "crawler-relay", status: r.status, content_type: ctype, elapsed_ms: Date.now()-start};
    return new Response(JSON.stringify(body), {status: 200, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  }catch(e){
    clearTimeout(timer);
    var err = (e && e.name==="AbortError") ? "fetch_timeout" : "fetch_error";
    return new Response(JSON.stringify({ok: false, url: target, error: err, detail: String((e && e.message) || e), status: 502}), {status: 502, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  }
}

async function handlePriceRelay(url, env){
  var symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  var kind = url.searchParams.get("kind") || "ticker";
  if(!symbol) return new Response(JSON.stringify({ok: false, error: "missing_symbol"}), {status: 400, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  var errors = [];
  // Crypto path: Kraken -> Binance -> CoinGecko -> Yahoo
  if(CRYPTO_MAP[symbol]){
    var m = CRYPTO_MAP[symbol];
    if(m.kraken){ try{ var k = await fetchKraken(m.kraken); return priceOk(symbol, kind, k); }catch(e){ errors.push("kraken:" + e.message); } }
    if(m.binance){ try{ var b = await fetchBinance(m.binance); return priceOk(symbol, kind, b); }catch(e){ errors.push("binance:" + e.message); } }
    if(m.coingecko){ try{ var g = await fetchCoinGecko(m.coingecko); return priceOk(symbol, kind, g); }catch(e){ errors.push("coingecko:" + e.message); } }
    try{ var y = await fetchYahoo(symbol); return priceOk(symbol, kind, y); }catch(e){ errors.push("yahoo:" + e.message); }
    return new Response(JSON.stringify({ok: false, error: "no_price_for_symbol", symbol: symbol, detail: errors.join(" | ")}), {status: 502, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
  }
  // Forex / indices: Yahoo first, then Stooq. Equities / futures: Stooq first, then Yahoo.
  var yahooFirst = (symbol.indexOf("=X") !== -1) || (symbol.charAt(0) === "^");
  if (yahooFirst) {
    try{ var yf = await fetchYahoo(symbol); return priceOk(symbol, kind, yf); }catch(e){ errors.push("yahoo:" + e.message); }
    try{ var sf = await fetchStooq(symbol); return priceOk(symbol, kind, sf); }catch(e){ errors.push("stooq:" + e.message); }
  } else {
    try{ var s = await fetchStooq(symbol); return priceOk(symbol, kind, s); }catch(e){ errors.push("stooq:" + e.message); }
    try{ var y2 = await fetchYahoo(symbol); return priceOk(symbol, kind, y2); }catch(e){ errors.push("yahoo:" + e.message); }
  }
  return new Response(JSON.stringify({ok: false, error: "no_price_for_symbol", symbol: symbol, detail: errors.join(" | ")}), {status: 502, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
}
function priceOk(symbol, kind, p){
  var body = {ok: true, symbol: symbol, kind: kind, price: p.price, bid: p.bid, ask: p.ask, volume: p.volume, provider: p.provider, note: "Upstream for backend poller only. Frontend must use /miniapp-state, never this direct price."};
  if(p.volume_note) body.volume_note = p.volume_note;
  if(kind === "ohlcv"){
    // Price relay does not synthesise OHLCV bars. OHLCV comes from backend /ohlcv.
    body.note = "ticker only; OHLCV bars come from backend /ohlcv, never synthesised here";
  }
  return new Response(JSON.stringify(body), {status: 200, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
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
  params.delete('initData');
  params.delete('init_data');
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
  // FIX (audit): auth is X-Telegram-Init-Data only. Authorization is
  // never forwarded to the backend.
  // X-Telegram-Init-Data is forwarded for auth.
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

function isListedPath(pathname) {
  // FIX: single allowlist predicate shared by OPTIONS and the method router.
  // DELETE /fvg/<id> is listed via its /fvg/ prefix, matching the DELETE
  // router below. Root, favicon and robots are listed as special cases.
  if (pathname === '/' || pathname === '/favicon.ico' || pathname === '/robots.txt') {
    return true;
  }
  if (GET_ROUTES[pathname] || POST_ROUTES[pathname] || DELETE_ROUTES[pathname]) {
    return true;
  }
  if (pathname.indexOf('/fvg/') === 0) {
    return true;
  }
  return false;
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
      // FIX: preflight only for listed paths. Was 204 for any path,
      // including unlisted ones, so a browser preflight succeeded for a
      // route the worker would then 404. Unlisted preflight is 404 now.
      if (!isListedPath(pathname)) {
        return jsonResponse(404, {
          ok: false,
          error: 'not_found',
          hint: 'Use /miniapp-state, single truth'
        }, requestOrigin, env);
      }
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
    // FG crawler relay: backend calls RELAY_URL/?url=...
    // If root path carries ?url=, treat as crawler relay. RELAY_KEY gating via X-Relay-Key header when env RELAY_KEY is set.
    if (pathname === '/' && url.searchParams.has('url')) {
      try {
        if (env && env.RELAY_KEY) {
          var ck = request.headers.get('X-Relay-Key') || '';
          if (ck !== env.RELAY_KEY) {
            return jsonResponse(401, { ok: false, error: 'relay_key_required' }, requestOrigin, env);
          }
        }
        var _crawl = await handleCrawlerRelay(url, env);
        try {
          var _ch2 = corsHeaders(requestOrigin, env);
          Object.keys(_ch2).forEach(function(k){ _crawl.headers.set(k, _ch2[k]); });
        } catch (e) {}
        return _crawl;
      } catch (e) {
        return jsonResponse(502, { ok: false, error: 'crawler_relay_failed', detail: String(e && e.message || e) }, requestOrigin, env);
      }
    }
    // Price relay: backend calls RELAY_URL/?symbol=...&kind=...
    // If root path carries ?symbol=, treat as price relay, not as generic root text.
    if (pathname === '/' && url.searchParams.has('symbol')) {
      try {
        if (env && env.RELAY_KEY) {
          var pk = request.headers.get('X-Relay-Key') || '';
          if (pk !== env.RELAY_KEY) {
            return jsonResponse(401, { ok: false, error: 'relay_key_required' }, requestOrigin, env);
          }
        }
        var _relay = await handlePriceRelay(url, env);
        // Add CORS headers from corsHeaders
        try {
          var _ch = corsHeaders(requestOrigin, env);
          Object.keys(_ch).forEach(function(k){ _relay.headers.set(k, _ch[k]); });
        } catch (e) {}
        return _relay;
      } catch (e) {
        return jsonResponse(502, { ok: false, error: 'price_relay_failed', detail: String(e && e.message || e) }, requestOrigin, env);
      }
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

// ============================================================================
// ÆI SEED — GENERIC CRAWLER RELAY
// worker.js
// ============================================================================
// ÆI Seed — Generic Crawler Relay — worker.js
// Version: Final
// Edition: First
//
// This is the ÆI seed's generic crawler relay. It is a STATELESS fetch
// proxy: given a URL, it fetches the page, extracts the <title>, the
// content hash, and the outbound links, and returns the result as JSON.
//
// It does NOT dispatch to Kraken, Stooq, Binance, CoinGecko, or Yahoo.
// It does NOT hold the crawl frontier. It does NOT classify symbols.
// All crawl logic (frontier, visited set, depth limits, hash lifting to
// exact Fraction, symbolic-input injection into AEI_Seed.step) lives
// in app.py.
//
// The relay's job is exactly one thing: given a URL, perform the network
// I/O that a Cloudflare Worker is good at (fast egress from many
// geographies, no Heroku dyno IP rate-limiting) and return the payload.
//
// CONTRACT
// --------
//   GET  /?url=<https-url>
//        →  { ok:true, url, title, content_hash, links:[...], text_length,
//             fetched_at, provider:"crawler-relay", status:200 }
//        →  { ok:false, error, url, status }  on failure
//
//   GET  /health
//        →  { ok:true, service:"aei-crawler-relay", version: "Final", edition: "First",
//             gated:<bool>, endpoints:[...] }
//
//   OPTIONS *
//        →  204 with CORS headers
//
// Optional X-Relay-Key gate (matching RELAY_KEY on the Heroku side):
//   If env.RELAY_KEY is set via `wrangler secret put RELAY_KEY`, every
//   non-/health request must carry `X-Relay-Key: <value>`. Mismatch → 401.
//
// Determinism and exactness
// -------------------------
// The relay returns a SHA-256 hex hash of the page's plain text. On the
// Heroku side, CrawlerRelayClient lifts that hash to an exact PyFraction
// via _hash_to_fraction(), so the seed loop never receives a float.
// The relay itself is float-free for state: it only computes hashes and
// extracts strings.
//
// Deploy
// ------
//   wrangler secret put RELAY_KEY   # optional, but recommended
//   wrangler deploy
// ============================================================================

const UA_CRAWLER = "AEI-Seed/1.0 (+https://peachmuffin421-cyber.github.io/aeindex/; contact nataliatanyatia@gmail.com) Mozilla/5.0 (compatible; AEI-Seed-Crawler/1.0)";
const FETCH_TIMEOUT_MS = 30000;
const MAX_HTML_BYTES = 768 * 1024;
const MAX_LINKS = 64;
const ALLOWED_PROTOCOLS = ["http:", "https:"];
const BLOCKED_HOST_SUBSTRINGS = [
    "127.0.0.1",
    "localhost",
    "169.254.",
    "metadata.google.internal",
    "::1",
    "0.0.0.0"
];
const BLOCKED_PRIVATE_PREFIXES = ["10.", "192.168.", "172."];

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, X-Relay-Key",
        "Access-Control-Max-Age": "86400",
    };
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...corsHeaders(),
        },
    });
}

function isPrivateIp(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();
    for (const sub of BLOCKED_HOST_SUBSTRINGS) {
        if (h.includes(sub)) return true;
    }
    for (const pref of BLOCKED_PRIVATE_PREFIXES) {
        if (h.startsWith(pref)) return true;
    }
    if (h.startsWith("172.")) {
        const second = parseInt(h.split(".")[1] || "0", 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

function isValidHttpUrl(u) {
    try {
        const parsed = new URL(u);
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return false;
        if (isPrivateIp(parsed.hostname)) return false;
        return true;
    } catch (e) {
        return false;
    }
}

async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
}

function htmlToText(html) {
    if (!html) return "";
    let s = html;
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<[^>]+>/g, " ");
    s = decodeEntities(s);
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

function extractTitle(html, fallbackUrl, precomputedText) {
    if (!html) return fallbackUrl;
    let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1]) {
        let inner = m[1].replace(/<[^>]+>/g, " ");
        inner = decodeEntities(inner);
        const t = inner.replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 200);
    }
    m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m && m[1]) {
        let inner = m[1].replace(/<[^>]+>/g, " ");
        inner = decodeEntities(inner);
        const t = inner.replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 200);
    }
    const text = precomputedText || htmlToText(html);
    for (const line of text.split(/\n+/)) {
        const t = line.trim();
        if (t.length >= 3) return t.slice(0, 200);
    }
    return fallbackUrl;
}

function decodeEntities(s) {
    if (!s) return "";
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&hellip;/g, "…")
        .replace(/&copy;/g, "©")
        .replace(/&#(\d+);/g, (_, n) => {
            try { return String.fromCharCode(parseInt(n, 10)); } catch { return ""; }
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
            try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; }
        });
}

function extractLinks(html, baseUrl) {
    if (!html) return [];
    const links = [];
    const seen = new Set();
    const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(html)) !== null && links.length < MAX_LINKS) {
        const href = (m[1] || m[2] || m[3] || "").trim();
        if (!href) continue;
        if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
        try {
            const abs = new URL(href, baseUrl).toString();
            if (!isValidHttpUrl(abs)) continue;
            if (seen.has(abs)) continue;
            seen.add(abs);
            links.push(abs);
        } catch (e) {}
    }
    return links;
}

async function readBoundedBody(resp) {
    const reader = resp.body ? resp.body.getReader() : null;
    if (!reader) {
        const text = await resp.text();
        return text.slice(0, MAX_HTML_BYTES);
    }
    let received = 0;
    const chunks = [];
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (received > MAX_HTML_BYTES) {
                const remaining = MAX_HTML_BYTES - (received - value.length);
                if (remaining > 0) chunks.push(decoder.decode(value.slice(0, remaining), { stream: true }));
                break;
            }
            chunks.push(decoder.decode(value, { stream: true }));
        }
    } finally {
        try { reader.releaseLock(); } catch {}
    }
    chunks.push(decoder.decode());
    return chunks.join("");
}

async function fetchOne(url) {
    const startedAt = Date.now();
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const resp = await fetch(url, {
                method: "GET",
                headers: { "User-Agent": UA_CRAWLER, "Accept": "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8" },
                signal: controller.signal,
                redirect: "follow",
            });
            clearTimeout(timeout);
            if (resp.status === 429) {
                const retryAfter = parseInt(resp.headers.get("retry-after") || "2", 10) * 1000;
                await new Promise(r => setTimeout(r, Math.min(retryAfter, 5000) + 400));
                continue;
            }
            const status = resp.status;
            if (!resp.ok) {
                return {
                    ok: false,
                    url,
                    error: "http_" + status,
                    status,
                    elapsed_ms: Date.now() - startedAt,
                };
            }
            const contentType = (resp.headers.get("content-type") || "").toLowerCase();
            if (contentType && !contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text")) {
                return {
                    ok: true,
                    url,
                    title: url,
                    content_hash: "00000000000000000000000000000001",
                    links: [],
                    text_length: 0,
                    fetched_at: new Date().toISOString(),
                    provider: "crawler-relay",
                    status,
                    content_type: contentType,
                    elapsed_ms: Date.now() - startedAt,
                };
            }
            const html = await readBoundedBody(resp);
            const textContent = htmlToText(html);
            const title = extractTitle(html, url, textContent);
            const content_hash = textContent ? await sha256Hex(textContent) : "00000000000000000000000000000001";
            const links = extractLinks(html, url);
            const result = {
                ok: true,
                url,
                title,
                content_hash,
                links,
                text_length: textContent.length,
                fetched_at: new Date().toISOString(),
                provider: "crawler-relay",
                status,
                content_type: contentType,
                elapsed_ms: Date.now() - startedAt,
                attempts: attempt + 1,
            };
            try {
                const cache = caches.default;
                const cacheKey = new Request("https://aei-relay-cache/" + encodeURIComponent(url), { method: "GET" });
                const cacheResp = new Response(JSON.stringify(result), {
                    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
                });
                await cache.put(cacheKey, cacheResp);
            } catch (e) {}
            return result;
        } catch (e) {
            clearTimeout(timeout);
            const elapsed = Date.now() - startedAt;
            const msg = String(e && e.message ? e.message : e);
            const isTimeout = (e && (e.name === "AbortError" || /timeout/i.test(msg)));
            const isRetryable = /UNEXPECTED_EOF|EOF|525|502|reset|ECONNRESET/i.test(msg) || isTimeout;
            lastErr = e;
            if (isRetryable && attempt < 2) {
                const backoff = 500 * (attempt + 1) + Math.random() * 400;
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            return {
                ok: false,
                url,
                error: isTimeout ? "fetch_timeout" : "fetch_error",
                detail: msg,
                elapsed_ms: elapsed,
                status: 0,
                attempts: attempt + 1,
            };
        }
    }
    return {
        ok: false,
        url,
        error: "fetch_error_after_retry",
        detail: String(lastErr),
        elapsed_ms: Date.now() - startedAt,
        status: 0,
    };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(),
            });
        }

        if (url.pathname === "/health") {
            return jsonResponse({
                ok: true,
                service: "aei-crawler-relay",
                version: "Final", edition: "First",
                gated: Boolean(env.RELAY_KEY),
                endpoints: [
                    "GET /?url=<https-url>",
                    "GET /health",
                ],
                max_html_bytes: MAX_HTML_BYTES,
                max_links: MAX_LINKS,
                fetch_timeout_ms: FETCH_TIMEOUT_MS,
                user_agent: UA_CRAWLER,
            });
        }

        if (env.RELAY_KEY) {
            const presented = request.headers.get("X-Relay-Key") || "";
            if (presented !== env.RELAY_KEY) {
                return jsonResponse({
                    ok: false,
                    error: "unauthorized",
                    detail: "X-Relay-Key missing or does not match RELAY_KEY",
                }, 401);
            }
        }

        if (request.method !== "GET") {
            return jsonResponse({
                ok: false,
                error: "method_not_allowed",
                detail: "Only GET and OPTIONS are supported",
            }, 405);
        }

        const target = url.searchParams.get("url") || "";
        if (!target) {
            return jsonResponse({
                ok: false,
                error: "missing_url",
                detail: "Usage: GET /?url=<https-url>",
            }, 400);
        }

        if (!isValidHttpUrl(target)) {
            return jsonResponse({
                ok: false,
                error: "invalid_url",
                detail: "URL must be a well-formed http:// or https:// URL",
                url: target,
            }, 400);
        }

        try {
            const result = await fetchOne(target);
            const status = result.ok ? 200 : (result.status >= 400 ? 502 : 500);
            return jsonResponse(result, status);
        } catch (e) {
            return jsonResponse({
                ok: false,
                url: target,
                error: "internal_error",
                detail: String(e && e.message ? e.message : e),
                status: 500,
            }, 500);
        }
    },
};

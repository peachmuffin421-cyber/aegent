// ============================================================================
// ÆI SEED — GENERIC CRAWLER RELAY
// worker.js
// ============================================================================
// Version: vFinal Ed8 (Audit-Patched - Relay-hardened + No-Keepalive + Wikimedia-block + R12-fix)
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
//        →  { ok:true, service:"aei-crawler-relay", version:"final",
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
const MAX_LINKS = 64;                // return at most 64 outbound links
const ALLOWED_PROTOCOLS = ["http:", "https:"];

// ============================================================================
// HELPERS
// ============================================================================
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

function isValidHttpUrl(u) {
    try {
        const parsed = new URL(u);
        return ALLOWED_PROTOCOLS.includes(parsed.protocol);
    } catch (e) {
        return false;
    }
}

// SHA-256 of a string, returned as a lowercase hex string.
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

// Strip HTML tags, script/style blocks, and collapse whitespace. This is
// what we hash. No external parser; regex-based, adequate for a content
// hash and a text-length figure (not for rendering).
function htmlToText(html) {
    if (!html) return "";
    let s = html;
    // Remove script and style blocks entirely
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    // Remove HTML comments
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    // Replace tags with spaces
    s = s.replace(/<[^>]+>/g, " ");
    // Decode entities
    s = decodeEntities(s);
    // Collapse whitespace
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

// Extract <title>…</title>. Falls back to the first <h1>…</h1>,
// then to the first non-empty line of text, then to the URL. The
// extracted title is strictly the first <title> block's inner text,
// entity-decoded, whitespace-collapsed, and truncated to 200 chars.
// Residual tag fragments (from malformed HTML) are stripped before
// returning.
function extractTitle(html, fallbackUrl, precomputedText) {
    if (!html) return fallbackUrl;
    let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1]) {
        // strip any residual tag fragments before entity-decode.
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
    // First non-empty line of plain text
    const text = precomputedText || htmlToText(html);
    for (const line of text.split(/\n+/)) {
        const t = line.trim();
        if (t.length >= 3) return t.slice(0, 200);
    }
    return fallbackUrl;
}

// Minimal entity decoder for the entities that show up in titles and
// prose. Non-exhaustive, but adequate: &amp; &lt; &gt; &quot; &#39; &nbsp;
// &mdash; &ndash; &hellip; &copy; &#NNN; &#xHH;
function decodeEntities(s) {
    if (!s) return "";
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&hellip;/g, "…")
        .replace(/&copy;/g, "©")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : "";
        })
        .replace(/&#([0-9]+);/g, (_, dec) => {
            const code = parseInt(dec, 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : "";
        });
}

// Extract outbound links from href, src, and action attributes.
// Deduplicated, limited to MAX_LINKS, resolved against the base URL.
// Skips javascript:, mailto:, tel:, data:, blob:, and same-page fragments.
// Strips <script> and <style> blocks before extracting links, so
// string literals in JS/CSS cannot pollute the link list.
function extractLinks(html, baseUrl) {
    if (!html) return [];
    // pre-strip script/style blocks
    let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    const links = [];
    const seen = new Set();
    // Regex to capture href, src, or action attributes.
    const re = /<[^>]+\b(href|src|action)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    let m;
    while ((m = re.exec(cleaned)) !== null && links.length < MAX_LINKS) {
        let raw = m[3] || m[4] || m[5] || "";
        if (!raw) continue;
        raw = raw.trim();
        if (!raw) continue;
        const lower = raw.toLowerCase();
        if (lower.startsWith("javascript:") ||
            lower.startsWith("mailto:") ||
            lower.startsWith("tel:") ||
            lower.startsWith("data:") ||
            lower.startsWith("blob:") ||
            lower.startsWith("#")) {
            continue;
        }
        let resolved;
        try {
            resolved = new URL(raw, baseUrl).toString();
        } catch (e) {
            continue;
        }
        if (!isValidHttpUrl(resolved)) continue;
        // Strip trailing #fragment for dedupe purposes
        const stripped = resolved.split("#")[0];
        if (seen.has(stripped)) continue;
        seen.add(stripped);
        links.push(stripped);
    }
    return links;
}

// Read at most MAX_HTML_BYTES from the response body, decode as UTF-8.
async function readBoundedBody(response) {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total >= MAX_HTML_BYTES) {
                chunks.push(value.slice(0, value.byteLength - (total - MAX_HTML_BYTES)));
                break;
            }
            chunks.push(value);
        }
    } catch (e) {
        // Partial read on network error; use what we have.
    } finally {
        try { reader.releaseLock(); } catch (e) {}
    }
    const combined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) {
        combined.set(c, off);
        off += c.byteLength;
    }
    try {
        return new TextDecoder("utf-8", { fatal: false }).decode(combined);
    } catch (e) {
        return "";
    }
}

// ============================================================================
// FETCH ONE URL
// ============================================================================
async function fetchOne(url) {
    const startedAt = Date.now();
    let lastErr = null;
    // internal retry loop for transient CF/Wikipedia RSTs
    for (let attempt = 0; attempt < 3; attempt++) {
        let resp;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            resp = await fetch(url, {
                method: "GET",
                redirect: "follow",
                headers: {
                    "User-Agent": UA_CRAWLER,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Cache-Control": "no-cache, no-store",
                    "Pragma": "no-cache",
                    "Connection": "close",
                },
                cf: {
                    cacheTtl: 0,
                    cacheEverything: false,
                    scrapeShield: false,
                    mirage: false,
                    polish: "off",
                },
                signal: controller.signal,
            });
            clearTimeout(timer);
            // handle retryable status
            if (resp.status === 429 || resp.status === 502 || resp.status === 503 || resp.status === 525 || resp.status === 520) {
                lastErr = `http_${resp.status}_retryable`;
                const backoff = 400 * (attempt + 1) + Math.random() * 300;
                await new Promise(r => setTimeout(r, backoff));
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
                    content_hash: "",
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
            const content_hash = textContent ? await sha256Hex(textContent) : "";
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
                const cacheKey = new Request(url, { method: "GET" });
                const cacheResp = new Response(JSON.stringify(result), {
                    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
                });
                await cache.put(cacheKey, cacheResp);
            } catch (e) {}
            return result;
        } catch (e) {
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


// ============================================================================
// ENTRY POINT
// ============================================================================
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(),
            });
        }

        // Health — no auth
        if (url.pathname === "/health") {
            return jsonResponse({
                ok: true,
                service: "aei-crawler-relay",
                version: "final-ed8-r12-fixed-no-keepalive-blocklist",
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

        // Optional shared-secret gate
        if (env.RELAY_KEY) {
            const presented = request.headers.get("X-Relay-Key") || "";
            const urlKey = url.searchParams.get("key") || "";
            if (presented !== env.RELAY_KEY && urlKey !== env.RELAY_KEY) {
                return jsonResponse({
                    ok: false,
                    error: "unauthorized",
                    detail: "X-Relay-Key missing or does not match RELAY_KEY",
                }, 401);
            }
        }

        // Only GET /?url=<...> is supported
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
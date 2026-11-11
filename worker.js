// AE Fusion Relay - Cloudflare Worker - stateless - no shebang for JS
// Roles: /market?symbol= -> provider chain, /?url= -> crawler relay, /health -> ok
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Key' };
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } }); }
function checkKey(req, env){ if(!env.RELAY_KEY) return true; return req.headers.get('X-Relay-Key') === env.RELAY_KEY; }
async function fetchJson(url, headers={}){ const r = await fetch(url, { headers }); if(!r.ok) throw new Error('fetch '+r.status); return await r.json(); }
async function marketCrypto(symbol, env){
  const base = symbol.split('-')[0];
  const quote = symbol.split('-')[1] || 'USD';
  const pair = base + quote;
  // Kraken primary
  try{ const d = await fetchJson('https://api.kraken.com/0/public/Ticker?pair='+pair); const k = Object.keys(d.result||{})[0]; if(k){ const p = d.result[k].c[0]; return { price: p, provider: 'kraken', symbol }; } }catch(e){}
  // Binance
  try{ const d = await fetchJson('https://api.binance.us/api/v3/ticker/price?symbol='+pair); if(d.price) return { price: d.price, provider: 'binance', symbol }; }catch(e){}
  // CoinGecko
  try{ const idmap = { BTC:'bitcoin', ETH:'ethereum', XRP:'ripple', SOL:'solana', DOGE:'dogecoin' }; const id = idmap[base]||base.toLowerCase(); const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids='+id+'&vs_currencies=usd'); if(d[id]&&d[id].usd) return { price: String(d[id].usd), provider: 'coingecko', symbol }; }catch(e){}
  // Yahoo fallback
  try{ const d = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/'+symbol); const p = d.chart?.result?.[0]?.meta?.regularMarketPrice; if(p) return { price: String(p), provider: 'yahoo', symbol }; }catch(e){}
  throw new Error('all crypto providers failed');
}
async function marketForexOrIndex(symbol, env){
  // Stooq primary for forex and indices
  try{ const s = symbol.replace('=X','').toLowerCase(); const r = await fetch('https://stooq.com/q/l/?s='+s+'&f=sd2t2ohlcv&h&e=csv'); const txt = await r.text(); const lines = txt.trim().split('\n'); if(lines.length>=2){ const parts = lines[1].split(','); const close = parts[6]||parts[5]; if(close && close!=='N/D') return { price: close, provider: 'stooq', symbol }; } }catch(e){}
  try{ const d = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/'+symbol); const p = d.chart?.result?.[0]?.meta?.regularMarketPrice; if(p) return { price: String(p), provider: 'yahoo', symbol }; }catch(e){}
  throw new Error('all forex providers failed');
}
async function marketHandler(url, req, env){
  const symbol = url.searchParams.get('market') || url.searchParams.get('symbol') || 'BTC-USD';
  const isCrypto = symbol.includes('-') && !symbol.includes('=');
  try{ const out = isCrypto ? await marketCrypto(symbol, env) : await marketForexOrIndex(symbol, env); return json({ ok:true, ...out, ts: Date.now() }); }catch(e){ return json({ ok:false, error: String(e), symbol }, 502); }
}
async function crawlHandler(url, req, env){
  const target = url.searchParams.get('url');
  if(!target) return json({ ok:false, error:'missing url' }, 400);
  const block = ['meta.wikimedia.org'];
  try{ const u = new URL(target); if(block.some(b=>u.hostname.includes(b))) return json({ ok:false, error:'blocked' }, 403); }catch(e){ return json({ ok:false, error:'bad url' }, 400); }
  try{
    const r = await fetch(target, { headers: { 'User-Agent': 'AE-Fusion-Crawler/1.0' } });
    const txt = await r.text();
    const titleM = txt.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleM ? titleM[1].trim().slice(0,200) : '';
    const links = [...txt.matchAll(/href="(https?:\/\/[^\"]+)"/g)].map(m=>m[1]).slice(0,30);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
    const hash = [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
    return json({ ok:true, url: target, title, hash, links, len: txt.length });
  }catch(e){ return json({ ok:false, error: String(e) }, 502); }
}
export default {
  async fetch(req, env, ctx){
    if(req.method==='OPTIONS') return new Response(null, { status:204, headers: CORS });
    if(!checkKey(req, env)) return json({ ok:false, error:'bad key' }, 401);
    const url = new URL(req.url);
    if(url.pathname==='/health') return json({ ok:true, relay:'ae-fusion', version:'1.0' });
    if(url.pathname==='/market') return marketHandler(url, req, env);
    if(url.searchParams.has('market')||url.searchParams.has('symbol')) return marketHandler(url, req, env);
    return crawlHandler(url, req, env);
  }
};

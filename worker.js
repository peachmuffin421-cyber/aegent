// Final, First edition
// worker.js, Cloudflare Worker, Relay plus Frontend host
// One system. Backend authoritative. No synthetic bars ever.
// Worker never generates bars, never fills gaps, never returns placeholder lattice 0.
// If backend returns synthetic flag, worker returns 502 WAITING.
// Env: BACKEND_URL, e.g. https://aei-37a29e073070.herokuapp.com
// Env: ALLOWED_ORIGIN, e.g. https://peachmuffin421-cyber.github.io
function corsHeaders(origin){
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
    'Access-Control-Max-Age': '86400'
  };
}
function waitingResponse(origin){
  return new Response(JSON.stringify({status:'waiting', reason:'NO REAL FEED, WAITING, NO SYNTHETIC BARS', ordered_feed:{price:null}, bars:[], indicators:{status:'waiting'}, seed:{lattice_points:[]}}), {status:200, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
}
function isSyntheticPayload(obj){
  if(!obj || typeof obj !== 'object') return false;
  if(obj.synthetic === true) return true;
  if(obj.indicators && obj.indicators.synthetic === true) return true;
  if(obj.seed && obj.seed.lattice_points === 0) return true;
  if(Array.isArray(obj.bars) && obj.bars.some(function(b){ return b && b.synthetic === true; })) return true;
  return false;
}
export default {
  async fetch(request, env, ctx){
    var url = new URL(request.url);
    var origin = request.headers.get('Origin') || env.ALLOWED_ORIGIN || '*';
    if(request.method === 'OPTIONS'){
      return new Response(null, {status:204, headers:corsHeaders(origin)});
    }
    var backend = (env.BACKEND_URL || '').replace(/\/$/,'');
    if(!backend){
      return new Response(JSON.stringify({error:'BACKEND_URL not set', status:'waiting'}), {status:502, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
    }
    if(url.pathname === '/cs-state' || url.pathname === '/health' || url.pathname === '/miniapp-state' || url.pathname === '/aea-notification' || url.pathname === '/lattice-state' || url.pathname === '/fibration-state' || url.pathname === '/diagnostics'){
      try{
        var target = backend + url.pathname + url.search;
        var r = await fetch(target, {method:'GET', headers:{'User-Agent':'AE-TWA-Worker/1.0'}});
        var text = await r.text();
        var obj = null;
        try{ obj = JSON.parse(text); }catch(e){ obj = null; }
        if(obj && isSyntheticPayload(obj)){
          return new Response(JSON.stringify({status:'waiting', reason:'Backend returned synthetic payload, rejected by audit'}), {status:502, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
        }
        return new Response(text, {status:r.status, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
      }catch(e){
        return waitingResponse(origin);
      }
    }
    if(url.pathname === '/cs-feedback' || url.pathname === '/cs-state' || url.pathname === '/step' || url.pathname === '/handshake' || url.pathname === '/teach' || url.pathname === '/say' || url.pathname === '/crawler-enqueue' || url.pathname === '/reset' || url.pathname === '/order' || url.pathname === '/notify-aea' || url.pathname === '/encode-syllable'){
      try{
        var body = await request.text();
        var r2 = await fetch(backend + url.pathname, {method:'POST', headers:{'Content-Type':'application/json','User-Agent':'AE-TWA-Worker/1.0'}, body: body || '{}'});
        var t2 = await r2.text();
        var o2 = null;
        try{ o2 = JSON.parse(t2); }catch(e){}
        if(o2 && isSyntheticPayload(o2)){
          return new Response(JSON.stringify({ok:false, reason:'Synthetic payload rejected'}), {status:502, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
        }
        return new Response(t2, {status:r2.status, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
      }catch(e){
        return new Response(JSON.stringify({ok:false, reason:'Backend unreachable, WAITING, no synthetic'}), {status:502, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
      }
    }
    if(url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/index.htm'){
      return new Response('AE TWA Unified, Worker Relay. Frontend is served from GitHub Pages index.html with ?backend=' + backend + '. API is proxied to backend. No synthetic bars.', {status:200, headers:Object.assign({'Content-Type':'text/plain'}, corsHeaders(origin))});
    }
    return new Response(JSON.stringify({error:'not found', hint:'Use /miniapp-state, single truth'}), {status:404, headers:Object.assign({'Content-Type':'application/json'}, corsHeaders(origin))});
  }
};

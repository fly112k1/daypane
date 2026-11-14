import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildDashboard } from './aggregator.js';
import { readStatus } from './db.js';
import { config } from './config.js';

// 渲染要 Pillow。系统 python 和 WorkBuddy 自带的"裸"解释器通常都没有装，
// 所以运行时挑一个真的能 `import PIL` 的解释器，而不是把路径写死
// （写死到某个用户名下既不可移植，也会把本机用户名带进公开仓库）。
function pythonCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const wb = path.join(home, '.workbuddy', 'binaries', 'python');
  const venvBin = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python');
  const list = [];
  if (process.env.PYTHON_BIN) list.push(process.env.PYTHON_BIN);
  list.push(path.join(import.meta.dirname, '..', '.venv', venvBin));
  list.push(path.join(wb, 'envs', 'default', venvBin));
  try {
    for (const v of readdirSync(path.join(wb, 'versions'))) {
      list.push(path.join(wb, 'versions', v, 'python.exe'));
    }
  } catch { /* 没有这个目录，退到下面的通用命令名 */ }
  list.push(process.platform === 'win32' ? 'python' : 'python3', 'python');
  return list;
}

function hasPillow(bin) {
  try {
    execFileSync(bin, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

let pythonBin;
let pythonProbeOk = false;
let lastProbeAt = 0;
// 惰性解析：只有真的要渲染时才去探测，别拖慢启动和单测。
// 探测失败不能永久固化：一次瞬时故障（解释器正在被占用/杀软拦截）会让这个
// 常驻进程此后每次出图都失败，直到人工重启。失败结果 30 秒后允许重试。
export function renderPython() {
  const now = Date.now();
  if (pythonProbeOk && pythonBin) return pythonBin;
  if (pythonBin && now - lastProbeAt < 30000) return pythonBin;
  lastProbeAt = now;
  const candidates = pythonCandidates();
  const found = candidates.find(hasPillow);
  pythonProbeOk = !!found;
  pythonBin = found || candidates[candidates.length - 1];
  console.log('[dash] renderer python: ' + pythonBin + (found ? '' : ' (Pillow not found; retrying in 30s)'));
  return pythonBin;
}

function renderScreenPng(language = 'zh', port = 8787) {
  return new Promise((resolve, reject) => {
    const script = path.join(import.meta.dirname, '..', 'tools', 'render_screen.py');
    const child = spawn(renderPython(), [script, '--lang', language, '--url', 'http://127.0.0.1:' + port + '/api/dashboard'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
    const chunks = [];
    const errs = [];
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => { errs.push(d); process.stderr.write('[render] ' + d); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      const detail = Buffer.concat(errs).toString().trim().split('\n').slice(-3).join(' | ');
      reject(new Error('render exit code ' + code + (detail ? ': ' + detail : '')));
    });
  });
}

// 渲染一次要起 Python + Pillow，几秒钟且吃 CPU。Kindle 的 /api/screen 与
// manifest 轮询、浏览器刷新常常同时来 —— 同一时刻同一种语言只跑一个进程，
// 所有请求共享同一个结果。
function createRenderOnce(renderImage) {
  const renders = new Map();
  return (language, port) => {
    const key = language + ':' + port;
    const pending = renders.get(key);
    if (pending) return pending;
    const p = Promise.resolve()
      .then(() => renderImage(language, port))
      .finally(() => { if (renders.get(key) === p) renders.delete(key); });
    renders.set(key, p);
    return p;
  };
}

// 出图结果必须是真 PNG 才能进 manifest：以前直接 readUInt32BE(16)，
// 渲染器返回空 buffer / HTML 错误页时要么抛 ERR_OUT_OF_RANGE 变成含糊的 503，
// 要么把乱码当宽高写进清单，Kindle 拿去对尺寸校验才失败。
function pngDimensions(png) {
  if (!Buffer.isBuffer(png) || png.length < 24) return null;
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function sendJson(res, obj, status = 200) {
  // 故意不加 Access-Control-Allow-Origin：看板页面是同源请求、Kindle 走 LuaSocket、
  // 云端渲染是服务端请求，三条链路都不需要 CORS。而 ACAO:* 会让用户浏览器里打开的
  // 任意网页都能 fetch 走 /api/dashboard —— 那份数据含会话标题、持仓与城市。
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj, null, 2));
}

// --- HTML dashboard (client-rendered, self-refreshing, one-screen layout) ---
function renderHtml(initial) {
  const initJson = JSON.stringify(initial ?? {})
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e');
  return `<!doctype html><html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DayPane</title>
<style>
:root{color-scheme:dark;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  min-height:100vh;padding:18px;font-size:14px;}
.wrap{max-width:1180px;margin:0 auto;}
header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #21262d;}
header h1{font-size:20px;letter-spacing:1px;}
header h1 span{color:#58a6ff;}
header .meta{font-size:12px;color:#8b949e;}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;margin-left:6px;}
.badge.ok{background:#122;color:#3fb950;border:1px solid #238636;}
.badge.err{background:#221;color:#f85149;border:1px solid #da3633;}
.grid{display:grid;gap:12px;margin-bottom:12px;}
.grid.quotas{grid-template-columns:1fr;}
.usage-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}
.grid.main{grid-template-columns:1.1fr .9fr;}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:14px 16px;}
.card h2{font-size:12px;color:#8b949e;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;display:flex;align-items:center;gap:6px;}
.card h2 .ico{font-size:14px;}
.quota-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.quota-row:last-child{margin-bottom:0;}
.qname{color:#e6edf3;font-size:13px;}
.qval{font-size:15px;font-weight:700;}
.qbar{height:4px;background:#21262d;border-radius:2px;margin-top:4px;overflow:hidden;}
.qbar i{display:block;height:100%;border-radius:2px;}
.qsub{font-size:11px;color:#8b949e;margin-top:4px;}
.weather-main{display:flex;align-items:center;gap:14px;}
.weather-ico{font-size:44px;line-height:1;}
.weather-temp{font-size:40px;font-weight:800;}
.weather-temp small{font-size:18px;color:#8b949e;}
.weather-detail{margin-top:10px;font-size:13px;color:#c9d1d9;}
.weather-detail b{color:#e6edf3;}
.stocks-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px;}
.stock{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;}
.stock .sh{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;}
.stock .nm{font-size:14px;font-weight:700;}
.stock .nm small{color:#8b949e;font-weight:500;margin-left:5px;font-size:11px;}
.stock .pr{font-size:19px;font-weight:800;margin-top:4px;}
.stock .pct{font-size:12px;font-weight:600;margin-top:2px;}
.stock .spark{height:56px;margin-top:8px;}
.stock .spark svg{width:100%;height:100%;}
.stock .ft{font-size:10px;color:#6e7681;margin-top:6px;}
.up{color:#f6465d;} .down{color:#0ecb81;} .flat{color:#8b949e;}
.fx-cards{display:flex;gap:12px;}
.fx-card{flex:1;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:12px 14px;text-align:center;}
.fx-card .fc{font-size:12px;color:#8b949e;margin-bottom:4px;}
.fx-card .fv{font-size:22px;font-weight:800;}
.clocks-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.clock{display:grid;grid-template-columns:4.5em 1fr auto;align-items:baseline;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:8px 12px;}
.clock .cc{font-size:12px;color:#8b949e;}
.clock .ct{font-size:16px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums;}
.clock .cd{font-size:11px;color:#6e7681;text-align:right;}
.loading{color:#8b949e;text-align:center;padding:40px;font-size:15px;}
@media(max-width:900px){
  .grid.quotas{grid-template-columns:1fr;}
  .usage-grid{grid-template-columns:1fr;}
  .grid.main{grid-template-columns:1fr;}
  .stocks-grid{grid-template-columns:repeat(2,1fr);}
}
</style></head><body>
<div class="wrap">
<header>
  <h1>SHAWN <span>KANBAN</span></h1>
  <div class="meta">
    <span id="clock" style="font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;margin-right:14px;color:#e6edf3">--:--:--</span>
    <span id="meta">加载中…</span><span id="err"></span>
  </div>
</header>
<div id="app"><div class="loading">加载中…</div></div>
</div>
<script>
// 必须用 let：refresh() 会用新数据覆盖 INIT。
// 之前写成 const，浏览器里每次自动刷新都抛 "Assignment to constant variable"，
// 被 catch 吞掉 —— 页面首次打开正常，之后每 30 分钟静默失败，数字永远停在打开那一刻。
let INIT = ${initJson};
const W_ICONS = {晴:'☀️',晴转多云:'🌤️',多云:'⛅',阴:'☁️',小雨:'🌦️',中雨:'🌧️',大雨:'⛈️',雷阵雨:'⛈️',雪:'🌨️',雾:'🌫️',霾:'🌫️'};
function esc(s){return String(s ?? '').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
// provider 返回 null / 字符串 / NaN 都按"无数据"处理，不让一个脏值把整页 render() 抛掉。
function num(v){const n=Number(v);return v===null||v===''||v===undefined||!Number.isFinite(n)?null:n;}
function wIco(text){for(const k in W_ICONS){if((text||'').includes(k))return W_ICONS[k];}return '🌡️';}
function sparkSvg(closes){
  const vals=(closes||[]).map(Number).filter(Number.isFinite);
  if(vals.length<2)return '';
  closes=vals;
  const w=100,h=50;let min=Math.min(...closes),max=Math.max(...closes);
  const span=max-min||1,n=closes.length;const pts=[];
  for(let i=0;i<n;i++){const x=(i/(n-1))*w;const y=h-3-((closes[i]-min)/span)*(h-6);pts.push(x.toFixed(1)+','+y.toFixed(1));}
  const up=closes[n-1]>=closes[0];
  const stroke=up?'#f6465d':'#0ecb81';
  const fill=up?'rgba(246,70,93,.14)':'rgba(14,203,129,.14)';
  const line=pts.join(' ');
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
    +'<polygon points="0,'+h+' '+line+' '+w+','+h+'" fill="'+fill+'"/>'
    +'<polyline points="'+line+'" fill="none" stroke="'+stroke+'" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>'
    +'</svg>';
}
function render(d){
  const q=d.quotas||{},w=d.weather||{},fx=d.fx||{};
  const st=(d.stocks&&d.stocks.items)||[];
  const cl=(d.clocks&&d.clocks.items)||[];
  const qbar=(used,total,color)=>{const u=num(used),t=num(total);
    const p=(u!==null&&t!==null&&t>0)?Math.max(0,Math.min(100,(u/t)*100)):0;
    return '<div class="qbar"><i style="width:'+p+'%;background:'+color+'"></i></div>';};
  function fmtNum(v){const n=num(v);if(n===null)return 'n/a';return n.toLocaleString('zh');}
  // WorkBuddy 用量三行：上下文（水位，压缩后会回落）/ 已消耗（单调不减）/ 本周活动。
  // 与 PNG 版 tools/render_screen.py 的 draw_ai 同构 —— 两边必须一起改，
  // 之前这里还是旧的"限额 + Claude/Codex 手写 cap"，语义是错的。
  function usageHtml(){
    const wbv=q.workbuddy||{};
    if(!wbv.ok) return '<div class="qsub">不可用 ('+esc(wbv.error||'未知')+')</div>';
    const c=wbv.context||{}, cr=wbv.credit||{}, act=q.claudecode||{};
    const pct=num(c.percent);
    const ctxCol=(num(c.used)!==null&&num(c.size))
      ? '<div><div class="qsub">上下文</div>'
        +'<div class="qval">'+fmtNum(c.used)+' <small style="font-size:11px;color:#8b949e">/ '+fmtNum(c.size)+'</small></div>'
        +qbar(c.used,c.size,(pct||0)>80?'#f6465d':'#3fb950')
        +'<div class="qsub">已占用 '+fmtNum(pct===null?0:pct)+'% · 压缩后会回落</div></div>'
      : '<div><div class="qsub">上下文</div><div class="qval">n/a</div><div class="qsub">无用量数据</div></div>';
    return '<div class="usage-grid">'+ctxCol
      +'<div><div class="qsub">已消耗</div><div class="qval">'+fmtNum(cr.used)+'</div>'
      +'<div class="qsub">credits · '+fmtNum(cr.count)+' 次请求</div></div>'
      +'<div><div class="qsub">本周活动</div><div class="qval">'+fmtNum(act.used7d)+'</div>'
      +'<div class="qsub">条消息 · '+fmtNum(act.sessions7d)+' 个会话</div></div></div>';
  }
  const wd=w.ok
    ?'<div class="weather-main"><div class="weather-ico">'+wIco(w.text)+'</div>'
      +'<div><div class="weather-temp">'+esc(w.temp)+'<small>°C</small></div>'
      +'<div style="font-size:13px;color:#8b949e">'+esc(w.text||'')+'</div></div></div>'
      +'<div class="weather-detail">最高 <b>'+esc(w.high)+'</b>°C · 最低 <b>'+esc(w.low)+'</b>°C · 湿度 <b>'+esc(w.humidity)+'</b>%</div>'
    :'<div class="qsub">不可用 ('+esc(w.error||'')+')</div>';
  const stocks=st.map(s=>{
    const cp=num(s.changePct);
    const pct=cp===null?'':(cp>0?'+':'')+cp.toFixed(2)+'%';
    const cls=cp===null?'flat':(cp>=0?'up':'down');
    const arrow=cp===null?'':(cp>=0?'▲':'▼');
    return '<div class="stock"><div class="sh"><span class="nm">'+esc(s.label)+'<small>'+esc(s.sym)+'</small></span></div>'
      +'<div class="pr '+cls+'">'+esc(s.price)+' <small style="font-size:11px;color:#8b949e">'+esc(s.currency)+'</small></div>'
      +'<div class="pct '+cls+'">'+arrow+' '+pct+'</div>'
      +'<div class="spark">'+sparkSvg(s.spark&&s.spark.closes)+'</div>'
      +'<div class="ft">'+(s.spark?s.spark.closes.length+'日走势':'无走势数据')+'</div></div>';
  }).join('');
  const fxCards=fx.cny!=null||fx.inr!=null
    ?'<div class="fx-cards"><div class="fx-card"><div class="fc">USD → CNY 人民币</div><div class="fv up">'+esc(fx.cny)+'</div></div>'
     +'<div class="fx-card"><div class="fc">USD → INR 卢比</div><div class="fv">'+esc(fx.inr)+'</div></div></div>'
    :'<div class="qsub">不可用 ('+esc(fx.error||'')+')</div>';
  const clocks=cl.map(c=>'<div class="clock"><span class="cc">'+esc(c.city)+'</span><span class="ct">'+esc(c.time)+'</span><span class="cd">'+esc(c.date)+'</span></div>').join('');
  return '<div class="grid quotas">'
    +'<div class="card"><h2><span class="ico">🤖</span>WorkBuddy 用量</h2>'+usageHtml()+'</div>'
    +'</div>'
    +'<div class="stocks-grid">'+stocks+'</div>'
    +'<div class="grid main">'
      +'<div class="card"><h2><span class="ico">🌤️</span>天气 · '+esc(w.city||'')+'</h2>'+wd+'</div>'
      +'<div class="card"><h2><span class="ico">💰</span>汇率 (1 '+esc(fx.base||'USD')+')</h2>'+fxCards+'</div>'
      +'</div>'
    +'<div class="grid"><div class="card"><h2><span class="ico">🕐</span>世界时钟</h2><div class="clocks-grid">'+clocks+'</div></div></div>';
}
function paint(){
  document.getElementById('meta').innerHTML=
    '<span>更新 '+new Date((INIT&&INIT.serverTime)||Date.now()).toLocaleTimeString()+'</span>';
  document.getElementById('app').innerHTML=render(INIT||{});
}
function tickClock(){
  const el=document.getElementById('clock');
  if(el)el.textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});
}
async function refresh(){
  try{
    const r=await fetch('/api/dashboard',{cache:'no-store'});
    // 500 时不要把 {ok:false,error:...} 当成看板数据画上去 —— 那会清掉整屏。
    if(!r.ok)throw new Error('http '+r.status);
    const next=await r.json();
    if(!next||next.ok===false)throw new Error(next&&next.error||'bad payload');
    INIT=next;paint();
    document.getElementById('err').innerHTML='';
  }catch(e){
    // 以前是 innerHTML += ，每失败一次就多挂一个徽章，挂机几天后 DOM 里堆几十个。
    document.getElementById('err').innerHTML='<span class="badge err">刷新失败</span>';
  }
}
let refreshTimer=null;
function scheduleRefresh(){
  const n=new Date();
  const nowMs=n.getMinutes()*60000+n.getSeconds()*1000+n.getMilliseconds();
  const slot=nowMs<1800000?1800000:3600000; // 对齐到下一个 :30 / :00
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>{refresh();scheduleRefresh();},slot-nowMs);
}
tickClock();setInterval(tickClock,1000);
paint();
scheduleRefresh();
</script>
</body></html>`;
}

export function createServer({ db = null, cfg = config, renderImage = renderScreenPng, reporter = null, dashboard = buildDashboard } = {}) {
  // reporter 默认 null = 不上报：由 index.js 显式创建并传入。
  // 这样单测里的 server 不会做任何网络推送（也避免污染测试输出）。
  const renderOnce = createRenderOnce(renderImage);
  // 图片缓存按 server 实例隔离：以前是模块级 Map，同进程里起两个 server
  // （并行测试、嵌入式用法）会互相看到对方的 sha，甚至互相挤掉条目。
  const imageCache = new Map();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const remote = req.socket.remoteAddress || '?';
    const t = new Date().toISOString().slice(11, 23);
    console.log(`[dash] ${t} ${remote} ${req.method} ${url.pathname}`);

    // 这是只读服务：POST/PUT/DELETE 以前会一路走到路由里照样返回数据。
    // 明确 405，避免任何代理/预检把它当成可写的端点。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    if (url.pathname === '/api/dashboard') {
      try {
        const d = await dashboard(db);
        sendJson(res, d);
      } catch (e) {
        // 数据源炸了还回 200 会让调用方（含浏览器自动刷新）把错误体当成看板数据。
        sendJson(res, { ok: false, error: e.message }, 500);
      }
      return;
    }

    if (url.pathname === '/api/status') {
      // 这里必须自己兜住异常：它是唯一一个没有 try/catch 的数据源。
      // 异常会变成 unhandledRejection 直接终止进程 → 守护脚本 3 秒后重启 →
      // Kindle 再打一次又崩 → 崩溃循环，屏幕直接黑掉。
      try {
        const status = db ? readStatus(db, { cwdFilter: cfg.cwdFilter }) : null;
        sendJson(res, { ok: true, data: status, serverTime: Date.now() });
      } catch (e) {
        process.stderr.write('[dash] status read failed: ' + e.message + '\n');
        sendJson(res, { ok: false, error: e.message, serverTime: Date.now() }, 500);
      }
      return;
    }

    if (url.pathname.startsWith('/api/image/')) {
      const key = url.pathname.slice('/api/image/'.length).replace(/\.png$/, '');
      const image = imageCache.get(key);
      if (!image) { res.writeHead(404); res.end('Image expired; request a new manifest'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'X-Content-Type-Options': 'nosniff' });
      res.end(image); return;
    }
    if (url.pathname === '/api/display') {
      try {
        const language = url.searchParams.get('lang') === 'en' ? 'en' : 'zh';
        const png = await renderOnce(language, req.socket.localPort);
        const dim = pngDimensions(png);
        if (!dim || dim.width < 100 || dim.height < 100) throw new Error('renderer returned an invalid PNG');
        const sha256 = createHash('sha256').update(png).digest('hex');
        imageCache.set(sha256, png);
        while (imageCache.size > 8) imageCache.delete(imageCache.keys().next().value);
        sendJson(res, { schemaVersion: 1, image_url: '/api/image/' + sha256 + '.png', sha256,
          generatedAt: Date.now(), width: dim.width, height: dim.height,
          state: 'ready', language, staleAfterSeconds: 2700, refreshAfterSeconds: 1800 });
        // 出图 = 看板真的在被使用，顺手把本机用量推一份到云端兜底。
        // fire-and-forget：内部自带节流/退避，失败静默，绝不拖慢这次响应。
        if (reporter) reporter.maybeReport();
      } catch (e) {
        process.stderr.write('[dash] display render failed: ' + e.message + '\n');
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        res.end('Image generation failed');
      }
      return;
    }
    if (url.pathname === '/api/screen') {
      try {
        const png = await renderOnce(url.searchParams.get('lang') === 'en' ? 'en' : 'zh', req.socket.localPort);
        if (!pngDimensions(png)) throw new Error('renderer returned an invalid PNG');
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(png);
      } catch (e) {
        process.stderr.write('[dash] screen render failed: ' + e.message + '\n');
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('render failed: ' + e.message);
      }
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const d = await dashboard(db);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(renderHtml(d));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('error: ' + e.message);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

import { cached } from '../cache.js';
import { getConfig } from '../config.js';

// Tencent finance (gtimg) is reliable from mainland China for both US and
// A-share quotes. Response is GBK-encoded, but the numeric fields we need are
// pure ASCII, so we split the raw text on '~' without decoding the Chinese name
// (we use the config label instead).
//
// Quote field layout (US and A-share share it for our purposes):
//   [1]  name            [3]  current price
//   [4]  previous close
// Kline endpoint: https://web.ifzq.gtimg.cn/appstock/app/fqkline/get
//   param=<code>,day,,,30,qfq
//   A-share code: sh600519 / sz399001   -> bars in .qfqday
//   US code:      usAAPL.OQ / usMU.OQ   -> bars in .day
//   bar layout: [date, open, close, high, low, volume, ...]
const GTIMG = 'https://qt.gtimg.cn/q=';
const KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

function toGtimgCode(s) {
  if (s.mkt === 'US') return 'us' + String(s.sym).toUpperCase();
  // A-share: "600519.SS" / "399001.SZ" -> sh600519 / sz399001
  const raw = String(s.sym).toUpperCase();
  const [code, ex] = raw.split('.');
  const pfx = ex === 'SZ' ? 'sz' : 'sh';
  return pfx + code;
}

// Kline symbol differs slightly from the quote symbol: US stocks need an
// exchange suffix. NASDAQ -> .OQ, NYSE -> .N, NYSE Arca (many ETFs) -> .AM.
// We try them in order until one yields a usable series.
function toKlineCode(s) {
  if (s.mkt === 'US') {
    const sym = String(s.sym).toUpperCase();
    return [`us${sym}.OQ`, `us${sym}.N`, `us${sym}.AM`];
  }
  const raw = String(s.sym).toUpperCase();
  const [code, ex] = raw.split('.');
  const pfx = ex === 'SZ' ? 'sz' : 'sh';
  return [`${pfx}${code}`];
}

function currencyFor(mkt) {
  return mkt === 'US' ? 'USD' : 'CNY';
}

async function fetchBatch(codes) {
  const url = GTIMG + codes.map(encodeURIComponent).join(',');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' }
    });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchKline(code) {
  const url = `${KLINE}?param=${encodeURIComponent(code)},day,,,30,qfq`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const j = JSON.parse(await res.text());
    const node = j && j.data && j.data[code];
    const bars = (node && (node.qfqday || node.day)) || [];
    const dates = [];
    const closes = [];
    for (const b of bars) {
      const close = Number(b[2]);
      if (Number.isFinite(close) && b[0]) {
        dates.push(String(b[0]));
        closes.push(close);
      }
    }
    if (closes.length >= 2) return { dates, closes };
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Fetch a ~30 trading day close series for configured stocks, in parallel.
// 单个 symbol 最多花 12 秒（3 个候选各 9 秒太久了），超预算就放弃走势图，
// 不能让一组 K 线把整块看板拖到超时。
async function getSparks(list) {
  const results = {};
  const deadline = Date.now() + 12000;
  await Promise.all(
    list.map(async (s) => {
      const candidates = toKlineCode(s);
      for (const code of candidates) {
        if (Date.now() > deadline) return;
        const spark = await cached(
          `kline:${code}`,
          5 * 60 * 1000,
          () => fetchKline(code)
        );
        if (spark) {
          results[s.sym] = spark;
          return;
        }
      }
    })
  );
  return results;
}

// 外层再包一层 cached：里层只缓存原始批次文本，最终返回值不经过 cached 就不会有
// fetchedAt，也享受不到失败降级。包一层即可跟其他 provider 行为一致。
export async function getStocks() {
  // 配置里换掉关注列表后，旧列表的缓存不能继续命中。
  const symbols = (getConfig().stocks || []).map((s) => s.sym + '/' + s.mkt).join(',');
  return cached('stocks:' + symbols, 60 * 1000, () => buildStocks());
}

async function buildStocks() {
  const list = getConfig().stocks || [];
  if (!list.length) return { ok: false, error: 'no stocks configured', items: [] };

  const codes = list.map(toGtimgCode);
  let text = '';
  try {
    text = await cached('stocks:batch:' + codes.join(','), 60 * 1000, () => fetchBatch(codes));
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }

  // Build a lookup: gtimg code (lowercased) -> raw field string.
  const byCode = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^v_([^=]+)="(.*)";?\s*$/);
    if (!m) continue;
    byCode.set(m[1].toLowerCase(), m[2]);
  }

  const items = list.map((s, i) => {
    const code = codes[i].toLowerCase();
    const raw = byCode.get(code);
    const label = s.name || s.sym;
    if (!raw) {
      return { sym: s.sym, ok: false, error: 'no data', label, mkt: s.mkt };
    }
    const p = raw.split('~');
    const price = Number(p[3]);
    const prev = Number(p[4]);
    if (!Number.isFinite(price)) {
      return { sym: s.sym, ok: false, error: 'bad data', label, mkt: s.mkt };
    }
    // Compute change from price & previous close rather than relying on a
    // fixed field index — the gtimg field layout differs between individual
    // stocks and indices, so the raw change/percent columns are unreliable.
    let change = null;
    let changePct = null;
    if (Number.isFinite(prev) && prev !== 0) {
      change = Math.round((price - prev) * 100) / 100;
      changePct = Math.round(((price - prev) / prev) * 10000) / 100;
    }
    return {
      sym: s.sym,
      ok: true,
      name: label,
      price,
      prev: Number.isFinite(prev) ? prev : null,
      change,
      changePct,
      currency: currencyFor(s.mkt),
      label,
      mkt: s.mkt
    };
  });

  // 行情整批失败时不要再发 8~24 个 K 线请求，更不要把"全是 --"标成 ok:true
  // （云端 build_site 用 sections.stocks.ok 判断数据源是否可用）。
  const valid = list.filter((s, i) => items[i].ok);
  if (!valid.length) return { ok: false, error: 'no usable quotes', items };

  const sparks = await getSparks(valid);
  for (const item of items) {
    if (sparks[item.sym]) item.spark = sparks[item.sym]; // { dates, closes }
  }
  return { ok: true, items };
}

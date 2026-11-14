// Tiny TTL cache + resilient JSON fetch helper (no external deps).

const store = new Map(); // key -> { value, expires, fetchedAt }
// 上一次"成功"的数据。失败时用它降级，让看板能显示"上一次缓存"而不是冷冰冰的"不可用"。
const lastOk = new Map(); // key -> { value, at }

// 各 provider 统一用 ok:false 标识失败；没带 ok 字段的对象视为成功。
const isOk = (v) => !!(v && v.ok !== false);

// 失败/降级数据不能按正常 TTL 缓存：一次 2 秒的网络抖动会把"旧数据"
// 钉在屏幕上 10 分钟（新闻/天气的 TTL 就是 10 分钟）。短 TTL 让下一次
// 轮询很快就能自愈，又不至于在断网时反复打源站。
const FAILURE_TTL_MS = 30 * 1000;
export const failureTtl = (ttlMs) => Math.min(ttlMs, FAILURE_TTL_MS);

// 给返回体打上数据获取时间，渲染端据此显示刷新时间。
// 返回副本而不是原地改：producer 可能返回自己复用的对象，原地写 fetchedAt
// 会污染它内部的缓存，多个 key 之间互相覆盖时间戳。
function stamp(value, at) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value, fetchedAt: at };
  return value;
}

/**
 * Run `producer()` and cache its result for `ttlMs`.
 * Concurrent calls for the same key share one in-flight promise.
 *
 * 失败语义（stale-while-error）：本次拉取失败时，若历史上成功过，
 * 就返回那次成功的数据并打上 stale:true，fetchedAt 保持为上次成功的时间。
 * producer 抛异常也算一次失败 —— 绝不把异常漏给 Promise.all，
 * 那会让一个源拖垮整块看板。
 */
const inflight = new Map();
export async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      return await produce();
    } finally {
      // 只删自己：极端情况下新的 in-flight 已经排上，别把它一起清掉。
      if (inflight.get(key) === p) inflight.delete(key);
    }
  })();

  async function produce() {
    const at = Date.now();
    let value;
    try {
      value = await producer();
    } catch (e) {
      value = { ok: false, error: e.message, items: [] };
    }

    if (isOk(value)) {
      const stamped = stamp(value, at);
      lastOk.set(key, { value: stamped, at });
      store.set(key, { value: stamped, expires: at + ttlMs, fetchedAt: at });
      return stamped;
    }

    // 拉取失败：有上次成功数据就降级，否则原样返回失败体
    const prev = lastOk.get(key);
    if (prev) {
      const stale = stamp({ ...prev.value, stale: true }, prev.at);
      store.set(key, { value: stale, expires: at + failureTtl(ttlMs), fetchedAt: prev.at });
      return stale;
    }
    store.set(key, { value, expires: at + failureTtl(ttlMs), fetchedAt: at });
    return stamp(value, at);
  }
  inflight.set(key, p);
  return p;
}

/**
 * Fetch JSON with a timeout and a browser-like UA (some endpoints 403 without it).
 * 流式读取并设上限：外部源返回畸形/无限响应时不能让常驻进程吃满内存。
 * @returns {Promise<{ok:boolean, status?:number, data?:any, error?:string}>}
 */
export async function fetchJson(url, { timeoutMs = 8000, headers = {}, maxBytes = 2 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'kindle-dash/1.0', Accept: 'application/json', ...headers }
    });
    const declared = Number(res.headers && res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, status: res.status, error: 'response too large' };
    }
    let text;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > maxBytes) {
          await reader.cancel();
          return { ok: false, status: res.status, error: 'response too large' };
        }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf-8');
    } else {
      text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) return { ok: false, status: res.status, error: 'response too large' };
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: `bad json (${text.slice(0, 80)})` };
    }
    if (!res.ok) return { ok: false, status: res.status, error: `http ${res.status}` };
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

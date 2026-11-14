// Compare against the last successful upload, never the latest local collection.
//
// 以前只比 `remaining`。上报内容换成 context / credit / 活动量之后，
// 新字段（credit.used、used7d、sessions7d、context.used）变化而 remaining
// 恰好不变（或旧格式根本没有 remaining）时，会被判成"无变化"，
// 云端数据就一直停在旧值。这里把真正会上图的数字都纳入比较。
//
// 容差按量级分开：token 数是几十万级，0.5% 抖动不值得推一次；
// credits 是小数级、消息/会话数是整数级，任何变化都该推。
const FIELDS = [
  { path: ['remaining'], minDelta: 1, ratio: 0.005 },
  { path: ['used'], minDelta: 1, ratio: 0.005 },
  { path: ['used7d'], minDelta: 0, ratio: 0 },
  { path: ['sessions7d'], minDelta: 0, ratio: 0 },
  { path: ['context', 'used'], minDelta: 1, ratio: 0.005 },
  { path: ['credit', 'used'], minDelta: 0.001, ratio: 0 }
];

function pick(obj, path) {
  let v = obj;
  for (const key of path) {
    if (!v || typeof v !== 'object') return null;
    v = v[key];
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function shouldUpload(previous, next, now = Date.now(), force = false, heartbeatMs = 5 * 60 * 1000) {
  // 心跳跟上报间隔走：REPORT_EVERY 调成 30 分钟时，5 分钟硬编码心跳会让
  // 上报器每次被唤醒都推一次，节流形同虚设。
  if (force || !previous?.quotas || now - previous.ts >= heartbeatMs) return true;
  for (const key of ['workbuddy', 'claudecode', 'codex']) {
    const a = previous.quotas[key] || {};
    const b = next.quotas[key] || {};
    if (!!a.ok !== !!b.ok) return true;
    for (const field of FIELDS) {
      const ra = pick(a, field.path);
      const rb = pick(b, field.path);
      if (ra === null || rb === null) {
        if (ra !== rb) return true;
      } else if (Math.abs(ra - rb) > Math.max(field.minDelta, Math.abs(ra) * field.ratio)) return true;
    }
  }
  return false;
}

import { join } from 'node:path';
import { readdirSync, readSync, openSync, closeSync, statSync, existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { paths, getConfig } from '../config.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;

// This machine has no ~/.claude — the always-present transcript source is
// WorkBuddy's own project transcripts under ~/.workbuddy/projects/<slug>/*.jsonl.
// Those files carry { timestamp(ms), type, role, providerData.model, ... } but
// NOT per-message token usage, so we derive a real "weekly activity" metric:
//   sessions7d  = number of .jsonl files touched in the last 7 days
//   messages7d  = number of user/assistant messages in those files
//   lastModel   = most recent model seen (informational)
// Actual token remaining comes from the workbuddy provider (workbuddy.db).

let _cache = { at: 0, value: null };
const CACHE_TTL = 5 * 60 * 1000;
// 单个 transcript 可能几十 MB；太大就只算会话数，不逐行解析（活动量是估算值）。
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export function getClaudeCodeUsage() {
  const cap = getConfig().claudeCap;
  const now = Date.now();
  if (_cache.at && now - _cache.at < CACHE_TTL) return _cache.value;

  const dir = paths.claude;
  if (!existsSync(dir)) {
    return { ok: false, error: 'no transcript dir', cap };
  }

  const cutoff = now - WEEK;
  let sessions = 0;
  let messages = 0;
  let lastModel = null;

  try {
    const walk = (d) => {
      let entries;
      try {
        // withFileTypes 省掉每个文件一次 stat：目录里往往有几百个非 jsonl 文件，
        // 以前每个都要 statSync 一遍。
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'subagents') walk(p); // skip sub-agent transcripts
          continue;
        }
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) continue;
        sessions++;
        const r = countRecent(p, cutoff, st.size);
        messages += r.messages;
        if (r.lastModel) lastModel = r.lastModel;
      }
    };
    walk(dir);
  } catch (e) {
    const value = { ok: false, error: e.message, cap };
    _cache = { at: now, value };
    return value;
  }

  // 统一度量衡：used7d（本周消息数=已用额度）/ cap（上限）/ remaining / percent，
  // 与 codex 结构一致，便于 UI 三行统一渲染。
  const used7d = messages;
  const remaining = Math.max(0, cap - used7d);
  const percent = cap ? Math.min(100, Math.round((used7d / cap) * 100)) : 0;
  // metric='activity'：这是活动量统计，不是配额。cap 来自 config.json 的
  // claudeCap（手写参考值），没有真实上限语义 —— UI 不该把它画成"剩余额度"。
  const value = {
    ok: true,
    metric: 'activity',
    used7d,
    cap,
    remaining,
    percent,
    unit: 'messages',
    sessions7d: sessions,
    messages7d: messages,
    lastModel,
    source: 'local .workbuddy/projects (activity)'
  };
  _cache = { at: now, value };
  return value;
}

// 同步流式读行：不用 readFileSync().split('\n') 把一个几十 MB 的会话
// 整份读进内存再切成几万个字符串；StringDecoder 保证跨 chunk 的 UTF-8
// 多字节字符不会被切断。
function forEachLine(file, onLine) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder('utf-8');
    let carry = '';
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const lines = (carry + decoder.write(buf.subarray(0, n))).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
    const tail = carry + decoder.end();
    if (tail) onLine(tail);
  } finally {
    closeSync(fd);
  }
}

function countRecent(file, cutoff, size) {
  let messages = 0;
  let lastModel = null;
  if (size > MAX_SCAN_BYTES) return { messages, lastModel };
  forEachLine(file, (line) => {
    if (!line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const ts = parseTs(o);
    if (ts == null || ts < cutoff) return;
    if (o.type !== 'message') return;
    const role = o.role || (o.message && o.message.role);
    if (role === 'user' || role === 'assistant') {
      messages++;
      const model = o.providerData && o.providerData.model;
      if (model) lastModel = model;
    }
  });
  return { messages, lastModel };
}

function parseTs(o) {
  const raw = o.timestamp ?? (o.message && o.message.timestamp) ?? o.created_at;
  if (raw == null) return null;
  // Numeric epoch-ms timestamps are valid as-is; strings go through Date.parse.
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

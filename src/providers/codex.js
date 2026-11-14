import { join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { paths, getConfig } from '../config.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;
// 扫描上限：Codex 目录结构随版本变化，深度遍历不能变成无界的磁盘 I/O。
const MAX_ENTRIES = 20000;

// Approximate Codex usage by counting session files touched in the
// last 7 days under the Codex data directory. Structure varies by version,
// so this is best-effort and clearly labelled as an approximation.
export function getCodexUsage() {
  const cap = getConfig().codexCap;
  const dir = paths.codexCandidates.find((p) => existsSync(p));
  if (!dir) {
    // 本机未安装 Codex：保持与 claudecode 相同的字段结构，UI 预留位置显示"未安装"
    return {
      ok: false,
      error: 'not-installed',
      cap,
      used7d: null,
      remaining: null,
      percent: 0,
      unit: 'messages'
    };
  }
  const cutoff = Date.now() - WEEK;
  const state = { used: 0, visited: 0 };
  try {
    const scan = (d, depth) => {
      if (depth > 4 || state.visited >= MAX_ENTRIES) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (state.visited >= MAX_ENTRIES) break;
        state.visited++;
        const p = join(d, e.name);
        if (e.isDirectory()) {
          // 以前目录本身 +1、目录里的会话文件再 +1，同一个会话被算两次。
          // 现在只数带扩展名的会话文件，目录仅用于继续遍历。
          scan(p, depth + 1);
        } else if (e.isFile() && /\.(jsonl|json|log)$/i.test(e.name)) {
          try {
            if (statSync(p).mtimeMs >= cutoff) state.used++;
          } catch {
            /* 文件可能在扫描期间被删掉 */
          }
        }
      }
    };
    scan(dir, 0);
  } catch (e) {
    return {
      ok: false, error: e.message, cap,
      used7d: null, remaining: null, percent: 0, unit: 'files'
    };
  }
  return {
    ok: true,
    metric: 'activity',
    used7d: state.used,
    cap,
    remaining: Math.max(0, cap - state.used),
    percent: cap ? Math.min(100, Math.round((state.used / cap) * 100)) : 0,
    unit: 'files',
    // 不带绝对路径：这个字段会进公开的 runtime-data/quotas.json，
    // 而路径里含本机用户名。
    source: 'local codex dir (approx)',
    scannedEntries: state.visited
  };
}

import { cached, fetchJson } from '../cache.js';

// 今日新闻 · AI：全部走中文源，输出"一句话标题"。
//   1) 量子位 qbitai.com/feed   —— 中文 AI 垂直，AI 密度最高
//   2) Solidot solidot.org     —— 中文科技，标题干净短（一句话）
//   3) 少数派 sspai.com/feed    —— 中文补充
//   4) HN Algolia              —— 最后兜底（英文，仅在前三者全挂时出现）
// 过滤：白名单 AI 关键词 + 软文黑名单。
// 超长标题不在这里截断 —— 渲染端会按标点做"自然断句"截断，保证不超页宽。
// AI 必须带词边界：否则 "Haiku"(含 ai)、"Chain"、"Detail" 都会被误判
const AI_KW = /\bAI\b|人工智能|大模型|LLM|GPT|Claude|Gemini|智能体|Agent|算力|芯片|英伟达|NVIDIA|Hugging\s?Face|开源模型|机器人|Copilot|OpenAI|深度学习|神经网络|Transformer|推理模型|AGI/i;

// 量子位/Solidot 里常见的推广、活动、招聘类标题
const SPAM_KW = /助力|无感迁移|斩获|晋级|国赛|官宣|大会|峰会|直播|报名|招募|招聘|训练营|优惠券|折扣|领衔|生涯|同蚂蚁|国产算力|商汤大装置/;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', laquo: '«', raquo: '»'
};

// RSS 的 <title> 里常带 &amp; / &#8217; / &#x201C; —— 以前原样画到 e-ink 上，
// 读者看到的是 "&amp;" 而不是 "&"。解码后再去标签，避免把转义的标签重新激活。
function cleanTitle(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      const key = code.toLowerCase();
      if (key[0] === '#') {
        const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        if (Number.isFinite(n) && n > 0 && n <= 0x10ffff) {
          try { return String.fromCodePoint(n); } catch { return m; }
        }
        return m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssTitles(xml, max) {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const it of items) {
    const m = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    if (m) {
      const t = cleanTitle(m[1]);
      if (t) out.push(t);
    }
    if (out.length >= max) break;
  }
  return out;
}

// 视觉宽度权重：中文/全角算 2，英文数字算 1。
// 页宽 992px、正文 34px → 全角约 34px/字 → 1 单位 ≈ 17px → 一行上限 ≈ 58 单位。
// 一句话新闻 = 按权重升序选最短的几条，保证整行放得下、不出现省略号。
function visualLen(s) {
  let n = 0;
  for (const ch of s) {
    n += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return n;
}

function pick(titles, source, out, max) {
  for (const t of titles) {
    if (out.length >= max * 4) break; // 多收一些候选，排序后再截
    if (!AI_KW.test(t)) continue;
    if (SPAM_KW.test(t)) continue;
    if (out.some(o => o.title === t)) continue; // 去重
    out.push({ title: t, source, len: visualLen(t) });
  }
}

async function fetchRss(url, max) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kindle-dash/1.0)', Accept: 'application/rss+xml,text/xml' }
    });
    if (!res.ok) throw new Error('http ' + res.status);
    return parseRssTitles(await res.text(), max);
  } finally {
    clearTimeout(timer);
  }
}

export function getNews(language = 'zh') {
  if (language === 'en') {
    return cached('news-en', 10 * 60 * 1000, async () => {
      const r = await fetchJson('https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=12');
      const items = (r.data?.hits || []).filter(h => h.title).slice(0, 6)
        .map(h => ({ title: cleanTitle(h.title), source: 'HN', url: h.url }));
      return { ok: r.ok && items.length > 0, items, source: 'HN', error: r.error };
    });
  }
  // 缓存 10 分钟：Kindle 30 分钟刷新时必然拿到新数据，同时避免频繁请求源站。
  return cached('news', 10 * 60 * 1000, async () => {
    const items = [];
    const errors = [];
    const MAX = 6;

    const sources = [
      ['https://www.qbitai.com/feed', '量子位'],
      ['https://www.solidot.org/index.rss', 'Solidot'],
      ['https://sspai.com/feed', '少数派']
    ];

    // 三个源并发：以前串行时一个源超时 8 秒会让后面两个一起等，
    // 最坏 24 秒才轮到兜底，看板渲染被拖住。
    const results = await Promise.allSettled(
      sources.map(([url]) => fetchRss(url, 20))
    );
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') pick(r.value, sources[i][1], items, MAX);
      else errors.push(sources[i][1] + ': ' + (r.reason && r.reason.message));
    });
    // 一句话新闻：短的优先。Array.sort 稳定，同长度保持源顺序
    items.sort((a, b) => a.len - b.len);

    // 兜底：中文源全挂时才用英文 HN
    if (!items.length) {
      const r = await fetchJson(
        'https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=6'
      );
      if (r.ok && r.data && Array.isArray(r.data.hits)) {
        for (const h of r.data.hits) {
          if (h.title) items.push({ title: cleanTitle(h.title), source: 'HN' });
          if (items.length >= 3) break;
        }
      } else {
        errors.push('hn: ' + (r.error || 'fail'));
      }
    }

    if (!items.length) {
      return { ok: false, error: errors.join('; ') || 'no news', items: [] };
    }
    return { ok: true, items: items.slice(0, MAX), source: 'qbitai + solidot + sspai' };
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'workbuddy.db');

// 单测不该依赖公网：以前 / 和 /api/dashboard 会真的去打天气/行情/MLB 接口，
// CI 上网络一抖就红，还把每个测试拖到十几秒。注入一份确定性数据即可。
const DASH = {
  ok: true,
  serverTime: 1700000000000,
  quotas: {
    workbuddy: { ok: true, model: 'hy3', context: { used: 100, size: 1000, percent: 10 }, credit: { used: 3, count: 2 } },
    claudecode: { ok: true, used7d: 42, sessions7d: 4 }
  },
  weather: { ok: true, city: '深圳', temp: 26, high: 29, low: 22, humidity: 60, text: '晴' },
  stocks: { ok: true, items: [
    { sym: 'SPY', label: '标普500', price: 700, changePct: -1.2, currency: 'USD', spark: { closes: [1, 2, 3] } }
  ] },
  fx: { ok: true, cny: 7.1, inr: 83, base: 'USD' },
  clocks: { ok: true, items: [{ city: '伦敦', time: '08:00', date: '10/31 周五' }] },
  news: { ok: true, items: [] },
  mlb: { ok: true, items: [] }
};
const dashboard = async () => DASH;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('/api/status returns JSON with token data', async () => {
  const db = openDb(FIXTURE);
  const server = createServer({ db, cfg: { ...config, cwdFilter: '' }, dashboard });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.token.remaining, 900);
  } finally {
    server.close();
    db.close();
  }
});

test('/ returns an HTML page', async () => {
  const db = openDb(FIXTURE);
  const server = createServer({ db, dashboard });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /DayPane/i);
    assert.match(html, /WorkBuddy 用量/);
  } finally {
    server.close();
    db.close();
  }
});

test('/api/dashboard returns the injected payload without touching the network', async () => {
  const db = openDb(FIXTURE);
  const server = createServer({ db, dashboard });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.weather.city, '深圳');
    assert.ok(body.quotas && body.quotas.workbuddy);
  } finally {
    server.close();
    db.close();
  }
});

test('a malformed provider value cannot blank the HTML dashboard', async () => {
  const bad = { ...DASH, stocks: { ok: true, items: [
    { sym: 'SPY', label: '标普500', price: 'n/a', changePct: 'oops', spark: { closes: [1, null, 3] } }
  ] } };
  const server = createServer({ db: null, dashboard: async () => bad });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /WorkBuddy 用量/);
  } finally {
    server.close();
  }
});

test('unknown route returns 404', async () => {
  const server = createServer({ db: null, dashboard });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('dashboard failure is a real HTTP error', async () => {
  const server = createServer({ db: null, dashboard: async () => { throw new Error('boom'); } });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).ok, false);
  } finally {
    server.close();
  }
});

test('write methods are rejected', async () => {
  const server = createServer({ db: null, dashboard });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  } finally {
    server.close();
  }
});

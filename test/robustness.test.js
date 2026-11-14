import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { buildDashboard } from '../src/aggregator.js';
import { getConfig } from '../src/config.js';
import { cached, fetchJson, failureTtl } from '../src/cache.js';

test('one dead data source cannot blank the whole dashboard', async () => {
  const original = globalThis.fetch;
  // 所有外部源同时挂掉：以前任一 provider 抛异常都会让 Promise.all 拒绝，
  // /api/dashboard 直接 500，Kindle 只能拿旧缓存。
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const d = await buildDashboard(null);
    assert.equal(d.ok, true);
    for (const key of ['weather', 'stocks', 'fx', 'news', 'newsEn', 'mlb', 'clocks', 'quotas']) {
      assert.ok(d[key] != null, key + ' must still be present');
    }
    assert.equal(d.weather.ok, false);
    assert.equal(d.stocks.ok, false);
    assert.ok(Array.isArray(d.stocks.items));
    assert.equal(d.clocks.ok, true, 'local clocks do not depend on the network');
  } finally {
    globalThis.fetch = original;
  }
});

test('cached() converts a throwing producer into a failure result', async () => {
  let calls = 0;
  const key = 'throwing-' + Date.now();
  const a = await cached(key, 60000, () => { calls++; throw new Error('boom'); });
  const b = await cached(key, 60000, () => { calls++; return { ok: true }; });
  assert.equal(a.ok, false);
  assert.match(a.error, /boom/);
  assert.equal(calls, 1, 'failed result is cached for the TTL');
  assert.equal(b.ok, false, 'cache still serves the failure until it expires');
});

test('failures are cached briefly so a transient outage self-heals', () => {
  assert.equal(failureTtl(10 * 60 * 1000), 30 * 1000);
  assert.equal(failureTtl(5 * 1000), 5 * 1000);
});

test('fetchJson streams JSON and caps oversized responses', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/big' ? JSON.stringify({ blob: 'x'.repeat(50000) }) : JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.deepEqual((await fetchJson(base + '/small')).data, { ok: true });
    const capped = await fetchJson(base + '/big', { maxBytes: 1000 });
    assert.equal(capped.ok, false);
    assert.match(capped.error, /too large/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('invalid port in config.json falls back instead of crashing listen()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daypane-cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({ port: 'oops', quotaStaleMs: -5 }));
  const orig = process.env.SHAWN_CONFIG;
  process.env.SHAWN_CONFIG = p;
  try {
    const cfg = getConfig();
    assert.equal(cfg.port, 8787);
    assert.equal(cfg.quotaStaleMs, 6 * 60 * 60 * 1000);
  } finally {
    if (orig === undefined) delete process.env.SHAWN_CONFIG;
    else process.env.SHAWN_CONFIG = orig;
  }
});

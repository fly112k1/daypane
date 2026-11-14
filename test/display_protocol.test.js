import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from '../src/server.js';

// 最小可用 PNG 头：服务现在会校验签名与 IHDR，测试不能再拿一个全 0 的 buffer
// 冒充图片（那正是以前宽高会被静默写错的原因）。
function minimalPng(width = 1072, height = 1448) {
  const png = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test('manifest identifies retrievable image bytes and selected language', async () => {
  const png = minimalPng();
  let selected;
  const server = createServer({renderImage: async language => { selected = language; return png; }});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const manifest = await (await fetch(base + '/api/display?lang=en')).json();
    assert.equal(selected, 'en'); assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.width, 1072); assert.equal(manifest.height, 1448);
    assert.equal(manifest.sha256, createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(Buffer.from(await (await fetch(base + manifest.image_url)).arrayBuffer()), png);
    assert.equal((await fetch(base + '/api/image/not-present.png')).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('failed renderer returns unavailable instead of a successful manifest', async () => {
  const server = createServer({renderImage: async () => { throw new Error('offline'); }});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { assert.equal((await fetch('http://127.0.0.1:' + server.address().port + '/api/display')).status, 503); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('malformed renderer output cannot become a manifest', async () => {
  const server = createServer({renderImage: async () => Buffer.from('<html>error</html>')});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/api/display')).status, 503);
    assert.equal((await fetch(base + '/api/screen')).status, 500);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('concurrent requests for one language share a single render', async () => {
  let calls = 0;
  const png = minimalPng();
  const server = createServer({renderImage: async () => { calls++; await new Promise(r => setTimeout(r, 30)); return png; }});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const results = await Promise.all([
      fetch(base + '/api/display?lang=zh'),
      fetch(base + '/api/screen?lang=zh'),
      fetch(base + '/api/display?lang=zh')
    ]);
    assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
    assert.equal(calls, 1, 'identical renders must be coalesced');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('html dashboard declares INIT as reassignable', async () => {
  // refresh() 会执行 INIT = await r.json()。若声明成 const，浏览器每次自动刷新
  // 都会抛 TypeError 并被 catch 吞掉 —— 页面数字永远停在首次打开的那一刻。
  const server = createServer({renderImage: async () => minimalPng()});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const html = await (await fetch('http://127.0.0.1:' + server.address().port + '/')).text();
    assert.match(html, /\blet\s+INIT\s*=/, 'INIT must be declared with let');
    assert.doesNotMatch(html, /\bconst\s+INIT\s*=/, 'INIT must not be declared with const');
    assert.match(html, /INIT\s*=\s*next\s*;/, 'refresh() must reassign INIT');
    assert.match(html, /id="err"/, 'refresh errors need a replaceable slot');
    assert.doesNotMatch(html, /innerHTML\s*\+=\s*'<span class="badge err"/, 'error badges must not accumulate');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUpload } from '../src/report-policy.js';
const snapshot = { ts: 1000, quotas: { codex: { ok: true, remaining: 100 } } };
test('unchanged usage still sends heartbeat', () => {
  assert.equal(shouldUpload(snapshot, snapshot, 2000), false);
  assert.equal(shouldUpload(snapshot, snapshot, 301000), true);
});
test('failure keeps retry eligible against the same successful upload', () => {
  const next = { ts: 2000, quotas: { codex: { ok: true, remaining: 50 } } };
  assert.equal(shouldUpload(snapshot, next, 2000), true);
  assert.equal(shouldUpload(snapshot, next, 3000), true);
  assert.equal(shouldUpload(next, next, 3000), false);
});
test('first report and recovered provider are uploaded', () => {
  assert.equal(shouldUpload(null, snapshot, 2000), true);
  assert.equal(shouldUpload({ ...snapshot, quotas: {} }, snapshot, 2000), true);
});

test('credit and activity changes are not swallowed by an unchanged remaining', () => {
  const base = {
    ts: 1000,
    quotas: {
      workbuddy: { ok: true, remaining: 900, context: { used: 100 }, credit: { used: 12 } },
      claudecode: { ok: true, remaining: 900, used7d: 40, sessions7d: 3 }
    }
  };
  const clone = JSON.parse(JSON.stringify(base));
  assert.equal(shouldUpload(base, clone, 2000), false);
  clone.quotas.workbuddy.credit.used = 13;
  assert.equal(shouldUpload(base, clone, 2000), true, 'credit spend must reach the cloud');
  clone.quotas.workbuddy.credit.used = 12;
  clone.quotas.claudecode.used7d = 41;
  assert.equal(shouldUpload(base, clone, 2000), true, 'weekly activity must reach the cloud');
});

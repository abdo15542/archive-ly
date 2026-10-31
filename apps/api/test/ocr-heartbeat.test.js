import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcrHeartbeat } from '../src/workers/ocr-heartbeat.js';

test('OCR heartbeat serializes updates and persists the stopped state last', async () => {
  const calls = [];
  let releaseFirst;
  const pool = {
    query(sql, values) {
      calls.push({ sql, values });
      if (calls.length === 1) return new Promise(resolve => { releaseFirst = resolve; });
      return Promise.resolve({ rowCount: 1 });
    }
  };
  const heartbeat = createOcrHeartbeat({
    pool,
    workerId: '00000000-0000-4000-8000-000000000001',
    workerName: 'test-worker',
    pid: 1234
  });
  const online = heartbeat('online');
  const stopped = heartbeat('stopped');
  await Promise.resolve();
  assert.equal(calls.length, 1);
  releaseFirst({ rowCount: 1 });
  await Promise.all([online, stopped]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.values[3]), ['online', 'stopped']);
  assert.match(calls[1].sql, /stopped_at=CASE WHEN EXCLUDED\.status='stopped' THEN NOW\(\) ELSE NULL END/);
});

test('OCR heartbeat rejects an invalid status', async () => {
  const heartbeat = createOcrHeartbeat({
    pool: { query: async () => ({ rowCount: 1 }) },
    workerId: '00000000-0000-4000-8000-000000000002',
    workerName: 'test-worker',
    pid: 1234
  });
  await assert.rejects(heartbeat('unknown'), /Invalid OCR worker status/);
});

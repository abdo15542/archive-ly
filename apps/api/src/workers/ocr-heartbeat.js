export function createOcrHeartbeat({ pool, workerId, workerName, pid }) {
  if (!pool?.query || !workerId || !workerName || !Number.isInteger(pid)) {
    throw new TypeError('OCR heartbeat requires pool, worker identity, name, and process id');
  }
  let queue = Promise.resolve();
  return function heartbeat(status = 'online') {
    if (!['online', 'stopped'].includes(status)) {
      return Promise.reject(new TypeError('Invalid OCR worker status'));
    }
    queue = queue.then(() => pool.query(
      `INSERT INTO ocr_workers(id,worker_name,pid,status,started_at,last_seen_at,stopped_at)
       VALUES($1,$2,$3,$4,NOW(),NOW(),CASE WHEN $4='stopped' THEN NOW() ELSE NULL END)
       ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,last_seen_at=NOW(),
         stopped_at=CASE WHEN EXCLUDED.status='stopped' THEN NOW() ELSE NULL END`,
      [workerId, workerName, pid, status]
    )).catch(error => {
      console.error('OCR worker heartbeat failed:', error.message || error);
    });
    return queue;
  };
}

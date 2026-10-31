import { pool } from '../db/pool.js';

export async function startOperation(operationType, metadata = {}) {
  const result = await pool.query(
    'INSERT INTO backup_operations(operation_type,status,metadata) VALUES($1,\'running\',$2::jsonb) RETURNING id,started_at',
    [operationType, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

export async function finishOperation(id, { status, artifactName = null, artifactSizeBytes = null, error = null, metadata = {} }) {
  if (!id) return;
  const safeError = error
    ? String(error?.message || error).replace(/postgres(?:ql)?:\\/\\/[^\\s]+/gi, '[database connection redacted]').slice(0, 2000)
    : null;
  await pool.query(
    `UPDATE backup_operations
     SET status=$2, finished_at=NOW(),
         duration_ms=GREATEST(0,(EXTRACT(EPOCH FROM (NOW()-started_at))*1000)::bigint),
         artifact_name=$3, artifact_size_bytes=$4, error_message=$5,
         metadata=metadata || $6::jsonb
     WHERE id=$1`,
    [id, status, artifactName, artifactSizeBytes, safeError, JSON.stringify(metadata)]
  );
}

export async function failExhaustedOcrLeases(client) {
  const expired = await client.query(`
    UPDATE ocr_jobs
    SET status='failed',
        last_error=COALESCE(last_error, 'انتهت مهلة العامل بعد استنفاد محاولات OCR'),
        locked_at=NULL,
        updated_at=NOW()
    WHERE status='processing'
      AND attempts >= 3
      AND locked_at < NOW() - INTERVAL '15 minutes'
    RETURNING document_id
  `);
  if (expired.rowCount) {
    await client.query(
      "UPDATE documents SET ocr_status='failed',updated_at=NOW() WHERE id=ANY($1::uuid[])",
      [expired.rows.map(row => row.document_id)]
    );
  }
  return expired.rowCount;
}

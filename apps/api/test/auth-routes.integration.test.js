import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.JWT_SECRET ||= 'archive-ly-integration-test-secret-with-sufficient-entropy';

test('auth routes and document deletion preserve audit integrity', { skip: !process.env.DATABASE_URL }, async (t) => {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'archive-ly-integration-'));
  process.env.UPLOAD_DIR = uploadDir;
  const { pool } = await import('../src/db/pool.js');
  const { default: authRoutes } = await import('../src/routes/auth.js');
  const { default: documentRoutes } = await import('../src/routes/documents.js');
  const existing = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (existing.rows[0].count > 0) {
    await pool.end();
    await rm(uploadDir, { recursive: true, force: true });
    t.skip('يتطلب هذا الاختبار قاعدة بيانات اختبار خالية من المستخدمين');
    return;
  }

  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/documents', documentRoutes);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `auth-test-${Date.now()}-${crypto.randomUUID()}@example.test`;
  const password = 'Secure-Test-Password-2026';
  let userId;

  try {
    const register = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Integration Admin', email, password })
    });
    assert.equal(register.status, 201);
    const registered = await register.json();
    assert.equal(registered.user.role, 'admin');
    assert.ok(registered.token);
    userId = registered.user.id;

    const secondRegister = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Second User', email: `second-${email}`, password })
    });
    assert.equal(secondRegister.status, 403);

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(login.status, 200);
    const loggedIn = await login.json();
    assert.ok(loggedIn.token);

    const invalidLogin = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'incorrect-password' })
    });
    assert.equal(invalidLogin.status, 401);

    const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${loggedIn.token}` } });
    assert.equal(me.status, 200);

    const storedName = crypto.randomUUID();
    const filePath = path.join(uploadDir, storedName);
    await writeFile(filePath, 'integration-test-file');
    const document = await pool.query(
      'INSERT INTO documents(title,original_name,stored_name,mime_type,file_size,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      ['وثيقة اختبار الحذف', 'test.txt', storedName, 'text/plain', 21, crypto.createHash('sha256').update('integration-test-file').digest('hex'), userId]
    );
    const documentId = document.rows[0].id;
    const deleted = await fetch(`${base}/documents/${documentId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${loggedIn.token}` }
    });
    assert.equal(deleted.status, 204);
    await assert.rejects(access(filePath));
    const removed = await pool.query('SELECT id FROM documents WHERE id=$1', [documentId]);
    assert.equal(removed.rowCount, 0);
    const audit = await pool.query(
      "SELECT id FROM audit_logs WHERE actor_id=$1 AND action='document.deleted' AND resource_id=$2",
      [userId, documentId]
    );
    assert.equal(audit.rowCount, 1);

    await pool.query('UPDATE users SET is_active=FALSE WHERE id=$1', [userId]);
    const disabledLogin = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(disabledLogin.status, 401);
    const disabledMe = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${loggedIn.token}` } });
    assert.equal(disabledMe.status, 401);
  } finally {
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

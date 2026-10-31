import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ||= 'archive-ly-integration-test-secret-with-sufficient-entropy';

test('auth routes and document deletion preserve audit integrity', { skip: !process.env.DATABASE_URL }, async (t) => {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'archive-ly-integration-'));
  process.env.UPLOAD_DIR = uploadDir;
  const { pool } = await import('../src/db/pool.js');
  const { default: authRoutes } = await import('../src/routes/auth.js');
  const { default: documentRoutes } = await import('../src/routes/documents.js');
  const { default: categoryRoutes } = await import('../src/routes/categories.js');
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
  app.use('/categories', categoryRoutes);
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

    const invalidCategoryFilter = await fetch(`${base}/documents?category=not-a-uuid`, {
      headers: { authorization: `Bearer ${loggedIn.token}` }
    });
    assert.equal(invalidCategoryFilter.status, 400);
    const boundedList = await fetch(`${base}/documents?page=-5&limit=1000`, {
      headers: { authorization: `Bearer ${loggedIn.token}` }
    });
    assert.equal(boundedList.status, 200);
    const boundedPayload = await boundedList.json();
    assert.equal(boundedPayload.pagination.page, 1);
    assert.equal(boundedPayload.pagination.limit, 100);

    // Role boundaries: viewers are read-only; archivists can manage records but cannot delete categories.
    const viewerToken = jwt.sign({ sub: registered.user.id, role: 'viewer' }, process.env.JWT_SECRET);
    const archivistToken = jwt.sign({ sub: registered.user.id, role: 'archivist' }, process.env.JWT_SECRET);
    const viewerHeaders = { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' };
    const archivistHeaders = { authorization: `Bearer ${archivistToken}`, 'content-type': 'application/json' };

    const viewerCategoryCreate = await fetch(`${base}/categories`, {
      method: 'POST', headers: viewerHeaders, body: JSON.stringify({ name: 'تصنيف ممنوع' })
    });
    assert.equal(viewerCategoryCreate.status, 403);
    const viewerDocumentCreate = await fetch(`${base}/documents`, {
      method: 'POST', headers: viewerHeaders
    });
    assert.equal(viewerDocumentCreate.status, 403);
    const viewerDocumentUpdate = await fetch(`${base}/documents/${crypto.randomUUID()}`, {
      method: 'PATCH', headers: viewerHeaders, body: JSON.stringify({ title: 'تعديل ممنوع' })
    });
    assert.equal(viewerDocumentUpdate.status, 403);
    const viewerDocumentDelete = await fetch(`${base}/documents/${crypto.randomUUID()}`, {
      method: 'DELETE', headers: viewerHeaders
    });
    assert.equal(viewerDocumentDelete.status, 403);

    const categoryCreate = await fetch(`${base}/categories`, {
      method: 'POST', headers: archivistHeaders,
      body: JSON.stringify({ name: `تصنيف اختبار ${crypto.randomUUID()}`, description: 'اختبار صلاحيات' })
    });
    assert.equal(categoryCreate.status, 201);
    const category = (await categoryCreate.json()).category;
    const categoryUpdate = await fetch(`${base}/categories/${category.id}`, {
      method: 'PATCH', headers: archivistHeaders,
      body: JSON.stringify({ description: 'تم تحديثه بواسطة أمين الأرشيف' })
    });
    assert.equal(categoryUpdate.status, 200);
    const archivistCategoryDelete = await fetch(`${base}/categories/${category.id}`, {
      method: 'DELETE', headers: archivistHeaders
    });
    assert.equal(archivistCategoryDelete.status, 403);
    const adminCategoryDelete = await fetch(`${base}/categories/${category.id}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${loggedIn.token}` }
    });
    assert.equal(adminCategoryDelete.status, 204);

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
    const updatedDocument = await fetch(`${base}/documents/${documentId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${loggedIn.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'وثيقة بعد التعديل', subject: 'اختبار ذرية سجل التدقيق' })
    });
    assert.equal(updatedDocument.status, 200);
    const updatedPayload = await updatedDocument.json();
    assert.equal(updatedPayload.document.title, 'وثيقة بعد التعديل');
    const updateAudit = await pool.query(
      "SELECT id FROM audit_logs WHERE actor_id=$1 AND action='document.updated' AND resource_id=$2",
      [userId, documentId]
    );
    assert.equal(updateAudit.rowCount, 1);

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

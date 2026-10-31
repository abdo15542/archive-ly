import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.JWT_SECRET ||= 'archive-ly-integration-test-secret-with-sufficient-entropy';

test('authentication routes enforce first-admin, login and active-account rules', { skip: !process.env.DATABASE_URL }, async (t) => {
  const { pool } = await import('../src/db/pool.js');
  const { default: authRoutes } = await import('../src/routes/auth.js');
  const existing = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (existing.rows[0].count > 0) {
    await pool.end();
    t.skip('يتطلب هذا الاختبار قاعدة بيانات اختبار خالية من المستخدمين');
    return;
  }

  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `auth-test-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
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
  }
});

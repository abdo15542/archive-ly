import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole } from '../src/middleware/auth.js';

process.env.JWT_SECRET = 'archive-ly-test-secret-with-sufficient-entropy';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('authentication rejects a request without a bearer token', () => {
  const res = response();
  let continued = false;
  requireAuth({ headers: {} }, res, () => { continued = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(continued, false);
});

test('authentication rejects malformed and expired tokens', () => {
  for (const token of ['not-a-jwt', jwt.sign({ sub: 'user-1' }, process.env.JWT_SECRET, { expiresIn: -1 })]) {
    const res = response();
    let continued = false;
    requireAuth({ headers: { authorization: `Bearer ${token}` } }, res, () => { continued = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(continued, false);
  }
});

test('authentication attaches the verified identity before continuing', () => {
  const identity = { sub: 'user-1', role: 'archivist', email: 'archive@example.com' };
  const token = jwt.sign(identity, process.env.JWT_SECRET, { expiresIn: '5m' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  let continued = false;
  requireAuth(req, response(), () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.user.sub, identity.sub);
  assert.equal(req.user.role, identity.role);
});

test('role middleware allows only explicitly permitted roles', () => {
  const allow = requireRole('admin', 'archivist');
  let allowed = false;
  allow({ user: { role: 'archivist' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);

  const res = response();
  let continued = false;
  allow({ user: { role: 'viewer' } }, res, () => { continued = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
});

test('role middleware denies missing identity', () => {
  const res = response();
  let continued = false;
  requireRole('admin')({}, res, () => { continued = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
});

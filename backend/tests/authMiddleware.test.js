const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { authMiddleware, blockDemoAdminWrites } = require('../middleware/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function authenticate(token) {
  const res = response();
  const req = { headers: { authorization: `Bearer ${token}` } };
  await new Promise((resolve) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      originalJson(body);
      resolve();
      return res;
    };
    authMiddleware(req, res, () => resolve());
  });
  return { req, res };
}

test('accepts a demo-only token claim', async () => {
  const previousSecret = process.env.DEMO_JWT_SECRET;
  process.env.DEMO_JWT_SECRET = 'test-demo-signing-key';
  try {
    const token = jwt.sign({ id: 5, role: 'admin', demo_mode: true }, process.env.DEMO_JWT_SECRET);
    const { req, res } = await authenticate(token);
    assert.equal(res.statusCode, 200);
    assert.equal(req.user.demo_mode, true);
  } finally {
    if (previousSecret === undefined) delete process.env.DEMO_JWT_SECRET;
    else process.env.DEMO_JWT_SECRET = previousSecret;
  }
});

test('rejects a signed token without the demo-only claim', async () => {
  const previousSecret = process.env.DEMO_JWT_SECRET;
  process.env.DEMO_JWT_SECRET = 'test-demo-signing-key';
  try {
    const token = jwt.sign({ id: 5, role: 'admin' }, process.env.DEMO_JWT_SECRET);
    const { res } = await authenticate(token);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'TOKEN_EXPIRED');
  } finally {
    if (previousSecret === undefined) delete process.env.DEMO_JWT_SECRET;
    else process.env.DEMO_JWT_SECRET = previousSecret;
  }
});

test('blocks administrative writes for a demo session', () => {
  const res = response();
  let continued = false;
  blockDemoAdminWrites({ user: { demo_mode: true } }, res, () => {
    continued = true;
  });
  assert.equal(res.statusCode, 403);
  assert.equal(continued, false);
});

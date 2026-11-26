const assert = require('node:assert/strict');
const test = require('node:test');
const pool = require('../config/db');
const { create, getAll, update } = require('../controllers/userController');

function makeResponse() {
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

test('createUser copies the admin email settings instead of submitted values', async () => {
  const previousQuery = pool.query;
  const queries = [];
  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("WHERE role = 'admin'")) {
      return [[{ email: 'admin@example.com', gmail_app_password: 'admin-app-pass' }], []];
    }
    return [{ insertId: 11 }, []];
  };
  const response = makeResponse();

  try {
    await create({
      body: {
        username: 'new-user',
        password: 'password123',
        email: 'different@example.com',
        gmail_app_password: 'different-password',
        role: 'cashier',
      },
    }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 201);
  assert.equal(queries[1].params[3], 'admin@example.com');
  assert.equal(queries[1].params[4], 'admin-app-pass');
});

test('getAll never returns password hashes or mail app passwords', async () => {
  const previousQuery = pool.query;
  pool.query = async () => [[
    { id: 4, role: 'cashier', email: 'old@example.com', gmail_app_password: 'old-password' },
    { id: 1, role: 'admin', email: 'admin@example.com', gmail_app_password: 'admin-app-pass' },
  ], []];
  const response = makeResponse();

  try {
    await getAll({}, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.deepEqual(response.body.map(({ email }) => email), ['admin@example.com', 'admin@example.com']);
  assert.equal(response.body.some((user) => 'gmail_app_password' in user), false);
  assert.equal(response.body.some((user) => 'password' in user), false);
});

test('updateAdmin synchronizes updated email settings across all other accounts', async () => {
  const previousQuery = pool.query;
  const queries = [];
  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT id, role, email')) {
      return [[{ id: 1, role: 'admin', email: 'old@example.com', gmail_app_password: 'old-password' }], []];
    }
    if (sql.startsWith('UPDATE users SET email')) return [{ affectedRows: 1 }, []];
    return [{ affectedRows: 3 }, []];
  };
  const response = makeResponse();

  try {
    await update({
      params: { id: '1' },
      body: { email: 'new@example.com', gmail_app_password: 'new-app-pass' },
    }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(queries.length, 3);
  assert.match(queries[2].sql, /WHERE id <> \?/);
  assert.deepEqual(queries[2].params, ['new@example.com', 'new-app-pass', '1']);
});

test('updateUser does not allow editing shared email settings on non-admin accounts', async () => {
  const previousQuery = pool.query;
  const queries = [];
  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT id, role, email')) {
      return [[{ id: 4, role: 'cashier', email: 'admin@example.com', gmail_app_password: 'admin-app-pass' }], []];
    }
    return [{ affectedRows: 1 }, []];
  };
  const response = makeResponse();

  try {
    await update({
      params: { id: '4' },
      body: {
        full_name: 'Updated Name',
        email: 'changed@example.com',
        gmail_app_password: 'changed-password',
      },
    }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].sql, /email\s*=/i);
  assert.doesNotMatch(queries[1].sql, /gmail_app_password\s*=/i);
});

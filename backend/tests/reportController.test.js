const assert = require('node:assert/strict');
const test = require('node:test');
const pool = require('../config/db');
const {
  createExpense,
  deleteExpense,
  deleteSpoiledProduct,
  getExpenses,
  salesReport,
  updateExpense,
  updateSpoiledProduct,
} = require('../controllers/reportController');

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

test('createExpense accepts zero-valued categories and saves all amounts', async () => {
  const previousQuery = pool.query;
  let inserted;
  pool.query = async (sql, params) => {
    inserted = { sql, params };
    return [{ affectedRows: 1 }, []];
  };
  const response = makeResponse();

  try {
    await createExpense({
      body: {
        expense_date: '2026-02-02',
        food: '0',
        internet: '12.5',
        water: '0',
        electricity: '0',
        store_materials: '3',
        other: '0',
      },
      user: { id: 7 },
    }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 201);
  assert.match(inserted.sql, /INSERT INTO operating_expenses/);
  assert.deepEqual(inserted.params, ['2026-02-02', 0, 12.5, 0, 0, 3, 0, 7]);
});

test('createExpense rejects invalid dates and negative amounts before inserting', async () => {
  const previousQuery = pool.query;
  let called = false;
  pool.query = async () => {
    called = true;
    return [{ affectedRows: 1 }, []];
  };

  try {
    for (const body of [
      { expense_date: '2026-02-30', food: 0, internet: 0, water: 0, electricity: 0, store_materials: 0, other: 0 },
      { expense_date: '2026-02-02', food: -1, internet: 0, water: 0, electricity: 0, store_materials: 0, other: 0 },
    ]) {
      const response = makeResponse();
      await createExpense({ body, user: { id: 7 } }, response);
      assert.equal(response.statusCode, 400);
    }
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(called, false);
});

test('getExpenses returns newest dated records first', async () => {
  const previousQuery = pool.query;
  let sql;
  pool.query = async (query) => {
    sql = query;
    return [[{ id: 3, expense_date: '2026-02-03', food: 0 }], []];
  };
  const response = makeResponse();

  try {
    await getExpenses({}, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.match(sql, /ORDER BY expense_date DESC, id DESC/);
  assert.equal(response.body[0].id, 3);
});

test('updateExpense updates a record and reports a missing record', async () => {
  const previousQuery = pool.query;
  const queries = [];
  pool.query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT id')) return [[{ id: 4 }], []];
    return [{ affectedRows: 1 }, []];
  };
  const response = makeResponse();

  try {
    await updateExpense({
      params: { id: '4' },
      body: {
        expense_date: '2026-02-04',
        food: 2,
        internet: 0,
        water: 0,
        electricity: 1,
        store_materials: 0,
        other: 0,
      },
    }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 200);
  assert.match(queries[1].sql, /UPDATE operating_expenses/);
  assert.deepEqual(queries[1].params, ['2026-02-04', 2, 0, 0, 1, 0, 0, 4]);

  pool.query = async () => [[], []];
  const missingResponse = makeResponse();
  try {
    await updateExpense({
      params: { id: '404' },
      body: {
        expense_date: '2026-02-04',
        food: 0,
        internet: 0,
        water: 0,
        electricity: 0,
        store_materials: 0,
        other: 0,
      },
    }, missingResponse);
  } finally {
    pool.query = previousQuery;
  }
  assert.equal(missingResponse.statusCode, 404);
});

test('deleteExpense deletes an existing record and reports a missing one', async () => {
  const previousQuery = pool.query;
  pool.query = async () => [{ affectedRows: 1 }, []];
  const response = makeResponse();

  try {
    await deleteExpense({ params: { id: '8' } }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 200);

  pool.query = async () => [{ affectedRows: 0 }, []];
  const missingResponse = makeResponse();
  try {
    await deleteExpense({ params: { id: '404' } }, missingResponse);
  } finally {
    pool.query = previousQuery;
  }
  assert.equal(missingResponse.statusCode, 404);
});

test('deleteSpoiledProduct deletes an existing record and reports invalid or missing records', async () => {
  const previousQuery = pool.query;
  let deletedId;
  pool.query = async (sql, params) => {
    assert.match(sql, /DELETE FROM spoiled_products WHERE id = \?/);
    deletedId = params[0];
    return [{ affectedRows: 1 }, []];
  };
  const response = makeResponse();

  try {
    await deleteSpoiledProduct({ params: { id: '12' } }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(deletedId, 12);

  let queryCalled = false;
  pool.query = async () => {
    queryCalled = true;
    return [{ affectedRows: 0 }, []];
  };
  const invalidResponse = makeResponse();
  const missingResponse = makeResponse();
  try {
    await deleteSpoiledProduct({ params: { id: 'invalid' } }, invalidResponse);
    await deleteSpoiledProduct({ params: { id: '404' } }, missingResponse);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(queryCalled, true);
});

test('updateSpoiledProduct adjusts product and batch stock by the quantity change', async () => {
  const previousGetConnection = pool.getConnection;
  const state = {
    record: { id: 7, product_id: 3, batch_id: 2, quantity: 2, purchase_cost_per_unit: 4.5 },
    productStock: 10,
    batchStock: 5,
    committed: 0,
    rolledBack: 0,
  };
  pool.getConnection = async () => ({
    async beginTransaction() {},
    async commit() { state.committed += 1; },
    async rollback() { state.rolledBack += 1; },
    release() {},
    async query(sql, params = []) {
      if (sql.startsWith('SELECT id, product_id, batch_id')) return [[{ ...state.record }], []];
      if (sql.startsWith('SELECT id, stock_quantity')) return [[{ id: 3, stock_quantity: state.productStock }], []];
      if (sql.startsWith('SELECT id, quantity FROM inventory_batches')) return [[{ id: 2, quantity: state.batchStock }], []];
      if (sql.startsWith('UPDATE products SET stock_quantity')) {
        state.productStock -= params[0];
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('UPDATE inventory_batches SET quantity')) {
        state.batchStock -= params[0];
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('UPDATE spoiled_products SET')) {
        [state.record.quantity, state.record.reason, state.record.total_loss] = params;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL in spoiled-product update test: ${sql}`);
    },
  });

  try {
    const increasedResponse = makeResponse();
    await updateSpoiledProduct({
      params: { id: '7' },
      body: { quantity: 3.5, reason: 'Bruised' },
    }, increasedResponse);
    assert.equal(increasedResponse.statusCode, 200);
    assert.equal(state.productStock, 8.5);
    assert.equal(state.batchStock, 3.5);
    assert.equal(state.record.total_loss, 15.75);

    const decreasedResponse = makeResponse();
    await updateSpoiledProduct({
      params: { id: '7' },
      body: { quantity: 1.5, reason: 'Rotten' },
    }, decreasedResponse);
    assert.equal(decreasedResponse.statusCode, 200);
    assert.equal(state.productStock, 10.5);
    assert.equal(state.batchStock, 5.5);
    assert.equal(state.record.total_loss, 6.75);
    assert.equal(state.committed, 2);

    state.productStock = 0;
    state.batchStock = 0;
    const recordBeforeRejectedUpdate = { ...state.record };
    const insufficientResponse = makeResponse();
    await updateSpoiledProduct({
      params: { id: '7' },
      body: { quantity: 2, reason: 'More spoilage' },
    }, insufficientResponse);
    assert.equal(insufficientResponse.statusCode, 409);
    assert.deepEqual(state.record, recordBeforeRejectedUpdate);
    assert.equal(state.rolledBack, 1);
  } finally {
    pool.getConnection = previousGetConnection;
  }
});

test('salesReport includes categorized expenses in filtered totals and daily expenses', async () => {
  const previousQuery = pool.query;
  const operatingExpenseParams = [];
  pool.query = async (sql, params = []) => {
    if (sql.includes('SELECT DATE(t.created_at)')) return [[{ date: '2026-02-02', total: 100, count: 1, profit: 20 }], []];
    if (sql.includes('SELECT c.name AS category')) return [[], []];
    if (sql.includes('SELECT payment_method, SUM(total)')) return [[], []];
    if (sql.includes('AS grand_total')) return [[{ grand_total: 100, total_transactions: 1, total_profit: 20 }], []];
    if (sql.includes('FROM transactions') && sql.includes("transaction_type = 'restock'") && sql.includes('AS total')) return [[{ total: 10 }], []];
    if (sql.includes('FROM payrolls') && sql.includes('AS total')) return [[{ total: 5 }], []];
    if (sql.includes('FROM operating_expenses') && sql.includes('AS total')) {
      operatingExpenseParams.push(params);
      return [[{ total: 6 }], []];
    }
    if (sql.includes('AS total_loss')) return [[{ total_loss: 0, total_quantity: 0 }], []];
    if (sql.includes('SELECT sp.id')) return [[], []];
    if (sql.includes('GROUP BY DATE(created_at)')) return [[{ date: '2026-02-02', amount: 10 }], []];
    if (sql.includes('SELECT period AS date')) return [[{ date: '2026-02-02', amount: 5 }], []];
    if (sql.includes('SELECT expense_date AS date')) {
      operatingExpenseParams.push(params);
      return [[{ date: '2026-02-02', amount: 6 }], []];
    }
    if (sql.includes('AS spoiled_loss')) return [[], []];
    throw new Error(`Unexpected SQL in report test: ${sql}`);
  };
  const response = makeResponse();

  try {
    await salesReport({
      query: { from: '2026-02-02 00:00:00', to: '2026-02-02 23:59:59' },
      user: { id: 7, role: 'admin' },
    }, response);
  } finally {
    pool.query = previousQuery;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.financials.total_expenses, 21);
  assert.equal(response.body.financial_by_date[0].expenses, 21);
  assert.deepEqual(operatingExpenseParams, [
    ['2026-02-02', '2026-02-02'],
    ['2026-02-02', '2026-02-02'],
  ]);
});

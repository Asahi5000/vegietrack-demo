const assert = require('node:assert/strict');
const test = require('node:test');
const pool = require('../config/db');
const { create } = require('../controllers/transactionController');

function makeDatabase({ products, batches }) {
  const state = {
    products: new Map(products.map((product) => [product.id, { ...product }])),
    batches: batches.map((batch) => ({ ...batch })),
    transactionItems: [],
    nextBatchId: Math.max(0, ...batches.map((batch) => batch.id)) + 1,
  };
  let snapshot;

  const connection = {
    async beginTransaction() {
      snapshot = structuredClone(state);
    },
    async commit() {
      snapshot = null;
    },
    async rollback() {
      Object.assign(state, snapshot);
      snapshot = null;
    },
    release() {},
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalized.startsWith('select id, name, stock_quantity, cost, base_unit from products')) {
        const product = state.products.get(Number(params[0]));
        return [[...(product ? [{ ...product }] : [])], []];
      }
      if (normalized.startsWith('select coalesce(sum(quantity), 0) as total from inventory_batches')) {
        const total = state.batches
          .filter((batch) => batch.product_id === Number(params[0]) && Number(batch.quantity) > 0)
          .reduce((sum, batch) => sum + Number(batch.quantity), 0);
        return [[{ total }], []];
      }
      if (normalized.startsWith('insert into inventory_batches')) {
        const [productId, quantity, originalQuantity, cost] = params;
        state.batches.push({
          id: state.nextBatchId++,
          product_id: Number(productId),
          purchase_date: new Date().toISOString(),
          quantity: Number(quantity),
          original_quantity: Number(originalQuantity),
          cost_per_base: Number(cost),
        });
        return [{ insertId: state.nextBatchId - 1 }, []];
      }
      if (normalized.startsWith('insert into transactions')) {
        return [{ insertId: 1 }, []];
      }
      if (normalized.startsWith('insert into transaction_items')) {
        state.transactionItems.push(params);
        return [{ insertId: state.transactionItems.length }, []];
      }
      if (normalized.startsWith('select id, quantity from inventory_batches')) {
        const rows = state.batches
          .filter((batch) => batch.product_id === Number(params[0]) && Number(batch.quantity) > 0)
          .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date) || a.id - b.id)
          .map(({ id, quantity }) => ({ id, quantity }));
        return [rows, []];
      }
      if (normalized.startsWith('update inventory_batches set quantity = ?')) {
        const batch = state.batches.find((entry) => entry.id === Number(params[1]));
        batch.quantity = Number(params[0]);
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('update products set stock_quantity = ?')) {
        state.stockUpdateSql = sql;
        const product = state.products.get(Number(params[2]));
        product.stock_quantity = Number(params[0]);
        if (Number(params[1]) <= 0) product.status = 'inactive';
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL in transaction test: ${sql}`);
    },
  };

  return { state, connection };
}

async function createSale(database, items) {
  const previousGetConnection = pool.getConnection;
  pool.getConnection = async () => database.connection;
  const result = {
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
  try {
    await create({
      body: { customer_name: 'Test Customer', items, payment_method: 'cash' },
      user: { id: 1 },
    }, result);
    return result;
  } finally {
    pool.getConnection = previousGetConnection;
  }
}

function product(id, stock) {
  return { id, name: `Product ${id}`, stock_quantity: stock, cost: 2, base_unit: 'kg', status: 'active' };
}

function batch(id, productId, quantity, purchaseDate = `2026-01-${String(id).padStart(2, '0')}`) {
  return { id, product_id: productId, quantity, purchase_date: purchaseDate };
}

function item(productId, quantity, extra = {}) {
  return {
    product_id: productId,
    product_name: `Product ${productId}`,
    quantity,
    unit_price: 10,
    unit: 'kg',
    conversion_rate: 1,
    ...extra,
  };
}

function totalStock(database, productId) {
  return database.state.batches
    .filter((entry) => entry.product_id === productId)
    .reduce((sum, entry) => sum + Number(entry.quantity), 0);
}

test('deducts 10 kg from 17 kg and leaves 7 kg', async () => {
  const database = makeDatabase({ products: [product(1, 17)], batches: [batch(1, 1, 17)] });
  const result = await createSale(database, [item(1, 10)]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.products.get(1).stock_quantity, 7);
  assert.equal(totalStock(database, 1), 7);
  assert.deepEqual(result.body.remaining_stock, { 1: 7 });
  assert.equal(database.state.transactionItems[0][7], 10);
});

test('marks stock out only when all 17 kg are sold', async () => {
  const database = makeDatabase({ products: [product(1, 17)], batches: [batch(1, 1, 17)] });
  const result = await createSale(database, [item(1, 17)]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.products.get(1).stock_quantity, 0);
  assert.equal(database.state.products.get(1).status, 'inactive');
  assert.equal(totalStock(database, 1), 0);
  assert.equal(database.state.batches.length, 1);
});

test('rejects sales above available stock without changing inventory', async () => {
  const database = makeDatabase({ products: [product(1, 17)], batches: [batch(1, 1, 17)] });
  const result = await createSale(database, [item(1, 18)]);

  assert.equal(result.statusCode, 409);
  assert.match(result.body.message, /Only 17 kg currently available/);
  assert.equal(database.state.products.get(1).stock_quantity, 17);
  assert.equal(totalStock(database, 1), 17);
  assert.equal(database.state.transactionItems.length, 0);
});

test('preserves fractional kilogram quantities across FIFO batches', async () => {
  const database = makeDatabase({
    products: [product(1, 17.5)],
    batches: [batch(1, 1, 5.5), batch(2, 1, 12)],
  });
  const result = await createSale(database, [item(1, 10.25)]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.batches[0].quantity, 0);
  assert.equal(database.state.batches[1].quantity, 7.25);
  assert.equal(database.state.products.get(1).stock_quantity, 7.25);
  assert.equal(totalStock(database, 1), 7.25);
  assert.match(database.state.stockUpdateSql, /CAST\(\? AS DECIMAL\(10,4\)\)/i);
});

test('deducts FIFO from multiple batches without clearing remaining stock', async () => {
  const database = makeDatabase({
    products: [product(1, 17)],
    batches: [batch(1, 1, 5), batch(2, 1, 12)],
  });
  await createSale(database, [item(1, 10)]);

  assert.equal(database.state.batches[0].quantity, 0);
  assert.equal(database.state.batches[1].quantity, 7);
  assert.equal(database.state.products.get(1).stock_quantity, 7);
});

test('deducts from a single partially consumed batch', async () => {
  const database = makeDatabase({ products: [product(1, 17)], batches: [batch(1, 1, 17)] });
  await createSale(database, [item(1, 10)]);

  assert.equal(database.state.batches[0].quantity, 7);
  assert.equal(database.state.products.get(1).stock_quantity, 7);
});

test('converts selling-unit quantities to base units for stock deduction', async () => {
  const database = makeDatabase({ products: [product(1, 17)], batches: [batch(1, 1, 17)] });
  const result = await createSale(database, [item(1, 1, {
    quantity: 1,
    unit: 'pack',
    conversion_rate: 10,
    base_quantity: 1,
  })]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.products.get(1).stock_quantity, 7);
  assert.equal(totalStock(database, 1), 7);
  assert.equal(database.state.transactionItems[0][7], 10);
});

test('deducts multiple products independently in one sale', async () => {
  const database = makeDatabase({
    products: [product(1, 17), product(2, 8), product(3, 4)],
    batches: [batch(1, 1, 17), batch(2, 2, 8), batch(3, 3, 4)],
  });
  const result = await createSale(database, [item(1, 10), item(2, 3)]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.products.get(1).stock_quantity, 7);
  assert.equal(database.state.products.get(2).stock_quantity, 5);
  assert.equal(database.state.products.get(3).stock_quantity, 4);
  assert.deepEqual(result.body.remaining_stock, { 1: 7, 2: 5 });
  assert.equal(database.state.transactionItems.length, 2);
});

test('restores legacy product stock missing from its batch history before selling', async () => {
  const database = makeDatabase({ products: [product(1, 17)], batches: [] });
  const result = await createSale(database, [item(1, 10)]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.products.get(1).stock_quantity, 7);
  assert.equal(totalStock(database, 1), 7);
});

test('keeps sales consistent after a spoiled quantity was deducted from product and batch', async () => {
  const database = makeDatabase({
    products: [product(1, 15)],
    batches: [batch(1, 1, 3), batch(2, 1, 12)],
  });
  const result = await createSale(database, [item(1, 10)]);

  assert.equal(result.statusCode, 201);
  assert.equal(database.state.batches[0].quantity, 0);
  assert.equal(database.state.batches[1].quantity, 5);
  assert.equal(database.state.products.get(1).stock_quantity, 5);
  assert.equal(totalStock(database, 1), 5);
});

const pool = require('../config/db');

function generateInvoiceNo() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `INV-${stamp}-${rand}`;
}

exports.getAll = async (req, res) => {
  try {
    const { from, to, status, q } = req.query;
    let sql = `SELECT t.*, u.username AS cashier_username FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE 1=1`;
    const params = [];
    if (from) { sql += ' AND t.created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND t.created_at <= ?'; params.push(to); }
    if (status) { sql += ' AND t.status = ?'; params.push(status); }
    if (q) { sql += ' AND (t.invoice_no LIKE ? OR t.customer_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (req.user.role === 'cashier') { sql += ' AND t.user_id = ?'; params.push(req.user.id); }
    sql += ' ORDER BY t.created_at DESC LIMIT 500';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch transactions' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const detailParams = [req.params.id];
    const cashierFilter = req.user.role === 'cashier' ? ' AND t.user_id = ?' : '';
    if (req.user.role === 'cashier') detailParams.push(req.user.id);
    const [txRows] = await pool.query(
      `SELECT t.*, u.username AS cashier_username FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE t.id = ?${cashierFilter}`,
      detailParams
    );
    if (txRows.length === 0) return res.status(404).json({ message: 'Transaction not found' });
    const [items] = await pool.query('SELECT * FROM transaction_items WHERE transaction_id = ?', [req.params.id]);
    res.json({ ...txRows[0], items });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch transaction' });
  }
};

exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { customer_name, items, discount, tax, payment_method } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'At least one sale item is required' });
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!Number.isInteger(Number(item.product_id)) || Number(item.product_id) <= 0) {
        return res.status(400).json({ message: `Sale item ${index + 1}: a valid product is required` });
      }
      if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
        return res.status(400).json({ message: `Sale item ${index + 1}: quantity must be greater than zero` });
      }
      if (!Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0) {
        return res.status(400).json({ message: `Sale item ${index + 1}: unit price must be zero or greater` });
      }
    }

    await conn.beginTransaction();

    const normalizeRows = (result) => {
      const rows = Array.isArray(result) ? result[0] : result;
      return Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows;
    };
    const roundQuantity = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;
    const saleBaseQtyFor = (item) => {
      const qty = Number(item.quantity);
      const rate = Number(item.conversion_rate);
      const multiplier = Number.isFinite(rate) && rate > 0 ? rate : 1;
      return roundQuantity(qty * multiplier);
    };

    const requestedByProduct = new Map();
    for (const item of items) {
      const productId = Number(item.product_id);
      const quantity = saleBaseQtyFor(item);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'Sale quantity is too small after unit conversion' });
      }
      requestedByProduct.set(productId, roundQuantity((requestedByProduct.get(productId) || 0) + quantity));
    }

    const productsById = new Map();
    const availableByProduct = new Map();
    for (const [productId, requestedQuantity] of requestedByProduct) {
      const productResult = await conn.query(
        'SELECT id, name, stock_quantity, cost, base_unit FROM products WHERE id = ? FOR UPDATE',
        [productId]
      );
      const product = normalizeRows(productResult)?.[0];
      if (!product) {
        await conn.rollback();
        return res.status(404).json({ message: `Product not found (id: ${productId})` });
      }
      productsById.set(productId, product);

      const batchResult = await conn.query(
        'SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_batches WHERE product_id = ? AND quantity > 0',
        [productId]
      );
      const batchRows = normalizeRows(batchResult);
      const batchTotal = roundQuantity(Number(batchRows?.[0]?.total) || 0);
      const recordedStock = roundQuantity(Math.max(0, Number(product.stock_quantity) || 0));

      // Older products and products created before FIFO batches were enabled can
      // have aggregate stock with no matching batch quantity. Preserve that
      // unbatched stock as an opening batch before applying FIFO deductions.
      if (recordedStock > batchTotal) {
        const unbatchedStock = roundQuantity(recordedStock - batchTotal);
        await conn.query(
          'INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES (?, NULL, CURDATE(), ?, ?, ?)',
          [productId, unbatchedStock, unbatchedStock, Number(product.cost) || 0]
        );
      }

      const availableStock = Math.max(recordedStock, batchTotal);
      availableByProduct.set(productId, availableStock);
      if (requestedQuantity > availableStock) {
        await conn.rollback();
        return res.status(409).json({
          message: `Insufficient stock for ${product.name}. Only ${availableStock} ${product.base_unit || 'units'} currently available.`,
        });
      }
    }

    let subtotal = 0;
    for (const item of items) {
      subtotal += Number(item.quantity) * Number(item.unit_price);
    }
    const discountVal = Number(discount) || 0;
    const taxVal = Number(tax) || 0;
    const total = subtotal - discountVal + taxVal;
    const invoiceNo = generateInvoiceNo();

    const [txResult] = await conn.query(
      `INSERT INTO transactions (invoice_no, user_id, customer_name, subtotal, discount, tax, total, payment_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [invoiceNo, req.user.id, customer_name || 'Walk-in Customer', subtotal, discountVal, taxVal, total, payment_method || 'cash']
    );
    const transactionId = txResult.insertId;

    for (const item of items) {
      // Store per-SELLING-unit qty (quantity/unit/unit_price/line_total) AND
      // per-base-unit qty (conversion_rate/base_quantity) on every line, so the
      // profit query can do line_total − cost_per_kg × base_quantity without
      // mixing units (e.g. 1 pack = 10 kg sold for 1200 at 100/kg costs 1000,
      // not 1 × 100 = 100).
      const rate = Number(item.conversion_rate);
      const multiplier = Number.isFinite(rate) && rate > 0 ? rate : 1;
      const baseQty = saleBaseQtyFor(item);
      const lineTotal = Number(item.quantity) * Number(item.unit_price);
      // Freeze the product cost at sale time so later restocking cannot rewrite the
      // profit of this transaction (see PROFIT_JOIN_SQL in reportController).
      // (Postgres adapter returns rows directly — handle both shapes.)
      let costPrice = null;
      if (item.product_id) {
        costPrice = productsById.get(Number(item.product_id))?.cost ?? null;
      }
      await conn.query(
        `INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit_price, unit, conversion_rate, base_quantity, line_total, cost_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [transactionId, item.product_id || null, item.product_name, item.quantity, item.unit_price, item.unit || 'kg', multiplier, baseQty, lineTotal, costPrice]
      );
      if (item.product_id) {
        // FIFO: deduct from oldest batches first (batch deduction helper)
        await deductBatchesForSale(conn, item.product_id, baseQty);
      }
    }

    await conn.commit();
    res.status(201).json({
      id: transactionId,
      invoice_no: invoiceNo,
      total,
      remaining_stock: Object.fromEntries(
        [...availableByProduct.keys()].map((productId) => [productId, roundQuantity(availableByProduct.get(productId) - requestedByProduct.get(productId))])
      ),
      message: 'Transaction recorded successfully',
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to create transaction' });
  } finally {
    conn.release();
  }
};

// FIFO batch deduction: sell from oldest batches first (closest to spoiling).
// Recalculates the product's aggregate stock_quantity from remaining batches
// so batch-level and product-level stock always agree.
async function deductBatchesForSale(conn, productId, baseQty) {
  const roundQuantity = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;
  let remaining = roundQuantity(Number(baseQty) || 0);
  if (remaining <= 0) return;
  const [batches] = await conn.query(
    'SELECT id, quantity FROM inventory_batches WHERE product_id = ? AND quantity > 0 ORDER BY purchase_date ASC, id ASC FOR UPDATE',
    [productId]
  );
  const batchList = Array.isArray(batches) && Array.isArray(batches[0]) ? batches[0] : (Array.isArray(batches) ? batches : []);
  let toDeduct = remaining;
  for (const batch of batchList) {
    if (toDeduct <= 0) break;
    const currentQty = roundQuantity(Number(batch.quantity) || 0);
    const take = roundQuantity(Math.min(currentQty, toDeduct));
    const newQty = roundQuantity(currentQty - take);
    await conn.query('UPDATE inventory_batches SET quantity = ? WHERE id = ?', [newQty, batch.id]);
    toDeduct = roundQuantity(toDeduct - take);
  }
  if (toDeduct > 0) {
    throw new Error(`Inventory batches for product ${productId} could not cover the sale quantity`);
  }
  // Recalculate aggregate stock_quantity from remaining batches
  const [stockRows] = await conn.query(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_batches WHERE product_id = ? AND quantity > 0',
    [productId]
  );
  const stockRow = Array.isArray(stockRows) ? (Array.isArray(stockRows[0]) ? stockRows[0][0] : stockRows[0]) : stockRows;
  const stockTotal = roundQuantity(Number(stockRow?.total) || 0);
  await conn.query(
    'UPDATE products SET stock_quantity = ?, status = CASE WHEN CAST(? AS DECIMAL(10,4)) <= 0 THEN \'inactive\' ELSE status END WHERE id = ?',
    [stockTotal, stockTotal, productId]
  );
}

exports.restock = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { product_id, quantity, items: requestItems, supplier_name } = req.body;
    const items = Array.isArray(requestItems) ? requestItems : [{ product_id, quantity, unit_cost: req.body.unit_cost }];
    if (items.length === 0 || items.some((item) => !item.product_id || Number(item.quantity) <= 0)) {
      return res.status(400).json({ message: 'A valid product and quantity are required for every item' });
    }
    const hasValue = (value) => value !== undefined && value !== null && value !== '';
    const invalidCostItem = items.find((item) => (
      (hasValue(item.unit_cost) && (Number.isNaN(Number(item.unit_cost)) || Number(item.unit_cost) < 0))
      || (hasValue(item.total_cost) && (Number.isNaN(Number(item.total_cost)) || Number(item.total_cost) < 0))
    ));
    if (invalidCostItem) {
      return res.status(400).json({ message: 'Cost price must be zero or greater for every item' });
    }
    await conn.beginTransaction();
    const restockItems = [];
    let total = 0;
    for (const item of items) {
      // (Postgres adapter returns rows directly, not [[row]] — handle both.)
      let product = null;
      try {
        const [foundRows] = await conn.query('SELECT id, name, unit, base_unit, cost FROM products WHERE id = ? FOR UPDATE', [item.product_id]);
        product = Array.isArray(foundRows) ? foundRows[0] : foundRows;
      } catch (preErr) {
        product = null;
      }
      if (!product) {
        await conn.rollback();
        return res.status(404).json({ message: `Product not found (id: ${item.product_id})` });
      }
      const qty = Number(item.quantity);
      // Resolve the purchase unit's multiplier to the product's base unit
      // (e.g. 1 pack = 10 kg -> 10). Falls back to 1 when the unit is the
      // base unit itself, unknown, or no conversion is configured.
      const baseKey = String(product.base_unit || product.unit || 'kg').trim().toLowerCase();
      let requestedUnit = String(item.unit || product.unit || product.base_unit || 'kg').trim() || 'kg';
      let multiplier = 1;
      // When unit_id is provided, look up by ID for precise resolution
      // (supports duplicate unit names — e.g. two "sack" sizes).
      if (String(item.unit_id) && String(item.unit_id) !== '') {
        const [unitRows] = await conn.query(
          'SELECT unit, multiplier_to_base FROM product_units WHERE id = ? LIMIT 1',
          [item.unit_id]
        );
        const found = unitRows && unitRows[0] ? unitRows[0] : null;
        if (found) {
          multiplier = Number.isFinite(Number(found.multiplier_to_base)) && Number(found.multiplier_to_base) > 0 ? Number(found.multiplier_to_base) : 1;
          requestedUnit = found.unit;
        }
      } else if (requestedUnit.toLowerCase() !== baseKey) {
        const [unitRows] = await conn.query(
          'SELECT multiplier_to_base FROM product_units WHERE product_id = ? AND unit = ? LIMIT 1',
          [item.product_id, requestedUnit]
        );
        const found = unitRows && unitRows[0] ? Number(unitRows[0].multiplier_to_base) : NaN;
        multiplier = Number.isFinite(found) && found > 0 ? found : 1;
      }
      const baseQty = qty * multiplier; // quantity converted to base units (kg)
      // Cost per BASE unit = total cost price / total base units restocked.
      // e.g. 1 pack (= 10 kg) for 1000 -> 1000 / (1 * 10) = 100 per kg.
      // Never store the raw total in products.cost.
      let cost = Number(item.unit_cost);
      let lineTotal;
      if (hasValue(item.total_cost)) {
        const totalCost = Number(item.total_cost);
        cost = baseQty > 0 ? Math.round((totalCost / baseQty) * 100) / 100 : 0;
        lineTotal = totalCost;
      } else if (Number.isFinite(cost) && cost >= 0) {
        // unit_cost from older callers means "per purchase unit" — convert it
        // to per-base-unit, and the line total is qty x per-purchase-unit cost.
        lineTotal = qty * cost;
        cost = Math.round((cost / multiplier) * 100) / 100;
      }
      if (!Number.isFinite(cost) || cost < 0) cost = Number(product.cost) || 0;
      if (lineTotal === undefined) lineTotal = baseQty * cost;
      total += lineTotal;
      restockItems.push({ product, qty, baseQty, cost, lineTotal, requestedUnit, multiplier });
    }
    const invoiceNo = generateInvoiceNo();
    const [txResult] = await conn.query(
      `INSERT INTO transactions (invoice_no, user_id, customer_name, subtotal, discount, tax, total, payment_method, status, transaction_type, supplier_name)
       VALUES (?, ?, ?, ?, 0, 0, ?, 'other', 'completed', 'restock', ?)`,
      [invoiceNo, req.user.id, supplier_name || 'Supplier', total, total, supplier_name || null]
    );
    for (const item of restockItems) {
      await conn.query(
        `INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit_price, unit, conversion_rate, base_quantity, line_total, cost_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [txResult.insertId, item.product.id, item.product.name, item.qty, item.cost, item.requestedUnit, item.multiplier, item.baseQty, item.lineTotal, item.cost]
      );
      await conn.query('UPDATE products SET stock_quantity = stock_quantity + ?, cost = ?, supplier_name = COALESCE(?, supplier_name), status = \'active\' WHERE id = ?', [item.baseQty, item.cost, supplier_name || null, item.product.id]);
      // Create a batch for this purchase (FIFO source for future sales)
      await conn.query(
        'INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES (?, ?, CURDATE(), ?, ?, ?)',
        [item.product.id, txResult.insertId, item.baseQty, item.baseQty, item.cost]
      );
    }
    await conn.commit();
    res.status(201).json({ id: txResult.insertId, invoice_no: invoiceNo, message: 'Products restocked successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to restock product' });
  } finally {
    conn.release();
  }
};

// PATCH /transactions/:id/void — admin/manager only (see transactionRoutes).
// Voiding keeps the row for auditing but marks it invalid: every sales report and
// chart filters status = 'completed', so a voided sale drops out of revenue, profit
// and top-product figures. Stock is left as recorded — voiding only invalidates the
// record. Only a completed transaction can be voided, and only once.
exports.voidTransaction = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, status FROM transactions WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Transaction not found' });
    if (rows[0].status !== 'completed') {
      return res.status(400).json({ message: `Only completed transactions can be voided (current status: ${rows[0].status})` });
    }
    // Guarded update: a concurrent request cannot void it twice.
    await pool.query(`UPDATE transactions SET status = 'voided' WHERE id = ? AND status = 'completed'`, [req.params.id]);
    res.json({ message: 'Transaction voided successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to void transaction' });
  }
};

// PATCH /transactions/:id/unvoid — admin/manager only (see transactionRoutes).
// The counterpart of voidTransaction: puts a voided transaction back to 'completed'
// so it counts in every sales figure again. Only a voided transaction can be restored.
exports.unvoidTransaction = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, status FROM transactions WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Transaction not found' });
    if (rows[0].status !== 'voided') {
      return res.status(400).json({ message: `Only voided transactions can be restored (current status: ${rows[0].status})` });
    }
    // Guarded update: a concurrent request cannot restore it twice.
    await pool.query(`UPDATE transactions SET status = 'completed' WHERE id = ? AND status = 'voided'`, [req.params.id]);
    res.json({ message: 'Transaction restored successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to unvoid transaction' });
  }
};

// DELETE /transactions/:id — admin/manager only (see transactionRoutes).
// Removes the transaction and its item lines for good, unlike voiding which keeps
// the record. The items are deleted explicitly so this also works where the foreign
// key was created without ON DELETE CASCADE.
exports.remove = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id FROM transactions WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Transaction not found' });
    }
    await conn.query('DELETE FROM transaction_items WHERE transaction_id = ?', [req.params.id]);
    await conn.query('DELETE FROM transactions WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.json({ message: 'Transaction deleted successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: 'Failed to delete transaction' });
  } finally {
    conn.release();
  }
};

const pool = require('../config/db');

// Shape one product_units row for the API (numbers for multipliers/prices).
function normalizeUnitRow(row) {
  return {
    id: row.id,
    product_id: row.product_id,
    unit: row.unit,
    label: row.label || null,
    multiplier_to_base: Number(row.multiplier_to_base),
    is_default: Number(row.is_default || 0),
    is_purchase_unit: Number(row.is_purchase_unit || 0),
    is_sales_unit: Number(row.is_sales_unit || 0),
    price: row.price === null || row.price === undefined ? null : Number(row.price)
  };
}

// Attach each product's configured unit conversions (multi-unit pricing).
async function attachUnits(rows) {
  if (!rows.length) return rows;
  const [unitRows] = await pool.query(
    'SELECT id, product_id, unit, label, multiplier_to_base, is_default, is_purchase_unit, is_sales_unit, price FROM product_units ORDER BY product_id, id'
  );
  const byProduct = new Map();
  unitRows.forEach((u) => {
    if (!byProduct.has(u.product_id)) byProduct.set(u.product_id, []);
    byProduct.get(u.product_id).push(normalizeUnitRow(u));
  });
  rows.forEach((p) => { p.units = byProduct.get(p.id) || []; });
  return rows;
}

// Replace a product's unit conversions. Marks the unit matching the base
// unit (or the first row) as the default one. Multiple units with the same
// name are allowed (e.g., different pack sizes).
async function replaceUnits(conn, productId, baseUnit, units) {
  await conn.query('DELETE FROM product_units WHERE product_id = ?', [productId]);
  if (!Array.isArray(units)) return;
  const defaultKey = String(baseUnit || '').trim().toLowerCase();
  let defaultAssigned = false;
  let firstInsertedId = null;
  for (const u of units) {
    const unitName = String(u.unit || '').trim();
    const multiplier = Number(u.multiplier_to_base);
    if (!unitName || !isFinite(multiplier) || multiplier <= 0) continue;
    const key = unitName.toLowerCase();
    const price = u.price === undefined || u.price === null || u.price === '' ? null : Number(u.price);
    const [result] = await conn.query(
      `INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default, is_purchase_unit, is_sales_unit, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productId, unitName, u.label || null, multiplier, 0, u.is_purchase_unit !== 0 ? 1 : 0, u.is_sales_unit !== 0 ? 1 : 0, price]
    );
    if (firstInsertedId === null) firstInsertedId = result.insertId;
    if (!defaultAssigned && key === defaultKey) {
      defaultAssigned = true;
      await conn.query('UPDATE product_units SET is_default = 1 WHERE id = ?', [result.insertId]);
    }
  }
  if (!defaultAssigned && firstInsertedId !== null) {
    await conn.query('UPDATE product_units SET is_default = 1 WHERE id = ?', [firstInsertedId]);
  }
}

exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ORDER BY p.created_at DESC`
    );
    await attachUnits(rows);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Product not found' });
    await attachUnits(rows);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch product' });
  }
};

// GET /products/:id/batches — return FIFO batch rows for a product.
// Supports ?spoiled=true to return only aged/spoiled batches.
exports.getBatches = async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ message: 'Invalid product id' });
  try {
    const hasTable = await pool.hasTable
      ? pool.hasTable('inventory_batches')
      : false;
    if (!hasTable) {
      return res.json([]);
    }
    // shelf_life_days column may not exist on older databases; default to 5 days.
    let shelfLife = 5;
    try {
      const [productRows] = await pool.query('SELECT shelf_life_days FROM products WHERE id = ?', [productId]);
      shelfLife = Number(productRows[0]?.shelf_life_days) || 5;
    } catch (_) {
      // Column missing — leave shelfLife at default 5.
    }

    const showSpoiled = req.query.spoiled === 'true';
    let where = 'WHERE product_id = ? AND quantity > 0';
    const params = [productId];
    if (showSpoiled) {
      where += ' AND purchase_date <= DATE_SUB(CURDATE(), INTERVAL ? DAY)';
      params.push(shelfLife);
    }
    where += ' ORDER BY purchase_date ASC, id ASC';

    const [rows] = await pool.query(
      `SELECT id, product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base, created_at FROM inventory_batches ${where}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch batches' });
  }
};

exports.create = async (req, res) => {
  try {
    const { sku, name, category_id, unit, base_unit, price, cost, costPrice, stock_quantity, low_stock_threshold, status, supplier_name, image_url, units } = req.body;
    if (image_url && image_url.length > 4 * 1024 * 1024) {
      return res.status(413).json({ message: 'Image is too large. Please use a photo smaller than 2 MB.' });
    }
    if (!sku) return res.status(400).json({ message: 'SKU is required' });
    if (!name) return res.status(400).json({ message: 'Product name is required' });
    if (!category_id) return res.status(400).json({ message: 'Category is required' });
    if (!base_unit && !unit) return res.status(400).json({ message: 'Unit is required' });
    if (price === undefined || price === '') return res.status(400).json({ message: 'Retail price per kilogram is required' });
    if (Number(price) < 0) return res.status(400).json({ message: 'Retail price per kilogram must be zero or greater' });
    if (Number(costPrice !== undefined ? costPrice : cost) < 0) return res.status(400).json({ message: 'Cost price must be zero or greater' });
    if (stock_quantity === undefined || stock_quantity === '') return res.status(400).json({ message: 'Stock quantity is required' });
    const baseUnit = base_unit || unit || 'kg';
    // The frontend sends "costPrice" = TOTAL paid for the purchase; the DB
    // convention (also used by reports for profit) is products.cost = cost PER
    // BASE UNIT. Convert: per-kg = total / initial stock (base units).
    // On create there is no existing stock yet, so divide by the new row's
    // initial stock; when that is 0/empty the total is already per-unit.
    const stockNum = Number(stock_quantity);
    const rawTotal = costPrice !== undefined && costPrice !== null && costPrice !== '' ? Number(costPrice) : (cost || 0);
    const costValue = (Number.isFinite(stockNum) && stockNum > 0 && Number.isFinite(rawTotal))
      ? Math.round((rawTotal / stockNum) * 100) / 100
      : rawTotal;
    const conn = await pool.getConnection();
    let productId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO products (sku, name, category_id, base_unit, unit, price, cost, stock_quantity, low_stock_threshold, status, supplier_name, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sku || null, name, category_id || null, baseUnit, baseUnit, price, costValue, stock_quantity || 0, low_stock_threshold || 10, status || 'active', supplier_name || null, image_url || null]
      );
      productId = result.insertId;
      await replaceUnits(conn, productId, baseUnit, units);
      if (stockNum > 0) {
        await conn.query(
          'INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES (?, NULL, CURRENT_DATE, ?, ?, ?)',
          [productId, stockNum, stockNum, costValue]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.status(201).json({ id: productId, message: 'Product created successfully' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') return res.status(409).json({ message: 'SKU already exists' });
    // A data-URL image that does not fit products.image_url (old VARCHAR(255)
    // installs) surfaces as 22001 (Postgres) / ER_DATA_TOO_LONG (MySQL).
    // Report it as 413 with an actionable message instead of a bare 500.
    // Fix the column itself with:
    //   PostgreSQL: ALTER TABLE products ALTER COLUMN image_url TYPE TEXT;
    //   MySQL:      ALTER TABLE products MODIFY image_url MEDIUMTEXT NULL;
    if (err.code === '22001' || err.code === 'ER_DATA_TOO_LONG' || /value too long|data too long/i.test(err.message || '')) {
      return res.status(413).json({ message: 'Image is too large for the database. Please use a smaller photo, then ask an admin to expand products.image_url to TEXT/MEDIUMTEXT.' });
    }
    res.status(500).json({ message: 'Failed to create product' });
  }
};

exports.update = async (req, res) => {
  const { sku, name, category_id, unit, base_unit, price, cost, costPrice, stock_quantity, low_stock_threshold, status, supplier_name, image_url, units } = req.body;
  if (image_url && image_url.length > 4 * 1024 * 1024) {
    return res.status(413).json({ message: 'Image is too large. Please use a photo smaller than 2 MB.' });
  }
  try {
    if (!sku) return res.status(400).json({ message: 'SKU is required' });
    if (!name) return res.status(400).json({ message: 'Product name is required' });
    if (!category_id) return res.status(400).json({ message: 'Category is required' });
    if (!unit && !base_unit) return res.status(400).json({ message: 'Unit is required' });
    if (price === undefined || price === '') return res.status(400).json({ message: 'Retail price per kilogram is required' });
    if (Number(price) < 0) return res.status(400).json({ message: 'Retail price per kilogram must be zero or greater' });
    if (Number(costPrice !== undefined ? costPrice : cost) < 0) return res.status(400).json({ message: 'Cost price must be zero or greater' });
    const baseUnit = base_unit || unit || 'kg';
    // The edit form sends the "Cost Price" TOTAL (for the user's reference);
    // products.cost must stay cost PER BASE UNIT, so never overwrite it with
    // the raw total. Convert: per-kg = total / current stock (base units).
    // When the row has no stock (or the field is blank) there is no new cost
    // information — keep the stored per-kg cost instead of zeroing it.
    // (Postgres adapter returns rows directly, not [[row]] — handle both.)
    const conn = await pool.getConnection();
    let currentRow = null;
    try {
      const [foundRows] = await conn.query('SELECT cost, stock_quantity FROM products WHERE id = ?', [req.params.id]);
      currentRow = Array.isArray(foundRows) ? foundRows[0] : foundRows;
    } catch (preErr) {
      // If the pre-read fails, fall through and let the UPDATE's
      // affectedRows check report a missing product; do not leak the error.
      currentRow = null;
    }
    if (!currentRow) { conn.release(); return res.status(404).json({ message: 'Product not found' }); }
    const currentStock = Number(currentRow.stock_quantity);
    const rawEditTotal = costPrice !== undefined && costPrice !== null && costPrice !== '' ? Number(costPrice) : null;
    let costValue = Number(currentRow.cost) || 0;
    if (rawEditTotal !== null && Number.isFinite(rawEditTotal) && rawEditTotal >= 0 && Number.isFinite(currentStock) && currentStock > 0) {
      costValue = Math.round((rawEditTotal / currentStock) * 100) / 100;
    }
    let saved;
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE products SET sku=?, name=?, category_id=?, unit=?, base_unit=?, price=?, cost=?, low_stock_threshold=?, status=?, supplier_name=?, image_url=? WHERE id=?`,
        [sku || null, name, category_id || null, baseUnit, baseUnit, price, costValue, low_stock_threshold || 10, status || 'active', supplier_name || null, image_url || null, req.params.id]
      );
      // Only a client that sent the units array is editing units; older clients
      // (that omit the key) keep their existing conversions untouched.
      if (Array.isArray(units)) {
        await replaceUnits(conn, req.params.id, baseUnit, units);
      }
      await conn.commit();
      saved = result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    if (saved.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product updated successfully' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') return res.status(409).json({ message: 'SKU already exists' });
    if (err.code === '22001' || err.code === 'ER_DATA_TOO_LONG' || /value too long|data too long/i.test(err.message || '')) {
      return res.status(413).json({ message: 'Image is too large for the database. Please use a smaller photo, then ask an admin to expand products.image_url to TEXT/MEDIUMTEXT.' });
    }
    res.status(500).json({ message: 'Failed to update product' });
  }
};

exports.remove = async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete product' });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM categories ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch categories' });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    const [result] = await pool.query('INSERT INTO categories (name, description) VALUES (?, ?)', [name, description || null]);
    res.status(201).json({ id: result.insertId, message: 'Category created successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Category already exists' });
    res.status(500).json({ message: 'Failed to create category' });
  }
};

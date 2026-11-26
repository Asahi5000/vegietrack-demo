const pool = require('../config/db');

const VALID_PERIODS = ['daily', 'weekly', 'monthly', 'annual'];
const OPERATING_EXPENSE_FIELDS = ['food', 'internet', 'water', 'electricity', 'store_materials', 'other'];

// Returns the SQL GROUP BY expression and date-range condition for a given period.
function rangeForPeriod(period, column) {
  if (period === 'weekly') {
    return { groupExpr: `DATE_FORMAT(${column}, '%x-W%v')`, rangeCondition: `${column} >= DATE_SUB(CURDATE(), INTERVAL 8 WEEK)` };
  }
  if (period === 'monthly') {
    return { groupExpr: `DATE_FORMAT(${column}, '%Y-%m')`, rangeCondition: `${column} >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)` };
  }
  if (period === 'annual') {
    return { groupExpr: `YEAR(${column})`, rangeCondition: `${column} >= DATE_SUB(CURDATE(), INTERVAL 5 YEAR)` };
  }
  return { groupExpr: `DATE(${column})`, rangeCondition: `${column} >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)` };
}

// Per-transaction profit for report/chart queries: what the customer actually
// paid for the items (line_total, i.e. qty x unit price in the SELLING unit)
// minus cost per base unit x base units sold (base_quantity, i.e. qty x
// multiplier_to_base), minus the transaction-level discount (the customer pays
// subtotal − discount, so the discount must come out of the margin to reflect
// real profit).
// Example the user reported: sell 1 pack (= 10 kg) for 1200, discount 10,
// cost 100/kg -> profit = 1200 − 10×100 − 10 = 190. The old formula mixed
// units (selling-unit qty x (selling-unit price − per-kg cost)) and produced
// 1×(1200−100) − 10 = 1090.
// ti.cost_price is the product cost captured when the line was recorded;
// reading it (instead of the current products.cost) keeps the profit of past
// sales stable when a product is restocked or edited afterwards. Rows written
// before the column existed fall back to products.cost.
// Rows written before base_quantity/conversion_rate existed (or NULL) fall
// back to quantity x conversion_rate (defaulting the rate to 1).
// Restock transactions also store item lines (at purchase cost), so only 'sale'
// transactions count. Items whose product no longer exists contribute nothing
// (cost is NULL → the row is skipped by SUM). MAX(ts.discount) keeps the query
// valid under ONLY_FULL_GROUP_BY/PostgreSQL because discount is constant per
// transaction group.
const PROFIT_JOIN_SQL = `
  LEFT JOIN (
    SELECT ti.transaction_id,
           SUM(ti.line_total - COALESCE(ti.cost_price, p.cost) * COALESCE(ti.base_quantity, ti.quantity * COALESCE(ti.conversion_rate, 1))) - COALESCE(MAX(ts.discount), 0) AS profit
    FROM transaction_items ti
    LEFT JOIN products p ON ti.product_id = p.id
    JOIN transactions ts ON ts.id = ti.transaction_id AND ts.transaction_type = 'sale'
    GROUP BY ti.transaction_id
  ) pr ON pr.transaction_id = t.id
`;

// Profit is an owner/manager figure: cashier accounts never receive it. These helpers
// return an empty join (and a NULL aggregate) for cashiers so the response carries no
// cost data at all.
const showProfitFor = (user) => user.role !== 'cashier';
const profitJoinFor = (showProfit) => (showProfit ? PROFIT_JOIN_SQL : '');
const profitAggregateFor = (showProfit) => (showProfit ? 'COALESCE(SUM(pr.profit),0)' : 'NULL');

// Dashboard summary: today's sales, total products, low stock count, recent transactions
exports.dashboard = async (req, res) => {
  try {
    const salesPeriod = VALID_PERIODS.includes(req.query.sales_period) ? req.query.sales_period : 'daily';
    const topProductsPeriod = VALID_PERIODS.includes(req.query.top_products_period) ? req.query.top_products_period : 'daily';
    const cashierFilter = req.user.role === 'cashier' ? ' AND user_id = ?' : '';
    const cashierParams = req.user.role === 'cashier' ? [req.user.id] : [];
    const showProfit = showProfitFor(req.user);
    const profitJoin = profitJoinFor(showProfit);
    const profitAggregate = profitAggregateFor(showProfit);

    const [[todaySales]] = await pool.query(
      `SELECT COALESCE(SUM(t.total),0) AS total_sales, COUNT(*) AS total_transactions, ${profitAggregate} AS total_profit
       FROM transactions t ${profitJoin}
       WHERE DATE(t.created_at) = CURDATE() AND t.status = 'completed' AND t.transaction_type = 'sale'${cashierFilter}`,
      cashierParams
    );
    const [[monthSales]] = await pool.query(
      `SELECT COALESCE(SUM(t.total),0) AS total_sales
       FROM transactions t WHERE MONTH(t.created_at) = MONTH(CURDATE()) AND YEAR(t.created_at) = YEAR(CURDATE()) AND t.status = 'completed' AND t.transaction_type = 'sale'${cashierFilter}`,
      cashierParams
    );
    const [[productStats]] = await pool.query(
      `SELECT COUNT(*) AS total_products, SUM(CASE WHEN stock_quantity <= low_stock_threshold THEN 1 ELSE 0 END) AS low_stock_count
       FROM products WHERE status = 'active' OR stock_quantity <= 0`
    );

    // Stock notifications: every product whose quantity has reached or
    // passed its low-stock threshold. Inactive products whose stock has hit
    // zero are included too (flagged "out_of_stock") so they never silently
    // disappear from alerts. Items at zero are "out_of_stock" (red alert)
    // while the rest are "low_stock" (amber alert).
    const [stockAlerts] = await pool.query(
      `SELECT id AS product_id, name, stock_quantity, low_stock_threshold, base_unit AS unit,
              CASE
                WHEN stock_quantity <= 0 THEN 'out_of_stock'
                ELSE 'low_stock'
              END AS type
       FROM products
       WHERE (status = 'active' AND stock_quantity <= low_stock_threshold) OR stock_quantity <= 0
       ORDER BY stock_quantity ASC, id ASC
       LIMIT 20`
    );
    const notifications = stockAlerts.map((row) =>
      row.type === 'out_of_stock'
        ? {
            type: 'out_of_stock',
            product_id: row.product_id,
            message: `Out of stock: ${row.name}`,
          }
        : {
            type: 'low_stock',
            product_id: row.product_id,
            message: `Low stock: ${row.name} (${row.stock_quantity} ${row.unit} remaining)`,
          }
        );

    const [recentTransactions] = await pool.query(
      `SELECT t.id, t.invoice_no, t.customer_name, t.total, t.payment_method, t.created_at
       FROM transactions t WHERE t.status='completed' AND t.transaction_type='sale'${req.user.role === 'cashier' ? ' AND t.user_id = ?' : ''} ORDER BY t.created_at DESC LIMIT 8`,
      cashierParams
    );

    const salesRange = rangeForPeriod(salesPeriod, 't.created_at');
    const [salesTrend] = await pool.query(
      `SELECT ${salesRange.groupExpr} AS date, SUM(t.total) AS total, ${profitAggregate} AS profit
       FROM transactions t ${profitJoin}
       WHERE t.status='completed' AND t.transaction_type='sale' AND ${salesRange.rangeCondition}${cashierFilter}
       GROUP BY ${salesRange.groupExpr} ORDER BY MIN(t.created_at) ASC`
      ,
      cashierParams
    );

    const topProductsRange = rangeForPeriod(topProductsPeriod, 't.created_at');
    const [topProducts] = await pool.query(
      `SELECT ti.product_name, SUM(ti.quantity) AS total_qty, SUM(COALESCE(ti.line_total * (1 - COALESCE(t.discount, 0) / NULLIF(t.subtotal, 0)), ti.line_total)) AS total_revenue
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       WHERE t.status='completed' AND t.transaction_type='sale' AND ${topProductsRange.rangeCondition}${req.user.role === 'cashier' ? ' AND t.user_id = ?' : ''}
       GROUP BY ti.product_name ORDER BY total_revenue DESC LIMIT 5`,
      cashierParams
    );

    // FIFO batch spoilage: batches aged 5+ days with remaining stock.
    let spoiledCount = 0;
    let spoiledNotifications = [];
    if (showProfit) {
      try {
        const [spoiledStats] = await pool.query(
          `SELECT COUNT(*) AS spoiled_count
           FROM inventory_batches ib JOIN products p ON p.id = ib.product_id
           WHERE ib.quantity > 0
             AND ib.purchase_date <= DATE_SUB(CURDATE(), INTERVAL 5 DAY)`
        );
        spoiledCount = spoiledStats[0]?.spoiled_count || 0;
        const [spoiledAlerts] = await pool.query(
          `SELECT p.id AS product_id, p.name, p.base_unit AS unit,
                  SUM(ib.quantity) AS remaining_quantity,
                  MIN(ib.purchase_date) AS oldest_purchase_date
           FROM inventory_batches ib JOIN products p ON p.id = ib.product_id
           WHERE ib.quantity > 0
             AND ib.purchase_date <= DATE_SUB(CURDATE(), INTERVAL 5 DAY)
           GROUP BY p.id, p.name, p.base_unit
           ORDER BY oldest_purchase_date ASC, p.name ASC
           LIMIT 10`
        );
        spoiledNotifications = spoiledAlerts.map((row) => ({
          type: 'spoiled',
          product_id: row.product_id,
          message: `Spoiled alert: ${row.name} has ${Number(row.remaining_quantity)} ${row.unit} of stock aged 5+ days`,
        }));
      } catch (e) {
        // inventory_batches may not exist on legacy databases
      }
    }

    res.json({
      today_sales: todaySales.total_sales,
      today_transactions: todaySales.total_transactions,
      today_profit: showProfit ? todaySales.total_profit : null,
      month_sales: monthSales.total_sales,
      total_products: productStats.total_products || 0,
      low_stock_count: productStats.low_stock_count || 0,
      spoiled_count: showProfit ? spoiledCount : 0,
      notifications,
      spoiled_notifications: showProfit ? spoiledNotifications : [],
      recent_transactions: recentTransactions,
      sales_last_7_days: showProfit ? salesTrend : salesTrend.map((row) => ({ ...row, profit: null })),
      top_products: topProducts
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch dashboard data' });
  }
};

// Reports & analytics: sales, operating expenses, and separate spoilage loss.
exports.salesReport = async (req, res) => {
  try {
    const { from, to, q } = req.query;
    const params = [];
    const showProfit = showProfitFor(req.user);
    const profitJoin = profitJoinFor(showProfit);
    const profitAggregate = profitAggregateFor(showProfit);
    // Supplier/restock transactions are purchases, not sales — exclude them from all sales figures
    let dateFilter = ' AND t.transaction_type = \'sale\'';
    if (req.user.role === 'cashier') dateFilter += ' AND t.user_id = ?';
    if (req.user.role === 'cashier') params.push(req.user.id);
    if (from) { dateFilter += ' AND t.created_at >= ?'; params.push(from); }
    if (to) { dateFilter += ' AND t.created_at <= ?'; params.push(to); }
    // Same invoice/customer search behavior as the Transaction History page
    if (q) { dateFilter += ' AND (t.invoice_no LIKE ? OR t.customer_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

    const [salesByDate] = await pool.query(
      `SELECT DATE(t.created_at) AS date, SUM(t.total) AS total, COUNT(*) AS count, ${profitAggregate} AS profit
       FROM transactions t ${profitJoin}
       WHERE t.status='completed' ${dateFilter}
       GROUP BY DATE(t.created_at) ORDER BY date ASC`,
      params
    );

    // Sales by Category: the transaction-level discount is prorated across the
    // item lines by their share of the pre-discount subtotal (t.subtotal equals
    // the sum of the transaction's line totals), so categories add up to the
    // discounted total instead of the pre-discount subtotal. NULLIF guards
    // against a zero subtotal (division would otherwise wipe out the row).
    const [salesByCategory] = await pool.query(
      `SELECT c.name AS category,
              SUM(ti.line_total * (1 - COALESCE(t.discount, 0) / NULLIF(t.subtotal, 0))) AS total
       FROM transaction_items ti
       JOIN transactions t ON ti.transaction_id = t.id
       LEFT JOIN products p ON ti.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE t.status='completed' ${dateFilter}
       GROUP BY c.name ORDER BY total DESC`,
      params
    );

    const [salesByPayment] = await pool.query(
      `SELECT payment_method, SUM(total) AS total, COUNT(*) AS count
       FROM transactions t WHERE status='completed' ${dateFilter}
       GROUP BY payment_method`,
      params
    );

    const [[totals]] = await pool.query(
      `SELECT COALESCE(SUM(t.total),0) AS grand_total, COUNT(*) AS total_transactions, ${profitAggregate} AS total_profit
       FROM transactions t ${profitJoin}
       WHERE t.status='completed' ${dateFilter}`,
      params
    );

    if (!showProfit) {
      totals.total_profit = null;
      salesByDate.forEach((row) => { row.profit = null; });
    }

    let financials = null;
    let spoiledProducts = [];
    let financialByDate = [];

    if (showProfit) {
      const dateFilterFor = (column) => {
        const clauses = [];
        const values = [];
        if (from) { clauses.push(`${column} >= ?`); values.push(from); }
        if (to) { clauses.push(`${column} <= ?`); values.push(to); }
        return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params: values };
      };
      const transactionDateFilter = dateFilterFor('created_at');
      const spoiledDateFilter = dateFilterFor('sp.created_at');

      const payrollRange = [];
      const payrollParams = [];
      if (from) { payrollRange.push('period >= ?'); payrollParams.push(String(from).slice(0, 10)); }
      if (to) { payrollRange.push('period <= ?'); payrollParams.push(String(to).slice(0, 10)); }
      const payrollDateFilter = payrollRange.length ? ` WHERE ${payrollRange.join(' AND ')}` : '';
      const operatingExpenseRange = [];
      const operatingExpenseParams = [];
      if (from) { operatingExpenseRange.push('expense_date >= ?'); operatingExpenseParams.push(String(from).slice(0, 10)); }
      if (to) { operatingExpenseRange.push('expense_date <= ?'); operatingExpenseParams.push(String(to).slice(0, 10)); }
      const operatingExpenseDateFilter = operatingExpenseRange.length
        ? ` AND ${operatingExpenseRange.join(' AND ')}`
        : '';

      // Spoilage is intentionally excluded from expenses; it is reported and
      // deducted separately so each loss affects net profit exactly once.
      const [expenseTotals] = await pool.query(
        `SELECT COALESCE(SUM(total), 0) AS total
         FROM transactions
         WHERE status = 'completed' AND transaction_type = 'restock'${transactionDateFilter.sql}`,
        transactionDateFilter.params
      );
      const [[payrollTotals]] = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM payrolls${payrollDateFilter}`,
        payrollParams
      );
      const [operatingExpenseTotals] = await pool.query(
        `SELECT COALESCE(SUM(food + internet + water + electricity + store_materials + other), 0) AS total
         FROM operating_expenses
         WHERE 1=1${operatingExpenseDateFilter}`,
        operatingExpenseParams
      );
      const [spoiledTotals] = await pool.query(
        `SELECT COALESCE(SUM(sp.total_loss), 0) AS total_loss,
                COALESCE(SUM(sp.quantity), 0) AS total_quantity
         FROM spoiled_products sp
         WHERE 1=1${spoiledDateFilter.sql}`,
        spoiledDateFilter.params
      );
      const [spoiledRows] = await pool.query(
        `SELECT sp.id, DATE_FORMAT(sp.created_at, '%Y-%m-%d') AS spoiled_date, p.name AS product_name,
                sp.batch_id, DATE_FORMAT(ib.purchase_date, '%Y-%m-%d') AS batch_purchase_date,
                sp.quantity, sp.purchase_cost_per_unit AS cost_price,
                sp.total_loss, sp.reason
         FROM spoiled_products sp
         LEFT JOIN products p ON p.id = sp.product_id
         LEFT JOIN inventory_batches ib ON ib.id = sp.batch_id
         WHERE 1=1${spoiledDateFilter.sql}
         ORDER BY sp.created_at DESC, sp.id DESC`,
        spoiledDateFilter.params
      );
      const [restockByDate] = await pool.query(
        `SELECT DATE(created_at) AS date, COALESCE(SUM(total), 0) AS amount
         FROM transactions
         WHERE status = 'completed' AND transaction_type = 'restock'${transactionDateFilter.sql}
         GROUP BY DATE(created_at)`,
        transactionDateFilter.params
      );
      const [payrollByDate] = await pool.query(
        `SELECT period AS date, COALESCE(SUM(amount), 0) AS amount
         FROM payrolls${payrollDateFilter}
         GROUP BY period`,
        payrollParams
      );
      const [operatingExpensesByDate] = await pool.query(
        `SELECT expense_date AS date,
                COALESCE(SUM(food + internet + water + electricity + store_materials + other), 0) AS amount
         FROM operating_expenses
         WHERE 1=1${operatingExpenseDateFilter}
         GROUP BY expense_date`,
        operatingExpenseParams
      );
      const [spoiledByDate] = await pool.query(
        `SELECT DATE(sp.created_at) AS date, COALESCE(SUM(sp.total_loss), 0) AS spoiled_loss,
                COALESCE(SUM(sp.quantity), 0) AS spoiled_quantity
         FROM spoiled_products sp
         WHERE 1=1${spoiledDateFilter.sql}
         GROUP BY DATE(sp.created_at)`,
        spoiledDateFilter.params
      );

      const daily = new Map();
      const getDay = (date) => {
        const key = date instanceof Date
          ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          : String(date).slice(0, 10);
        if (!daily.has(key)) daily.set(key, { date: key, income: 0, expenses: 0, spoiled_loss: 0, spoiled_quantity: 0 });
        return daily.get(key);
      };
      salesByDate.forEach((row) => { getDay(row.date).income += Number(row.total) || 0; });
      restockByDate.forEach((row) => { getDay(row.date).expenses += Number(row.amount) || 0; });
      payrollByDate.forEach((row) => { getDay(row.date).expenses += Number(row.amount) || 0; });
      operatingExpensesByDate.forEach((row) => { getDay(row.date).expenses += Number(row.amount) || 0; });
      spoiledByDate.forEach((row) => {
        const day = getDay(row.date);
        day.spoiled_loss += Number(row.spoiled_loss) || 0;
        day.spoiled_quantity += Number(row.spoiled_quantity) || 0;
      });
      financialByDate = [...daily.values()]
        .map((day) => ({ ...day, net_profit: day.income - day.expenses - day.spoiled_loss }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const income = Number(totals.grand_total) || 0;
      const expenses = (Number(expenseTotals[0]?.total) || 0)
        + (Number(payrollTotals?.total) || 0)
        + (Number(operatingExpenseTotals[0]?.total) || 0);
      const spoiledLoss = Number(spoiledTotals[0]?.total_loss) || 0;
      financials = {
        total_income: income,
        total_expenses: expenses,
        total_spoiled_loss: spoiledLoss,
        total_spoiled_quantity: Number(spoiledTotals[0]?.total_quantity) || 0,
        net_profit: income - expenses - spoiledLoss,
      };
      spoiledProducts = spoiledRows;
    }

    res.json({
      sales_by_date: salesByDate,
      sales_by_category: salesByCategory,
      sales_by_payment: salesByPayment,
      financial_by_date: financialByDate,
      spoiled_products: spoiledProducts,
      financials,
      totals,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch sales report' });
  }
};

exports.createExpense = async (req, res) => {
  const validated = validateOperatingExpense(req.body);
  if (validated.error) return res.status(400).json({ message: validated.error });
  try {
    await pool.query(
      `INSERT INTO operating_expenses
       (expense_date, food, internet, water, electricity, store_materials, other, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [validated.expenseDate, ...validated.values, req.user.id]
    );
    res.status(201).json({ message: 'Expenses recorded successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to record expenses' });
  }
};

function validateOperatingExpense(body) {
  const { expense_date, ...amounts } = body || {};
  if (typeof expense_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
    return { error: 'A valid expense date is required' };
  }
  const parsedDate = new Date(`${expense_date}T00:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== expense_date) {
    return { error: 'A valid expense date is required' };
  }

  const values = [];
  for (const field of OPERATING_EXPENSE_FIELDS) {
    const amount = amounts[field];
    if (amount === '' || amount === null || amount === undefined || typeof amount === 'boolean') {
      return { error: `A non-negative ${field.replace('_', ' ')} amount is required` };
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0 || numericAmount > 99999999.99) {
      return { error: `A non-negative ${field.replace('_', ' ')} amount is required` };
    }
    values.push(numericAmount);
  }
  return { expenseDate: expense_date, values };
}

exports.getExpenses = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, expense_date, food, internet, water, electricity, store_materials, other, created_at
       FROM operating_expenses
       ORDER BY expense_date DESC, id DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch expenses' });
  }
};

exports.updateExpense = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid expense record' });
  }
  const validated = validateOperatingExpense(req.body);
  if (validated.error) return res.status(400).json({ message: validated.error });

  try {
    const [existing] = await pool.query('SELECT id FROM operating_expenses WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ message: 'Expense record not found' });
    await pool.query(
      `UPDATE operating_expenses
       SET expense_date = ?, food = ?, internet = ?, water = ?, electricity = ?, store_materials = ?, other = ?
       WHERE id = ?`,
      [validated.expenseDate, ...validated.values, id]
    );
    res.json({ message: 'Expenses updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update expenses' });
  }
};

exports.deleteExpense = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid expense record' });
  }

  try {
    const [result] = await pool.query('DELETE FROM operating_expenses WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Expense record not found' });
    res.json({ message: 'Expenses deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete expenses' });
  }
};

exports.inventoryReport = async (req, res) => {
  try {
    if (req.user.role === 'cashier') return res.status(403).json({ message: 'Inventory reports are not available for cashier accounts' });
    const [rows] = await pool.query(
      `SELECT p.id, p.name, c.name AS category_name, p.stock_quantity, p.low_stock_threshold, p.price,
              (p.stock_quantity * p.cost) AS stock_value
       FROM products p LEFT JOIN categories c ON p.category_id = c.id
       ORDER BY p.stock_quantity ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch inventory report' });
  }
};
// POST /api/spoiled-products — record a stock write-off for spoiled produce.
//
// The write-off is atomic: the product's aggregate stock, the FIFO batch
// quantity and the spoiled_products audit row are all updated inside a
// single transaction so the numbers can never drift apart. Every query in
// the transaction runs on the SAME connection (`conn.query`), not on the
// pool — using the pool inside a transaction would run those statements on
// a different connection and they would not be part of the transaction.
exports.recordSpoiledProduct = async (req, res) => {
  let conn;
  let inTransaction = false;
  try {
    conn = await pool.getConnection();
    const { product_id, batch_id, quantity, reason } = req.body || {};

    const productId = Number(product_id);
    const qty = Number(quantity);
    const hasBatchId = batch_id !== undefined && batch_id !== null && batch_id !== '';
    const batchId = hasBatchId ? Number(batch_id) : null;

    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ message: 'A valid product is required' });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ message: 'A valid quantity greater than 0 is required' });
    }
    if (hasBatchId && (!Number.isInteger(batchId) || batchId <= 0)) {
      return res.status(400).json({ message: 'A valid purchase batch is required' });
    }
    if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 255)) {
      return res.status(400).json({ message: 'Reason must be 255 characters or fewer' });
    }

    await conn.beginTransaction();
    inTransaction = true;

    // Lock the product and selected batch before validating or deducting stock.
    const [productRows] = await conn.query(
      'SELECT id, stock_quantity, cost FROM products WHERE id = ? FOR UPDATE',
      [productId]
    );
    const product = productRows[0];
    if (!product) {
      await conn.rollback();
      inTransaction = false;
      return res.status(404).json({ message: 'Product not found' });
    }

    let batch = null;
    if (hasBatchId) {
      const [batchRows] = await conn.query(
        'SELECT id, product_id, quantity, cost_per_base FROM inventory_batches WHERE id = ? AND product_id = ? FOR UPDATE',
        [batchId, productId]
      );
      batch = batchRows[0];
      if (!batch) {
        await conn.rollback();
        inTransaction = false;
        return res.status(404).json({ message: 'Purchase batch not found for this product' });
      }
      const currentBatchQty = Number(batch.quantity) || 0;
      if (currentBatchQty < qty) {
        await conn.rollback();
        inTransaction = false;
        return res.status(409).json({
          message: `Insufficient batch stock. Available: ${currentBatchQty}, Requested: ${qty}`,
        });
      }
    }

    const availableStock = Number(product.stock_quantity) || 0;
    if (availableStock < qty) {
      await conn.rollback();
      inTransaction = false;
      return res.status(409).json({
        message: `Insufficient stock. Available: ${availableStock}, Requested: ${qty}`,
      });
    }

    // Prefer the selected batch's historical purchase cost; fall back to the
    // product cost only for legacy batches without a recorded unit cost.
    const batchCost = batch?.cost_per_base;
    const costPerUnit = batchCost !== null && batchCost !== undefined
      ? Number(batchCost)
      : Number(product.cost) || 0;
    const totalLoss = Math.round(qty * costPerUnit * 100) / 100;

    if (batch) {
      await conn.query(
        'UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ?',
        [qty, batchId]
      );
    }
    await conn.query(
      'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?',
      [qty, productId]
    );

    const [result] = await conn.query(
      `INSERT INTO spoiled_products (product_id, batch_id, quantity, reason, purchase_cost_per_unit, total_loss, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [productId, batch ? batchId : null, qty, reason || null, costPerUnit, totalLoss, req.user?.id || null]
    );

    await conn.commit();
    inTransaction = false;

    res.json({
      message: 'Product marked as spoiled successfully',
      spoiledProductId: result?.insertId || 0,
      productId,
      quantity: qty,
      totalLoss,
      remainingStock: availableStock - qty,
    });
  } catch (err) {
    if (inTransaction) {
      try {
        await conn.rollback();
        inTransaction = false;
      } catch (rollbackErr) {
        console.error('Error rolling back spoiled product transaction:', rollbackErr.message);
      }
    }
    console.error('Error recording spoiled product:', err);
    res.status(500).json({ message: 'Failed to record spoiled product' });
  } finally {
    if (conn) conn.release();
  }
};

exports.deleteSpoiledProduct = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid spoiled product record' });
  }

  try {
    const [result] = await pool.query('DELETE FROM spoiled_products WHERE id = ?', [id]);
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Spoiled product record not found' });
    }
    res.json({ message: 'Spoiled product record deleted successfully' });
  } catch (err) {
    console.error('Error deleting spoiled product record:', err);
    res.status(500).json({ message: 'Failed to delete spoiled product record' });
  }
};

exports.updateSpoiledProduct = async (req, res) => {
  const id = Number(req.params.id);
  const quantity = Number(req.body?.quantity);
  const { reason } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid spoiled product record' });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'A valid quantity greater than 0 is required' });
  }
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 255)) {
    return res.status(400).json({ message: 'Reason must be 255 characters or fewer' });
  }

  let conn;
  let inTransaction = false;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    inTransaction = true;

    const [recordRows] = await conn.query(
      'SELECT id, product_id, batch_id, quantity, purchase_cost_per_unit FROM spoiled_products WHERE id = ? FOR UPDATE',
      [id]
    );
    const record = recordRows[0];
    if (!record) {
      await conn.rollback();
      inTransaction = false;
      return res.status(404).json({ message: 'Spoiled product record not found' });
    }

    const [productRows] = await conn.query(
      'SELECT id, stock_quantity FROM products WHERE id = ? FOR UPDATE',
      [record.product_id]
    );
    const product = productRows[0];
    if (!product) {
      await conn.rollback();
      inTransaction = false;
      return res.status(404).json({ message: 'Product not found' });
    }

    let batch = null;
    if (record.batch_id) {
      const [batchRows] = await conn.query(
        'SELECT id, quantity FROM inventory_batches WHERE id = ? AND product_id = ? FOR UPDATE',
        [record.batch_id, record.product_id]
      );
      batch = batchRows[0];
      if (!batch) {
        await conn.rollback();
        inTransaction = false;
        return res.status(409).json({ message: 'The purchase batch for this spoiled-product record is no longer available' });
      }
    }

    const quantityDelta = quantity - Number(record.quantity);
    if (quantityDelta > 0) {
      const availableStock = Number(product.stock_quantity) || 0;
      if (availableStock < quantityDelta) {
        await conn.rollback();
        inTransaction = false;
        return res.status(409).json({
          message: `Insufficient stock. Available: ${availableStock}, Additional requested: ${quantityDelta}`,
        });
      }
      if (batch && Number(batch.quantity) < quantityDelta) {
        await conn.rollback();
        inTransaction = false;
        return res.status(409).json({
          message: `Insufficient batch stock. Available: ${Number(batch.quantity) || 0}, Additional requested: ${quantityDelta}`,
        });
      }
    }

    if (quantityDelta !== 0) {
      await conn.query(
        'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?',
        [quantityDelta, record.product_id]
      );
      if (batch) {
        await conn.query(
          'UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ?',
          [quantityDelta, record.batch_id]
        );
      }
    }

    const costPerUnit = Number(record.purchase_cost_per_unit) || 0;
    const totalLoss = Math.round(quantity * costPerUnit * 100) / 100;
    await conn.query(
      'UPDATE spoiled_products SET quantity = ?, reason = ?, total_loss = ? WHERE id = ?',
      [quantity, reason || null, totalLoss, id]
    );

    await conn.commit();
    inTransaction = false;
    res.json({ message: 'Spoiled product record updated successfully', quantity, totalLoss });
  } catch (err) {
    if (inTransaction) {
      try {
        await conn.rollback();
        inTransaction = false;
      } catch (rollbackErr) {
        console.error('Error rolling back spoiled product update:', rollbackErr.message);
      }
    }
    console.error('Error updating spoiled product record:', err);
    res.status(500).json({ message: 'Failed to update spoiled product record' });
  } finally {
    if (conn) conn.release();
  }
};

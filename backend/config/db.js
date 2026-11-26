// Database access layer.
//
// This portfolio copy accepts demo-only connection variables so production
// credentials in a shared host environment cannot select the database.
const { Pool } = require('pg');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Strips surrounding whitespace/quotes that are easy to paste into a hosting
// dashboard by accident (e.g. VALUE="db.example.com" instead of db.example.com).
function clean(value) {
  if (value === undefined || value === null) return undefined;
  let v = String(value).trim();
  if (
    v.length > 1 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v === '' ? undefined : v;
}

function firstDefined(...values) {
  for (const value of values) {
    const v = clean(value);
    if (v !== undefined) return v;
  }
  return undefined;
}

function isLocalHost(value) {
  return !value || ['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'mysql'].includes(value);
}

const connectionString = firstDefined(process.env.DEMO_DATABASE_URL);

const isPgUrl = connectionString ? /^postgres(ql)?:\/\//i.test(connectionString) : false;
const isMysqlUrl = connectionString ? /^mysql:\/\//i.test(connectionString) : false;

const host = firstDefined(process.env.DEMO_DB_HOST);
const port = firstDefined(process.env.DEMO_DB_PORT);
const user = firstDefined(process.env.DEMO_DB_USER);
const password = firstDefined(process.env.DEMO_DB_PASSWORD);
const database = firstDefined(process.env.DEMO_DB_NAME);

// Vercel/Netlify/Lambda set these; used to detect missing configuration.
const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.VERCEL_ENV ||
  process.env.NETLIFY ||
  process.env.AWS_LAMBDA_FUNCTION_NAME
);

const isPg = Boolean(
  isPgUrl ||
  process.env.DEMO_DB_DRIVER === 'postgres' ||
  (host && /(supabase|pooler|neon|postgres)/i.test(host)) ||
  port === '5432' ||
  port === '6543'
);

const hasConfig = Boolean(connectionString || (database && host && user));

// Safe, password-free summary of the active connection (used by /api/health/db).
function describeConnection() {
  return {
    driver: isPg ? 'postgres' : 'mysql',
    host: host || null,
    port: Number(port || (isPg ? 6543 : 3306)),
    database: database || null,
    user: user || null,
    passwordSet: Boolean(password),
    ssl: isPg ? !isLocalHost(host) : false,
    connectionStringUsed: Boolean(isPgUrl || isMysqlUrl),
    serverless: isServerless
  };
}

// ---------------------------------------------------------------------------
// MySQL → PostgreSQL SQL translation helpers
//
// The same controller SQL is used for local XAMPP/MySQL development and the
// Vercel production deployment (Supabase/PostgreSQL).  MySQL has several
// date-function and upsert syntaxes that PostgreSQL does not understand.
// These helpers rewrite those MySQL constructs so the controllers can stay
// database-agnostic.
// ---------------------------------------------------------------------------

// Translate a MySQL DATE_FORMAT format string to a PostgreSQL TO_CHAR
// format string.  Only the specifiers used by this codebase are mapped;
// anything else is quoted as literal text.
function translateMysqlDateFormat(fmt) {
  let pgFmt = '';
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '%' && i + 1 < fmt.length) {
      const spec = fmt[i + 1];
      switch (spec) {
        case 'x': pgFmt += 'IYYY'; i += 2; break;    // ISO year (week-based)
        case 'v': pgFmt += 'IW'; i += 2; break;       // ISO week of year (01-53)
        case 'Y': pgFmt += 'YYYY'; i += 2; break;     // 4-digit year
        case 'm': pgFmt += 'MM'; i += 2; break;       // 2-digit month
        case 'd': pgFmt += 'DD'; i += 2; break;       // 2-digit day
        case 'H': pgFmt += 'HH24'; i += 2; break;     // 24-hour hour
        case 'i': pgFmt += 'MI'; i += 2; break;       // minutes
        case 's': pgFmt += 'SS'; i += 2; break;       // seconds
        default: pgFmt += '"' + spec + '"'; i += 2; break;
      }
    } else {
      const c = fmt[i];
      // PostgreSQL TO_CHAR treats any letter as a potential format specifier.
      // Wrap literal characters in double-quotes so they are emitted verbatim.
      if (/[a-zA-Z]/.test(c)) {
        pgFmt += '"' + c + '"';
      } else {
        pgFmt += c;
      }
      i++;
    }
  }
  return pgFmt;
}

// Rewrite MySQL-specific SQL constructs so they are valid PostgreSQL.
function translateMysqlToPostgres(sql) {
  return sql
    // DATE_FORMAT(col, 'fmt') → TO_CHAR(col, 'pg_fmt')
    .replace(/DATE_FORMAT\(([^,]+),\s*'([^']*)'\)/gi, (_m, col, fmt) => {
      return `TO_CHAR(${col.trim()}, '${translateMysqlDateFormat(fmt)}')`;
    })
    // DATE_SUB(col, INTERVAL n unit) → (col) - INTERVAL 'n unit'
    .replace(/DATE_SUB\(([^,]+),\s*INTERVAL\s+(\d+)\s+(DAY|WEEK|MONTH|YEAR)\)/gi,
      "($1) - INTERVAL '$2 $3'")
    // CURDATE() → CURRENT_DATE
    .replace(/\bCURDATE\(\)/gi, 'CURRENT_DATE')
    // MONTH(col) → EXTRACT(MONTH FROM col)
    .replace(/\bMONTH\(([^)]+)\)/gi, 'EXTRACT(MONTH FROM $1)')
    // YEAR(col) → EXTRACT(YEAR FROM col)
    .replace(/\bYEAR\(([^)]+)\)/gi, 'EXTRACT(YEAR FROM $1)')
        // DATE(col) → col::DATE  (MySQL function-cast syntax)
    .replace(/\bDATE\(([^)]+)\)/gi, '$1::DATE')
    // ON DUPLICATE KEY UPDATE col = VALUES(col) →
    // ON CONFLICT DO UPDATE SET col = EXCLUDED.col
    .replace(/ON DUPLICATE KEY UPDATE\s+(\w+)\s*=\s*VALUES\((\w+)\)/gi,
      'ON CONFLICT DO UPDATE SET $1 = EXCLUDED.$2');
}

let configError = null;

if (!hasConfig) {
  configError = new Error(
    'Demo database is not configured. Set DEMO_DATABASE_URL or DEMO_DB_HOST, ' +
      'DEMO_DB_USER and DEMO_DB_NAME. Generic production database variables are ignored.'
  );
  configError.code = 'ECONFIG';
}

if (isPg) {
  // Supabase (and most managed PostgreSQL) require SSL; local servers usually do not.
  const sslEnabled = !isLocalHost(host) || /sslmode=(require|verify)/i.test(connectionString || '');

  const poolOptions = isPgUrl
    ? { connectionString, ssl: sslEnabled ? { rejectUnauthorized: false } : false }
    : {
        host: host || 'localhost',
        port: parseInt(port || '6543', 10),
        user,
        password,
        database: database || 'postgres',
        ssl: sslEnabled ? { rejectUnauthorized: false } : false
      };

  // A serverless instance serves one request at a time, so a single pooled
  // connection per instance keeps us well inside the Supabase connection limit.
  const pgPool = new Pool({ ...poolOptions, max: isServerless ? 1 : 10 });

  // Postgres returns NUMERIC/DECIMAL and BIGINT (e.g. COUNT(*)) values as
  // strings. The MySQL pool is configured with decimalNumbers: true, so the
  // controllers/frontend expect real numbers — match that behaviour globally.
  const pgModule = require('pg');
  pgModule.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // NUMERIC/DECIMAL
  pgModule.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));  // BIGINT

  // Per-table metadata (cached): does the table have an `id` column, and which
  // column(s) form its primary key? Needed to (a) only append "RETURNING id"
  // where an id column actually exists and (b) give MySQL's
  // "ON DUPLICATE KEY UPDATE" translation an explicit conflict target, which
  // PostgreSQL requires (MySQL infers it from any unique key). Unknown tables
  // resolve to the defaults so the original SQL surfaces its own error.
  const pgTableInfoCache = new Map();
  async function pgTableInfo(table, run) {
    if (!pgTableInfoCache.has(table)) {
      const info = { hasId: false, pk: '' };
      try {
        const res = await run(
          `SELECT
             COALESCE((
               SELECT string_agg('"' || kcu.column_name || '"', ', ' ORDER BY kcu.ordinal_position)
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.constraint_schema = tc.constraint_schema
                AND kcu.table_name = tc.table_name
               WHERE tc.table_schema = current_schema()
                 AND tc.table_name = $1
                 AND tc.constraint_type = 'PRIMARY KEY'
             ), '') AS pk_cols,
             EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema()
                 AND table_name = $1
                 AND column_name = 'id'
             ) AS has_id`,
          [table]
        );
        if (res.rows[0]) {
          info.pk = res.rows[0].pk_cols || '';
          info.hasId = Boolean(res.rows[0].has_id);
        }
      } catch (err) {
        // Metadata lookup failure is not fatal; the actual query reports real errors.
      }
      pgTableInfoCache.set(table, info);
    }
    return pgTableInfoCache.get(table);
  }

  // Rewrites controller SQL (MySQL dialect + `?` placeholders) for PostgreSQL.
  // `executor` is the query runner used for metadata lookups — pass the checked
  // out transaction client when building SQL inside getConnection(), otherwise
  // the pgPool.query metadata lookup deadlocks waiting for the only pooled
  // connection (max: 1 in serverless) which getConnection already holds.
  async function buildPgSql(sql, executor) {
    const run = executor || ((q, p) => pgPool.query(q, p));
    let paramIndex = 1;
    let pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

    pgSql = translateMysqlToPostgres(pgSql)
      .replace(/IFNULL\(/gi, 'COALESCE(')
      .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP');

    const insertMatch = pgSql.match(/^\s*INSERT\s+INTO\s+["`]?(\w+)["`]?/i);
    if (insertMatch) {
      const info = await pgTableInfo(insertMatch[1], run);
      // MySQL infers the conflict from any unique key; PostgreSQL needs the
      // target spelled out — use the table's primary key.
      if (/ON CONFLICT DO UPDATE/i.test(pgSql) && info.pk) {
        pgSql = pgSql.replace(/ON CONFLICT DO UPDATE/i, `ON CONFLICT (${info.pk}) DO UPDATE`);
      }
      if (!/RETURNING/i.test(pgSql) && info.hasId) {
        pgSql += ' RETURNING id';
      }
    }
    return pgSql;
  }

    const adapter = {
    async query(sql, params = []) {
      if (configError) throw configError;

      const pgSql = await buildPgSql(sql);

      try {
        const res = await pgPool.query(pgSql, params);
        if (/^\s*INSERT\s+INTO/i.test(pgSql)) {
          const insertId = res.rows[0]?.id || 0;
          return [{ insertId, affectedRows: res.rowCount }, res.fields];
        } else if (/^\s*(UPDATE|DELETE)\s/i.test(pgSql)) {
          return [{ affectedRows: res.rowCount }, res.fields];
        } else {
          return [res.rows, res.fields];
        }
      } catch (err) {
        console.error('PostgreSQL Query Error:', err.message, 'SQL:', pgSql);
        throw err;
      }
    },
    async getConnection() {
      if (configError) throw configError;
      const client = await pgPool.connect();
      return {
        async query(sql, params = []) {
          if (configError) throw configError;
          const pgSql = await buildPgSql(sql, (q, p) => client.query(q, p));
          const res = await client.query(pgSql, params);
          if (/^\s*INSERT\s+INTO/i.test(pgSql)) {
            return [{ insertId: res.rows[0]?.id || 0, affectedRows: res.rowCount }, res.fields];
          } else if (/^\s*(UPDATE|DELETE)\s/i.test(pgSql)) {
            return [{ affectedRows: res.rowCount }, res.fields];
          } else {
            return [res.rows, res.fields];
          }
        },
        release() {
          client.release();
        },
        async beginTransaction() {
          await client.query('BEGIN');
        },
        async commit() {
          await client.query('COMMIT');
        },
        async rollback() {
          await client.query('ROLLBACK');
        }
      };
    }
  };

  adapter.describeConnection = describeConnection;
  adapter.hasTable = async function(table) {
    const res = await pgPool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = current_schema()",
      [table]
    );
    return res.rows.length > 0;
  };
  adapter.ensureInventoryBatchSchema = async function() {
    try {
      const cols = await this.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND table_schema = current_schema() AND column_name = 'shelf_life_days'");
      if (cols.length === 0) {
        await this.query('ALTER TABLE products ADD COLUMN shelf_life_days INT NOT NULL DEFAULT 5');
      }
      const exists = await this.hasTable('inventory_batches');
      if (!exists) {
        await this.query(`
          CREATE TABLE inventory_batches (
            id SERIAL PRIMARY KEY,
            product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            transaction_id INT DEFAULT NULL REFERENCES transactions(id) ON DELETE SET NULL,
            purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
            quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
            original_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
            cost_per_base DECIMAL(10,4) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`,
        );
        const [rows] = await this.query('SELECT id, stock_quantity, cost FROM products WHERE stock_quantity > 0');
        for (const row of rows) {
          const qty = Number(row.stock_quantity);
          if (qty > 0) {
            await this.query(
              'INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES ($1, NULL, CURRENT_DATE, $2, $2, $3)',
              [row.id, qty, Number(row.cost) || 0]
            );
          }
        }
      }
      // Spoiled-product write-off audit table (created lazily on deploy).
      if (!(await this.hasTable('spoiled_products'))) {
        await this.query(`
          CREATE TABLE spoiled_products (
            id SERIAL PRIMARY KEY,
            product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            batch_id INT DEFAULT NULL REFERENCES inventory_batches(id) ON DELETE SET NULL,
            quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
            reason VARCHAR(255) DEFAULT NULL,
            purchase_cost_per_unit DECIMAL(10,2) NOT NULL DEFAULT 0,
            total_loss DECIMAL(10,2) NOT NULL DEFAULT 0,
            created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`
        );
      } else {
        await this.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS batch_id INT DEFAULT NULL');
        await this.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS purchase_cost_per_unit DECIMAL(10,2) NOT NULL DEFAULT 0');
        await this.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS total_loss DECIMAL(10,2) NOT NULL DEFAULT 0');
        await this.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS created_by INT DEFAULT NULL');
      }
    } catch (err) {
      console.error('ensureInventoryBatchSchema (PostgreSQL) failed:', err.message);
    }
  };
  module.exports = adapter;
} else {
  // MySQL for local demo development.
  const pool = isMysqlUrl
    ? mysql.createPool(connectionString)
    : mysql.createPool({
        host: host || 'localhost',
        user,
        password: password || '',
        database,
        port: parseInt(port || '3306', 10),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        decimalNumbers: true
      });

  module.exports = {
    async query(sql, params) {
      if (configError) throw configError;
      return pool.query(sql, params);
    },
    async execute(sql, params) {
      if (configError) throw configError;
      return pool.execute(sql, params);
    },
    async getConnection() {
      if (configError) throw configError;
      return pool.getConnection();
    },
    async end() {
      return pool.end();
    },
    describeConnection,
    async hasTable(table) {
      const [rows] = await pool.query('SHOW TABLES LIKE ?', [table]);
      return rows.length > 0;
    },
    async ensureInventoryBatchSchema() {
      try {
        const [cols] = await pool.query("SHOW COLUMNS FROM products LIKE 'shelf_life_days'");
        if (cols.length === 0) {
          await pool.query('ALTER TABLE products ADD COLUMN shelf_life_days INT NOT NULL DEFAULT 5');
        }
        const [tables] = await pool.query("SHOW TABLES LIKE 'inventory_batches'");
        if (tables.length === 0) {
          await pool.query(`
            CREATE TABLE inventory_batches (
              id INT AUTO_INCREMENT PRIMARY KEY,
              product_id INT NOT NULL,
              transaction_id INT DEFAULT NULL,
              purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
              quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
              original_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
              cost_per_base DECIMAL(10,4) DEFAULT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
              FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
          `);
        }
        // Seed FIFO batches for every product that has stock but no batch rows yet.
        // Runs on every startup so existing products are covered even when the
        // table was created before this migration was added.
        const [rows] = await pool.query(
          `SELECT p.id, p.stock_quantity, p.cost
           FROM products p
           LEFT JOIN inventory_batches b ON b.product_id = p.id
           WHERE p.stock_quantity > 0 AND b.id IS NULL`
        );
        if (rows.length) {
          for (const row of rows) {
            const qty = Number(row.stock_quantity);
            if (qty > 0) {
              await pool.query(
                'INSERT INTO inventory_batches (product_id, transaction_id, purchase_date, quantity, original_quantity, cost_per_base) VALUES (?, NULL, CURRENT_DATE, ?, ?, ?)',
                [row.id, qty, qty, Number(row.cost) || 0]
              );
            }
          }
        }
        // Spoiled-product write-off audit table (created lazily on deploy).
        const [spoiledTables] = await pool.query("SHOW TABLES LIKE 'spoiled_products'");
        if (spoiledTables.length === 0) {
          await pool.query(`
            CREATE TABLE spoiled_products (
              id INT AUTO_INCREMENT PRIMARY KEY,
              product_id INT NOT NULL,
              batch_id INT DEFAULT NULL,
              quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
              reason VARCHAR(255) DEFAULT NULL,
              purchase_cost_per_unit DECIMAL(10,2) NOT NULL DEFAULT 0,
              total_loss DECIMAL(10,2) NOT NULL DEFAULT 0,
              created_by INT DEFAULT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
              FOREIGN KEY (batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL,
              FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            )
          `);
        } else {
          await pool.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS batch_id INT DEFAULT NULL');
          await pool.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS purchase_cost_per_unit DECIMAL(10,2) NOT NULL DEFAULT 0');
          await pool.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS total_loss DECIMAL(10,2) NOT NULL DEFAULT 0');
          await pool.query('ALTER TABLE spoiled_products ADD COLUMN IF NOT EXISTS created_by INT DEFAULT NULL');
        }
      } catch (err) {
        console.error('ensureInventoryBatchSchema (MySQL) failed:', err.message);
      }
    }
  };
}

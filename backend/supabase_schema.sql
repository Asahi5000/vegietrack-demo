-- VegieTrack Database Schema for Supabase (PostgreSQL)
-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard)

-- ============================
-- 1. Create Tables
-- ============================

-- Users Table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) DEFAULT NULL,
  email VARCHAR(100) DEFAULT NULL,
  gmail_app_password VARCHAR(16) DEFAULT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin', 'manager', 'cashier')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  payroll DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Categories Table
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Products Table
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE,
  name VARCHAR(150) NOT NULL,
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  base_unit VARCHAR(20) DEFAULT 'kg',
  unit VARCHAR(20) DEFAULT 'kg',
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  stock_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  low_stock_threshold DECIMAL(10,4) NOT NULL DEFAULT 10,
  supplier_name VARCHAR(150) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- image_url holds base64 data-URLs (can be hundreds of KB), so it must be TEXT.
-- VARCHAR(255) only worked on MySQL in non-strict mode; PostgreSQL rejects the
-- insert with 22001 (value too long).
image_url TEXT DEFAULT NULL,
  shelf_life_days INT NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Product Units Table (Multi-unit conversion)
-- Multiple units with the same name are allowed per product.
CREATE TABLE IF NOT EXISTS product_units (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit VARCHAR(20) NOT NULL,
  label VARCHAR(50) DEFAULT NULL,
  multiplier_to_base DECIMAL(10,6) NOT NULL DEFAULT 1,
  is_default SMALLINT DEFAULT 0,
  is_purchase_unit SMALLINT DEFAULT 1,
  is_sales_unit SMALLINT DEFAULT 1,
  price DECIMAL(10,2) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  invoice_no VARCHAR(50) NOT NULL UNIQUE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  customer_name VARCHAR(100) DEFAULT 'Walk-in Customer',
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax DECIMAL(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'gcash', 'other')),
  transaction_type VARCHAR(20) NOT NULL DEFAULT 'sale' CHECK (transaction_type IN ('sale', 'restock')),
  supplier_name VARCHAR(150) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded', 'voided')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Transaction Items Table
CREATE TABLE IF NOT EXISTS transaction_items (
  id SERIAL PRIMARY KEY,
  transaction_id INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(150) NOT NULL,
  quantity DECIMAL(10,4) NOT NULL,
  unit VARCHAR(20) DEFAULT NULL,
  conversion_rate DECIMAL(10,6) DEFAULT 1,
  base_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  cost_price DECIMAL(10,4) DEFAULT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  line_total DECIMAL(10,2) NOT NULL
);

-- Password Resets Table
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Inventory Batches (FIFO batch-level tracking)
CREATE TABLE IF NOT EXISTS inventory_batches (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL,
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  original_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  cost_per_base DECIMAL(10,4) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Spoiled Products (write-offs)
-- Audit trail for stock written off because it spoiled. Records the loss
-- using the purchase cost at write-off time so reports stay accurate even
-- after the product's cost changes later.
CREATE TABLE IF NOT EXISTS spoiled_products (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_id INT DEFAULT NULL REFERENCES inventory_batches(id) ON DELETE SET NULL,
  quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  reason VARCHAR(255) DEFAULT NULL,
  purchase_cost_per_unit DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_loss DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Payrolls Table
CREATE TABLE IF NOT EXISTS payrolls (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period VARCHAR(10) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_user_period UNIQUE (user_id, period)
);

-- Operating expenses
CREATE TABLE IF NOT EXISTS operating_expenses (
  id SERIAL PRIMARY KEY,
  expense_date DATE NOT NULL,
  food DECIMAL(10,2) NOT NULL DEFAULT 0,
  internet DECIMAL(10,2) NOT NULL DEFAULT 0,
  water DECIMAL(10,2) NOT NULL DEFAULT 0,
  electricity DECIMAL(10,2) NOT NULL DEFAULT 0,
  store_materials DECIMAL(10,2) NOT NULL DEFAULT 0,
  other DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Settings Table
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ============================
-- 2. Triggers for Auto-updating updated_at
-- ============================
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = CURRENT_TIMESTAMP;
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE OR REPLACE TRIGGER update_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

CREATE OR REPLACE TRIGGER update_settings_updated_at
BEFORE UPDATE ON settings
FOR EACH ROW EXECUTE FUNCTION update_timestamp_column();

-- ============================
-- 3. Seed Default Data
-- ============================

-- Demo identities are only used by server-issued demo sessions. Their
-- passwords intentionally cannot be used for normal password login.
INSERT INTO users (username, password, full_name, email, role, status)
VALUES
('demo', '!demo-login-only!', 'Portfolio Demo Admin', NULL, 'admin', 'active'),
('maya.manager', '!demo-login-only!', 'Maya Santos', NULL, 'manager', 'active'),
('leo.cashier', '!demo-login-only!', 'Leo Reyes', NULL, 'cashier', 'active'),
('nina.cashier', '!demo-login-only!', 'Nina Cruz', NULL, 'cashier', 'active')
ON CONFLICT (username) DO NOTHING;

-- Default Categories
INSERT INTO categories (name, description) VALUES
('Leafy Greens', 'Fresh leafy greens and salad vegetables'),
('Root Vegetables', 'Fresh root and bulb vegetables'),
('Tubers', 'Root crops grown underground as starchy tubers'),
('Bulb Vegetables', 'Vegetables that grow as layered edible bulbs'),
('Stem Vegetables', 'Vegetables grown for their edible stems and leaves'),
('Flower Vegetables', 'Vegetables harvested from the flower or flower buds of the plant'),
('Fruit Vegetables', 'Vegetables harvested for their fruits'),
('Seed and Pod Vegetables', 'Vegetables grown for their edible seeds or pods'),
('Fungi', 'Edible mushrooms and fungi'),
('Others', 'Other produce that does not fit standard categories')
ON CONFLICT (name) DO NOTHING;

-- Default Products
INSERT INTO products (sku, name, category_id, base_unit, unit, price, cost, stock_quantity, low_stock_threshold, status) VALUES
('VEG-001', 'Spinach', (SELECT id FROM categories WHERE name='Leafy Greens'), 'kg', 'kg', 85.00, 55.00, 25, 8, 'active'),
('VEG-003', 'Carrots', (SELECT id FROM categories WHERE name='Root Vegetables'), 'kg', 'kg', 95.00, 60.00, 30, 8, 'active'),
('VEG-008', 'Potato', (SELECT id FROM categories WHERE name='Tubers'), 'kg', 'kg', 60.00, 35.00, 40, 10, 'active'),
('VEG-011', 'Garlic', (SELECT id FROM categories WHERE name='Bulb Vegetables'), 'kg', 'kg', 150.00, 100.00, 20, 6, 'active'),
('VEG-006', 'Basil', (SELECT id FROM categories WHERE name='Stem Vegetables'), 'kg', 'kg', 180.00, 110.00, 12, 5, 'active'),
('VEG-012', 'Broccoli', (SELECT id FROM categories WHERE name='Flower Vegetables'), 'kg', 'kg', 130.00, 85.00, 15, 5, 'active'),
('VEG-004', 'Tomatoes', (SELECT id FROM categories WHERE name='Fruit Vegetables'), 'kg', 'kg', 110.00, 70.00, 22, 7, 'active'),
('VEG-013', 'Green Beans', (SELECT id FROM categories WHERE name='Seed and Pod Vegetables'), 'kg', 'kg', 90.00, 55.00, 18, 6, 'active'),
('VEG-014', 'Mushroom', (SELECT id FROM categories WHERE name='Fungi'), 'kg', 'kg', 160.00, 110.00, 10, 4, 'active'),
('VEG-015', 'Ginger', (SELECT id FROM categories WHERE name='Others'), 'kg', 'kg', 140.00, 90.00, 12, 5, 'active')
ON CONFLICT (sku) DO NOTHING;

-- Default Product Units (Conversions)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default)
SELECT seed.product_id, seed.unit, seed.label, seed.multiplier_to_base, seed.is_default
FROM (VALUES
((SELECT id FROM products WHERE sku='VEG-001'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-001'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-001'), 'pack', 'Pack (500g)', 0.5, 0),

((SELECT id FROM products WHERE sku='VEG-003'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-003'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-003'), 'bundle', 'Bundle (1kg)', 1, 0),

((SELECT id FROM products WHERE sku='VEG-008'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-008'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-008'), 'sack', 'Sack (50kg)', 50, 0),

((SELECT id FROM products WHERE sku='VEG-011'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-011'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-011'), 'pack', 'Pack (500g)', 0.5, 0),

((SELECT id FROM products WHERE sku='VEG-006'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-006'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-006'), 'pack', 'Pack (250g)', 0.25, 0),

((SELECT id FROM products WHERE sku='VEG-012'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-012'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-012'), 'pcs', 'Piece (~500g)', 0.5, 0),

((SELECT id FROM products WHERE sku='VEG-004'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-004'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-004'), 'pack', 'Pack (1kg)', 1, 0),

((SELECT id FROM products WHERE sku='VEG-013'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-013'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-013'), 'bundle', 'Bundle (500g)', 0.5, 0),

((SELECT id FROM products WHERE sku='VEG-014'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-014'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-014'), 'pack', 'Pack (250g)', 0.25, 0),

((SELECT id FROM products WHERE sku='VEG-015'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-015'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-015'), 'pack', 'Pack (500g)', 0.5, 0)
) AS seed(product_id, unit, label, multiplier_to_base, is_default)
WHERE NOT EXISTS (
  SELECT 1
  FROM product_units existing
  WHERE existing.product_id = seed.product_id
    AND existing.unit = seed.unit
    AND existing.label IS NOT DISTINCT FROM seed.label
    AND existing.multiplier_to_base = seed.multiplier_to_base
    AND existing.is_default IS NOT DISTINCT FROM seed.is_default
);

-- Settings
INSERT INTO settings (setting_key, setting_value) VALUES
('store_name', 'Green Basket Market'),
('store_address', '18 Orchard Lane, San Isidro'),
('currency', 'PHP'),
('tax_rate', '0')
ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;


-- ============================================================
-- MIGRATION: Drop UNIQUE constraint to allow multiple same units
-- ============================================================
ALTER TABLE product_units DROP CONSTRAINT IF EXISTS unique_product_unit;

UPDATE products SET supplier_name = 'Sunrise Valley Growers' WHERE sku IN ('VEG-001', 'VEG-006', 'VEG-013');
UPDATE products SET supplier_name = 'Harvest Moon Produce Co.' WHERE sku IN ('VEG-003', 'VEG-004', 'VEG-008');
UPDATE products SET supplier_name = 'Cedar Hill Farm' WHERE sku IN ('VEG-011', 'VEG-012', 'VEG-014', 'VEG-015');

INSERT INTO transactions (invoice_no, user_id, customer_name, subtotal, total, payment_method, transaction_type, status, created_at) VALUES
('DEMO-2026-001', (SELECT id FROM users WHERE username = 'leo.cashier'), 'Ari Mercado', 170.00, 170.00, 'cash', 'sale', 'completed', CURRENT_TIMESTAMP - INTERVAL '1 day'),
('DEMO-2026-002', (SELECT id FROM users WHERE username = 'nina.cashier'), 'Sam Rivera', 165.00, 165.00, 'gcash', 'sale', 'completed', CURRENT_TIMESTAMP - INTERVAL '2 days'),
('DEMO-2026-003', (SELECT id FROM users WHERE username = 'leo.cashier'), 'Walk-in Customer', 42.50, 42.50, 'cash', 'sale', 'completed', CURRENT_TIMESTAMP - INTERVAL '3 days')
ON CONFLICT (invoice_no) DO NOTHING;

INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit, conversion_rate, base_quantity, cost_price, unit_price, line_total)
SELECT t.id, p.id, p.name, 2, 'kg', 1, 2, 55, 85, 170
FROM transactions t JOIN products p ON p.sku = 'VEG-001'
WHERE t.invoice_no = 'DEMO-2026-001'
  AND NOT EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id AND i.product_id = p.id);
INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit, conversion_rate, base_quantity, cost_price, unit_price, line_total)
SELECT t.id, p.id, p.name, 1.5, 'kg', 1, 1.5, 70, 110, 165
FROM transactions t JOIN products p ON p.sku = 'VEG-004'
WHERE t.invoice_no = 'DEMO-2026-002'
  AND NOT EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id AND i.product_id = p.id);
INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit, conversion_rate, base_quantity, cost_price, unit_price, line_total)
SELECT t.id, p.id, p.name, 1, 'pack', 0.5, 0.5, 55, 42.5, 42.5
FROM transactions t JOIN products p ON p.sku = 'VEG-001'
WHERE t.invoice_no = 'DEMO-2026-003'
  AND NOT EXISTS (SELECT 1 FROM transaction_items i WHERE i.transaction_id = t.id AND i.product_id = p.id);

INSERT INTO inventory_batches (product_id, purchase_date, quantity, original_quantity, cost_per_base)
SELECT p.id, CURRENT_DATE, p.stock_quantity, p.stock_quantity, p.cost
FROM products p
WHERE p.stock_quantity > 0
  AND NOT EXISTS (SELECT 1 FROM inventory_batches b WHERE b.product_id = p.id);

INSERT INTO operating_expenses (expense_date, food, internet, water, electricity, store_materials, other)
SELECT CURRENT_DATE - INTERVAL '1 day', 420, 1200, 350, 2400, 680, 150
WHERE NOT EXISTS (SELECT 1 FROM operating_expenses WHERE expense_date = CURRENT_DATE - INTERVAL '1 day');

-- Browser clients never access Supabase directly. Enable RLS without public
-- policies so anon/authenticated roles cannot read or modify demo records;
-- the API uses its private, server-only PostgreSQL connection.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spoiled_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operating_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

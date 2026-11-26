-- VegieTrack Database Schema
-- Run this in phpMyAdmin / MySQL to create the database and seed default data.

CREATE DATABASE IF NOT EXISTS vegietrack_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vegietrack_demo;

-- ============================
-- Users
-- ============================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) DEFAULT NULL,
  email VARCHAR(100) DEFAULT NULL,
  gmail_app_password VARCHAR(16) DEFAULT NULL,
  role ENUM('admin','manager','cashier') NOT NULL DEFAULT 'cashier',
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  payroll DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================
-- Categories (e.g. Fish, Meat, Vegetables, Dairy...)
-- ============================
CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================
-- Products (updated with base_unit for multi-unit support)
-- ============================
CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(50) UNIQUE,
  name VARCHAR(150) NOT NULL,
  category_id INT DEFAULT NULL,
  base_unit VARCHAR(20) DEFAULT 'kg', -- Base unit for inventory tracking: kg, g, pcs, etc.
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost DECIMAL(10,2) NOT NULL DEFAULT 0,
  stock_quantity DECIMAL(10,4) NOT NULL DEFAULT 0, -- Stock stored in base_unit
  low_stock_threshold DECIMAL(10,4) NOT NULL DEFAULT 10,
  supplier_name VARCHAR(150) DEFAULT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  image_url MEDIUMTEXT DEFAULT NULL,
  shelf_life_days INT NOT NULL DEFAULT 5, -- Days before a batch is considered spoiled (FIFO tracking)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

-- ============================
-- Product Units (multi-unit conversion table)
-- ============================
-- Each product can have multiple selling/packaging units (e.g., kg, g, pcs, pack, box, sack)
-- multiplier_to_base defines how many base_units are in one selling unit
-- Example: For a product with base_unit='kg':
--   - unit='kg', multiplier_to_base=1 (1 kg = 1 kg)
--   - unit='g', multiplier_to_base=0.001 (1 g = 0.001 kg)
--   - unit='pack', multiplier_to_base=0.5 (1 pack = 0.5 kg)
--   - unit='sack', multiplier_to_base=50 (1 sack = 50 kg)
-- For a product with base_unit='pcs':
--   - unit='pcs', multiplier_to_base=1
--   - unit='pack', multiplier_to_base=10 (1 pack = 10 pcs)
--   - unit='box', multiplier_to_base=100 (1 box = 100 pcs)
CREATE TABLE IF NOT EXISTS product_units (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  unit VARCHAR(20) NOT NULL,
  label VARCHAR(50) DEFAULT NULL, -- Display label (e.g., "Piece", "Pack", "Sack")
  multiplier_to_base DECIMAL(10,6) NOT NULL DEFAULT 1, -- How many base_units in one unit
  is_default TINYINT(1) DEFAULT 0, -- If 1, this is the default selling unit
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_purchase_unit TINYINT(1) DEFAULT 1, -- Can this unit be used for restocking/purchasing
  is_sales_unit TINYINT(1) DEFAULT 1, -- Can this unit be used for selling
  price DECIMAL(10,2) DEFAULT NULL, -- Optional selling price for this specific unit (overrides product price × multiplier)
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  -- Multiple units with the same name are now allowed per product (e.g.,
  -- "bag" in 0.5 kg and 1 kg sizes with different multipliers).
  -- Previously a UNIQUE(product_id, unit) constraint prevented this.
);

-- ============================
-- Transactions (Sales)
-- ============================
CREATE TABLE IF NOT EXISTS transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_no VARCHAR(50) NOT NULL UNIQUE,
  user_id INT DEFAULT NULL,
  customer_name VARCHAR(100) DEFAULT 'Walk-in Customer',
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax DECIMAL(10,2) NOT NULL DEFAULT 0,
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_method ENUM('cash','gcash','other') NOT NULL DEFAULT 'cash',
  transaction_type ENUM('sale','restock') NOT NULL DEFAULT 'sale',
  supplier_name VARCHAR(150) DEFAULT NULL,
  status ENUM('completed','refunded','voided') NOT NULL DEFAULT 'completed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================
-- Transaction Items (updated with unit conversion fields)
-- ============================
CREATE TABLE IF NOT EXISTS transaction_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  product_id INT DEFAULT NULL,
  product_name VARCHAR(150) NOT NULL,
  quantity DECIMAL(10,4) NOT NULL, -- Quantity in the unit selected by user
  unit VARCHAR(20) DEFAULT NULL, -- Unit selected by user (e.g., 'pack', 'sack')
  conversion_rate DECIMAL(10,6) DEFAULT 1, -- multiplier_to_base at time of transaction
  base_quantity DECIMAL(10,4) NOT NULL, -- Quantity converted to base_unit
  cost_price DECIMAL(10,4) DEFAULT NULL, -- Product cost per BASE unit when the line was recorded (freezes sale profit)
  unit_price DECIMAL(10,2) NOT NULL, -- Price per unit (selling unit)
  line_total DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

-- ============================
-- Inventory Batches (FIFO batch-level tracking)
-- ============================
-- Each restock creates one or more batch rows. Sales deduct from the
-- oldest batch first (FIFO), so older stock (closer to spoiling) sells before
-- newer stock. The product's stock_quantity is recalculated from remaining
-- batches after every sale so aggregate and batch-level stock always agree.
CREATE TABLE IF NOT EXISTS inventory_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  transaction_id INT DEFAULT NULL,
  purchase_date DATE NOT NULL DEFAULT (CURRENT_DATE),
  quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  original_quantity DECIMAL(10,4) NOT NULL DEFAULT 0,
  cost_per_base DECIMAL(10,4) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

-- ===========================
-- Spoiled Products (write-offs)
-- ===========================
-- Audit trail for stock that was written off because it spoiled (rotten,
-- bruised, expired...). Each row records how much was lost, the reason and
-- the purchase cost at the time of the write-off so the loss reports stay
-- accurate even after the product's cost changes later.
CREATE TABLE IF NOT EXISTS spoiled_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  batch_id INT DEFAULT NULL,
  quantity DECIMAL(10,4) NOT NULL DEFAULT 0,          -- Quantity in the product's base unit
  reason VARCHAR(255) DEFAULT NULL,
  purchase_cost_per_unit DECIMAL(10,2) NOT NULL DEFAULT 0, -- Cost per base unit at write-off time
  total_loss DECIMAL(10,2) NOT NULL DEFAULT 0,          -- quantity x purchase_cost_per_unit
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ===========================
-- Password Resets
-- ===========================
CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(255) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================
-- Payroll records (managers and cashiers)
-- ============================
CREATE TABLE IF NOT EXISTS payrolls (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  period VARCHAR(10) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_period (user_id, period),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================
-- Operating expenses
-- ============================
CREATE TABLE IF NOT EXISTS operating_expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  expense_date DATE NOT NULL,
  food DECIMAL(10,2) NOT NULL DEFAULT 0,
  internet DECIMAL(10,2) NOT NULL DEFAULT 0,
  water DECIMAL(10,2) NOT NULL DEFAULT 0,
  electricity DECIMAL(10,2) NOT NULL DEFAULT 0,
  store_materials DECIMAL(10,2) NOT NULL DEFAULT 0,
  other DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================
-- Settings (key-value store)
-- ============================
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================
-- Seed data
-- ============================

ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_app_password VARCHAR(16) DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payroll DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20) DEFAULT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(150) DEFAULT NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_type ENUM('sale','restock') NOT NULL DEFAULT 'sale';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(150) DEFAULT NULL;
-- Card payments are not accepted: move any legacy card rows to cash, then drop the enum value
UPDATE transactions SET payment_method = 'cash' WHERE payment_method = 'card';
ALTER TABLE transactions MODIFY payment_method ENUM('cash','gcash','other') NOT NULL DEFAULT 'cash';
-- Payroll is tracked per day now (YYYY-MM-DD); widen legacy month-only columns
ALTER TABLE payrolls MODIFY period VARCHAR(10) NOT NULL;

-- Convert the original sample records when upgrading an existing database.
UPDATE categories SET name = 'Leafy Greens', description = 'Fresh leafy greens and salad vegetables' WHERE name IN ('Fish', 'Leafy Vegetables');
UPDATE categories SET name = 'Root Vegetables', description = 'Fresh root and bulb vegetables' WHERE name = 'Meat';
UPDATE categories SET name = 'Fruit Vegetables', description = 'Vegetables harvested for their fruits' WHERE name IN ('Vegetables', 'Fruiting Vegetables');
UPDATE categories SET name = 'Stem Vegetables', description = 'Vegetables grown for their edible stems and leaves' WHERE name IN ('Dairy', 'Herbs');
UPDATE categories SET name = 'Others', description = 'Other produce that does not fit standard categories' WHERE name IN ('Grocery', 'Organic Vegetables');

-- ============================================================
-- MIGRATION: Add base_unit column and update existing records
-- ============================================================
-- Note: This migration runs on existing databases that already have the 'unit' column.
-- For fresh installs, the CREATE TABLE statement already includes base_unit, so this
-- migration section will be skipped (ADD COLUMN IF NOT EXISTS will do nothing).

-- Add base_unit column if it doesn't exist (for existing databases upgrading from old schema)
ALTER TABLE products ADD COLUMN IF NOT EXISTS base_unit VARCHAR(20) DEFAULT 'kg';

-- Check if the old 'unit' column exists, and if so, copy its values to base_unit
-- This handles the migration from old schema (which had 'unit') to new schema (which has 'base_unit')
SET @has_unit_column = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'unit');
    
SET @update_sql = IF(@has_unit_column > 0, 
    'UPDATE products SET base_unit = unit WHERE base_unit IS NULL OR base_unit = \'\'',
    'SELECT 1'  -- Do nothing if unit column doesn't exist
);
PREPARE stmt FROM @update_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Increase precision of stock_quantity and low_stock_threshold for better decimal handling
ALTER TABLE products MODIFY stock_quantity DECIMAL(10,4) NOT NULL DEFAULT 0;
ALTER TABLE products MODIFY low_stock_threshold DECIMAL(10,4) NOT NULL DEFAULT 10;

-- ============================================================
-- MIGRATION: Create product_units table if it doesn't exist
-- ============================================================
CREATE TABLE IF NOT EXISTS product_units (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  unit VARCHAR(20) NOT NULL,
  label VARCHAR(50) DEFAULT NULL,
  multiplier_to_base DECIMAL(10,6) NOT NULL DEFAULT 1,
  is_default TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  -- Multiple units with the same name are now allowed per product.
);

-- ============================================================
-- MIGRATION: Update transaction_items table for unit conversion
-- ============================================================
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS conversion_rate DECIMAL(10,6) DEFAULT 1;
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS base_quantity DECIMAL(10,4) NOT NULL DEFAULT 0;

-- Populate base_quantity for existing records (quantity * conversion_rate, or just quantity if rate is 1)
-- Using IF() function instead of ternary operator
UPDATE transaction_items SET base_quantity = quantity * IF(conversion_rate IS NOT NULL AND conversion_rate != 0, conversion_rate, 1) WHERE base_quantity = 0;

-- ============================================================
-- MIGRATION: Freeze the cost used for profit inside every sale line
-- ============================================================
-- Reports used to compute profit from products.cost, so restocking a product (which
-- updates products.cost) changed the profit of sales that were already completed.
-- transaction_items.cost_price stores the cost per BASE unit at the time the line was
-- recorded, so past profit only changes when a new sale is made.
ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10,4) DEFAULT NULL;

-- One-time backfill: rebuild the cost of past sales from the latest restock recorded on
-- or before each sale (cost per base unit = line_total / base_quantity), falling back to
-- the product's current cost when there is no restock history.
DROP TEMPORARY TABLE IF EXISTS tmp_sale_cost;
CREATE TEMPORARY TABLE tmp_sale_cost AS
SELECT ti.id item_id,
       (SELECT ROUND(ri.line_total / ri.base_quantity, 4)
        FROM transaction_items ri
        JOIN transactions rt ON rt.id = ri.transaction_id
        WHERE rt.transaction_type = 'restock' AND ri.product_id = ti.product_id
          AND ri.base_quantity > 0 AND rt.created_at <= st.created_at
        ORDER BY rt.created_at DESC, ri.id DESC LIMIT 1) cost_per_base
FROM transaction_items ti
JOIN transactions st ON st.id = ti.transaction_id
WHERE st.transaction_type = 'sale' AND ti.cost_price IS NULL;
ALTER TABLE tmp_sale_cost ADD PRIMARY KEY (item_id);
UPDATE transaction_items ti
JOIN tmp_sale_cost s ON s.item_id = ti.id
LEFT JOIN products p ON p.id = ti.product_id
SET ti.cost_price = COALESCE(s.cost_per_base, p.cost)
WHERE ti.cost_price IS NULL;
DROP TEMPORARY TABLE tmp_sale_cost;

-- Update existing products: add 'unit' column for backward compatibility if it doesn't exist
-- This ensures API responses can include both 'unit' (alias for base_unit) and 'base_unit'
SET @has_unit_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'unit');
    
SET @alter_sql = IF(@has_unit_col = 0,
    'ALTER TABLE products ADD COLUMN unit VARCHAR(20) DEFAULT \'kg\'',
    'SELECT 1'
);
PREPARE stmt2 FROM @alter_sql;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

-- Set unit values to match base_unit for backward compatibility
UPDATE products SET unit = base_unit WHERE unit IS NULL OR unit = '';

-- Update existing product records with new schema values
UPDATE products SET sku='VEG-001', name='Spinach', category_id=(SELECT id FROM categories WHERE name='Leafy Greens'), base_unit='kg', price=85.00, cost=55.00, stock_quantity=25, low_stock_threshold=8 WHERE sku='FSH-001';
UPDATE products SET sku='VEG-002', name='Pechay', category_id=(SELECT id FROM categories WHERE name='Leafy Greens'), base_unit='kg', price=70.00, cost=45.00, stock_quantity=18, low_stock_threshold=6 WHERE sku='FSH-002';
UPDATE products SET sku='VEG-003', name='Carrots', category_id=(SELECT id FROM categories WHERE name='Root Vegetables'), base_unit='kg', price=95.00, cost=60.00, stock_quantity=30, low_stock_threshold=8 WHERE sku='FSH-003';
UPDATE products SET sku='VEG-004', name='Tomatoes', category_id=(SELECT id FROM categories WHERE name='Fruit Vegetables'), base_unit='kg', price=110.00, cost=70.00, stock_quantity=22, low_stock_threshold=7 WHERE sku='MET-001';
UPDATE products SET sku='VEG-005', name='Onions', category_id=(SELECT id FROM categories WHERE name='Root Vegetables'), base_unit='kg', price=120.00, cost=80.00, stock_quantity=35, low_stock_threshold=10 WHERE sku='MET-002';
UPDATE products SET sku='VEG-006', name='Basil', category_id=(SELECT id FROM categories WHERE name='Stem Vegetables'), base_unit='kg', price=180.00, cost=110.00, stock_quantity=12, low_stock_threshold=5 WHERE sku='MET-003';

-- These accounts are only used by the server-issued public demo session.
-- Their passwords intentionally cannot be used for normal password login.
INSERT INTO users (username, password, full_name, email, role, status)
VALUES
('demo', '!demo-login-only!', 'Portfolio Demo Admin', NULL, 'admin', 'active'),
('maya.manager', '!demo-login-only!', 'Maya Santos', NULL, 'manager', 'active'),
('leo.cashier', '!demo-login-only!', 'Leo Reyes', NULL, 'cashier', 'active'),
('nina.cashier', '!demo-login-only!', 'Nina Cruz', NULL, 'cashier', 'active')
ON DUPLICATE KEY UPDATE username = username;

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
ON DUPLICATE KEY UPDATE name = name;

-- Grocery is not a used category in this store; remove it from existing databases
-- (any products still pointing at it keep their rows, with category set to NULL).
DELETE FROM categories WHERE name = 'Grocery';

INSERT INTO products (sku, name, category_id, base_unit, price, cost, stock_quantity, low_stock_threshold, status) VALUES
('VEG-001', 'Spinach', (SELECT id FROM categories WHERE name='Leafy Greens'), 'kg', 85.00, 55.00, 25, 8, 'active'),
('VEG-003', 'Carrots', (SELECT id FROM categories WHERE name='Root Vegetables'), 'kg', 95.00, 60.00, 30, 8, 'active'),
('VEG-008', 'Potato', (SELECT id FROM categories WHERE name='Tubers'), 'kg', 60.00, 35.00, 40, 10, 'active'),
('VEG-011', 'Garlic', (SELECT id FROM categories WHERE name='Bulb Vegetables'), 'kg', 150.00, 100.00, 20, 6, 'active'),
('VEG-006', 'Basil', (SELECT id FROM categories WHERE name='Stem Vegetables'), 'kg', 180.00, 110.00, 12, 5, 'active'),
('VEG-012', 'Broccoli', (SELECT id FROM categories WHERE name='Flower Vegetables'), 'kg', 130.00, 85.00, 15, 5, 'active'),
('VEG-004', 'Tomatoes', (SELECT id FROM categories WHERE name='Fruit Vegetables'), 'kg', 110.00, 70.00, 22, 7, 'active'),
('VEG-013', 'Green Beans', (SELECT id FROM categories WHERE name='Seed and Pod Vegetables'), 'kg', 90.00, 55.00, 18, 6, 'active'),
('VEG-014', 'Mushroom', (SELECT id FROM categories WHERE name='Fungi'), 'kg', 160.00, 110.00, 10, 4, 'active'),
('VEG-015', 'Ginger', (SELECT id FROM categories WHERE name='Others'), 'kg', 140.00, 90.00, 12, 5, 'active')
ON DUPLICATE KEY UPDATE sku = sku;

UPDATE products
SET image_url = CASE sku
  WHEN 'VEG-001' THEN '/images/products/spinach.svg'
  WHEN 'VEG-003' THEN '/images/products/carrots.svg'
  WHEN 'VEG-008' THEN '/images/products/potato.svg'
  WHEN 'VEG-011' THEN '/images/products/garlic.svg'
  WHEN 'VEG-006' THEN '/images/products/basil.svg'
  WHEN 'VEG-012' THEN '/images/products/broccoli.svg'
  WHEN 'VEG-004' THEN '/images/products/tomatoes.svg'
  WHEN 'VEG-013' THEN '/images/products/green-beans.svg'
  WHEN 'VEG-014' THEN '/images/products/mushroom.svg'
  WHEN 'VEG-015' THEN '/images/products/ginger.svg'
END
WHERE sku IN ('VEG-001', 'VEG-003', 'VEG-008', 'VEG-011', 'VEG-006',
              'VEG-012', 'VEG-004', 'VEG-013', 'VEG-014', 'VEG-015')
  AND (image_url IS NULL OR TRIM(image_url) = '');

-- ============================================================
-- Seed data: Product Units (multi-unit conversions)
-- ============================================================
-- For each product, define available selling units and their conversion to base_unit
-- Example: Spinach (base_unit=kg) can be sold by kg, g, or pack (0.5kg per pack)

-- Spinach (VEG-001): kg, g, pack (0.5kg)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-001'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-001'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-001'), 'pack', 'Pack (500g)', 0.5, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Carrots (VEG-003): kg, g, bundle (1kg per bundle)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-003'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-003'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-003'), 'bundle', 'Bundle (1kg)', 1, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Potato (VEG-008): kg, g, sack (50kg per sack)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-008'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-008'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-008'), 'sack', 'Sack (50kg)', 50, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Garlic (VEG-011): kg, g, pack (0.5kg per pack)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-011'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-011'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-011'), 'pack', 'Pack (500g)', 0.5, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Basil (VEG-006): kg, g, pack (0.25kg per pack)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-006'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-006'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-006'), 'pack', 'Pack (250g)', 0.25, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Broccoli (VEG-012): kg, g, piece (approx 0.5kg per piece)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-012'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-012'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-012'), 'pcs', 'Piece (~500g)', 0.5, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Tomatoes (VEG-004): kg, g, pack (1kg per pack)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-004'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-004'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-004'), 'pack', 'Pack (1kg)', 1, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Green Beans (VEG-013): kg, g, bundle (0.5kg per bundle)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-013'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-013'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-013'), 'bundle', 'Bundle (500g)', 0.5, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Mushroom (VEG-014): kg, g, pack (0.25kg per pack)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-014'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-014'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-014'), 'pack', 'Pack (250g)', 0.25, 0)
ON DUPLICATE KEY UPDATE unit = unit;

-- Ginger (VEG-015): kg, g, pack (0.5kg per pack)
INSERT INTO product_units (product_id, unit, label, multiplier_to_base, is_default) VALUES
((SELECT id FROM products WHERE sku='VEG-015'), 'kg', 'Kilogram', 1, 1),
((SELECT id FROM products WHERE sku='VEG-015'), 'g', 'Gram', 0.001, 0),
((SELECT id FROM products WHERE sku='VEG-015'), 'pack', 'Pack (500g)', 0.5, 0)
ON DUPLICATE KEY UPDATE unit = unit;

INSERT INTO settings (setting_key, setting_value) VALUES
('store_name', 'Green Basket Market'),
('store_address', '18 Orchard Lane, San Isidro'),
('currency', 'PHP'),
('tax_rate', '0')
ON DUPLICATE KEY UPDATE setting_value = IF(setting_key = 'currency', 'PHP', setting_value);
 
-- ============================================================ 
-- MIGRATION: Add purchase/sales unit flags to product_units 
-- ============================================================ 
ALTER TABLE product_units ADD COLUMN IF NOT EXISTS is_purchase_unit TINYINT(1) DEFAULT 1 COMMENT 'Can this unit be used for restocking/purchasing'; 
ALTER TABLE product_units ADD COLUMN IF NOT EXISTS is_sales_unit TINYINT(1) DEFAULT 1 COMMENT 'Can this unit be used for selling?'; 


-- ============================================================
-- MIGRATION: Drop UNIQUE constraint to allow multiple same units
-- ============================================================
SET @has_unique_product_unit = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'product_units'
    AND INDEX_NAME = 'unique_product_unit'
);
SET @drop_unique_product_unit_sql = IF(
  @has_unique_product_unit > 0,
  'ALTER TABLE product_units DROP INDEX unique_product_unit',
  'SELECT 1'
);
PREPARE drop_unique_product_unit_stmt FROM @drop_unique_product_unit_sql;
EXECUTE drop_unique_product_unit_stmt;
DEALLOCATE PREPARE drop_unique_product_unit_stmt;

UPDATE products SET supplier_name = 'Sunrise Valley Growers' WHERE sku IN ('VEG-001', 'VEG-006', 'VEG-013');
UPDATE products SET supplier_name = 'Harvest Moon Produce Co.' WHERE sku IN ('VEG-003', 'VEG-004', 'VEG-008');
UPDATE products SET supplier_name = 'Cedar Hill Farm' WHERE sku IN ('VEG-011', 'VEG-012', 'VEG-014', 'VEG-015');

INSERT INTO transactions (invoice_no, user_id, customer_name, subtotal, total, payment_method, transaction_type, status, created_at) VALUES
('DEMO-2026-001', (SELECT id FROM users WHERE username = 'leo.cashier'), 'Ari Mercado', 170.00, 170.00, 'cash', 'sale', 'completed', DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY)),
('DEMO-2026-002', (SELECT id FROM users WHERE username = 'nina.cashier'), 'Sam Rivera', 165.00, 165.00, 'gcash', 'sale', 'completed', DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 2 DAY)),
('DEMO-2026-003', (SELECT id FROM users WHERE username = 'leo.cashier'), 'Walk-in Customer', 42.50, 42.50, 'cash', 'sale', 'completed', DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 3 DAY))
ON DUPLICATE KEY UPDATE invoice_no = VALUES(invoice_no);

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
SELECT DATE_SUB(CURRENT_DATE, INTERVAL 1 DAY), 420, 1200, 350, 2400, 680, 150
WHERE NOT EXISTS (SELECT 1 FROM operating_expenses WHERE expense_date = DATE_SUB(CURRENT_DATE, INTERVAL 1 DAY));

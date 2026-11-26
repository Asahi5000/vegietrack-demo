# Multi-Unit Inventory Conversion System - Implementation Summary

## Overview
This implementation adds multi-unit inventory conversion support to VegieTrack, allowing products to be bought and sold in different units (e.g., sacks, packs, kg, g, pcs) while tracking inventory in a base unit.

## Database Changes

### New Tables
1. **product_units** - Stores available selling units for each product with conversion rates
   - `id`, `product_id`, `unit`, `label`, `multiplier_to_base`, `is_default`, `created_at`

### Modified Tables
1. **products**
   - Added `base_unit` column (e.g., 'kg', 'pcs') - the unit in which inventory is tracked
   - Changed `stock_quantity` and `low_stock_threshold` to DECIMAL(10,4) for better precision
   - Added `unit` column as backward-compatible alias for `base_unit`

2. **transaction_items**
   - Added `conversion_rate` - the multiplier_to_base at time of transaction
   - Added `base_quantity` - quantity converted to base_unit for accurate stock tracking

## API Changes (api/index.php)

### New Helper Functions
- `getProductUnits($pdo, $productId)` - Get all units for a product
- `getDefaultUnit($pdo, $productId)` - Get default selling unit
- `convertToBase($pdo, $productId, $unit, $quantity)` - Convert selling unit to base unit
- `convertFromBase($pdo, $productId, $unit, $baseQuantity)` - Convert base unit to selling unit

### New Endpoints
- `GET /products/:id/units` - Get units for a product
- `POST /products/:id/units` - Update units for a product (admin only)
- `DELETE /products/:id/units/:unit` - Delete a unit (admin only)

### Modified Endpoints
1. **POST /transactions** (Sales)
   - Accepts `unit` in each item to specify selling unit
   - Automatically converts to base_unit using multiplier_to_base
   - Validates stock based on base_quantity
   - Stores conversion_rate and base_quantity in transaction_items

2. **POST /transactions/restock** (Restock)
   - Accepts `unit` to specify purchase unit
   - Converts purchased quantity to base_unit
   - Adds base_quantity to stock

3. **GET/POST/PUT /products**
   - Returns `units` array and `default_unit` for each product
   - Accepts `base_unit` and `units` when creating/updating products

## Usage Examples

### Example 1: Product with Multiple Units
Product: Spinach (base_unit: kg)
- Unit: kg, multiplier_to_base: 1 (1 kg = 1 kg)
- Unit: g, multiplier_to_base: 0.001 (1 g = 0.001 kg)
- Unit: pack, multiplier_to_base: 0.5 (1 pack = 0.5 kg)

### Example 2: Selling in Different Units
Customer buys 3 packs of Spinach:
- quantity: 3, unit: "pack"
- conversion_rate: 0.5
- base_quantity: 3 * 0.5 = 1.5 kg
- Stock reduced by 1.5 kg

### Example 3: Restocking in sacks
Admin restocks 5 sacks of Potatoes (base_unit: kg):
- quantity: 5, unit: "sack"
- conversion_rate: 50 (1 sack = 50 kg)
- base_quantity: 5 * 50 = 250 kg
- Stock increased by 250 kg

## Seed Data
Pre-configured units for demo products:
- Spinach: kg, g, pack (500g)
- Carrots: kg, g, bundle (1kg)
- Potato: kg, g, sack (50kg)
- Garlic: kg, g, pack (500g)
- Basil: kg, g, pack (250g)
- Broccoli: kg, g, pcs (~500g)
- Tomatoes: kg, g, pack (1kg)
- Green Beans: kg, g, bundle (500g)
- Mushroom: kg, g, pack (250g)
- Ginger: kg, g, pack (500g)

## Frontend Updates Needed
The following frontend components need updates to fully utilize the new features:

1. **Inventory.jsx**
   - Display product units in product list/edit forms
   - Add unit management UI (add/edit/delete selling units)
   - Show stock in both base_unit and default selling unit

2. **Transactions.jsx**
   - Add unit selector when adding items to cart
   - Show converted quantity and unit price
   - Display unit and conversion info in cart

3. **Product Form**
   - Add base_unit field
   - Add units management section

## Validation & Edge Cases Handled
✅ Stock validation using base_quantity (not selling quantity)
✅ Decimal precision (4 decimal places for base quantities)
✅ Insufficient stock error messages showing both base_unit amounts
✅ Default unit fallback when no unit specified
✅ Backward compatibility with existing code using 'unit' field

## Files Modified
1. `backend/database.sql` - Schema and seed data
2. `api/index.php` - API logic with unit conversion

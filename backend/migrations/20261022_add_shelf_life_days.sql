-- Safe upgrade for existing Supabase databases. Fresh installs already include
-- this column in supabase_schema.sql.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS shelf_life_days INTEGER NOT NULL DEFAULT 5;

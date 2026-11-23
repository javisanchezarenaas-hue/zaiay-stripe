'use strict';
const db = require('./db');
const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, category_id TEXT NOT NULL, name TEXT NOT NULL, material TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS product_sizes (product_id TEXT NOT NULL, size TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (product_id, size))`,
  `CREATE TABLE IF NOT EXISTS product_images (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, stripe_session_id TEXT UNIQUE NOT NULL, payment_intent TEXT NOT NULL DEFAULT '', customer_id TEXT, customer_email TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '', shipping_address TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0, shipping_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0, discount_code TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', restocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, size TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stock_log (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, size TEXT NOT NULL, delta INTEGER NOT NULL, stock_after INTEGER, reason TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stock_alerts (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, size TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, notified_at TEXT, UNIQUE (product_id, size, email))`,
  `CREATE TABLE IF NOT EXISTS return_requests (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, email TEXT NOT NULL, type TEXT NOT NULL, items TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', comments TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, admin_note TEXT NOT NULL DEFAULT '', restocked INTEGER NOT NULL DEFAULT 0, refunded_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_returns_order ON return_requests (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_product ON order_items (product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pimg_product ON product_images (product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_products_cat ON products (category_id)`,
];
const ALTERS = [`ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0`];
module.exports = { migrate: async () => {
  for (const s of DDL) await db.query(s);
  for (const s of ALTERS) { try { await db.query(s); } catch (e) { if (!/duplicate column|already exists/i.test(e.message || '')) throw e; } }
} };

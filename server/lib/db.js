import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  price_monthly REAL NOT NULL DEFAULT 0,
  price_yearly REAL NOT NULL DEFAULT 0,
  max_tables INTEGER NOT NULL DEFAULT 10,
  max_staff INTEGER NOT NULL DEFAULT 5,
  max_menu_items INTEGER NOT NULL DEFAULT 200,
  features TEXT NOT NULL DEFAULT '[]',
  highlight INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  plan_id INTEGER REFERENCES plans(id),
  subscription_ends_at TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  cycle TEXT NOT NULL DEFAULT 'monthly',
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'razorpay',
  starts_at TEXT,
  ends_at TEXT,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  note TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT DEFAULT '',
  revoked TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  restaurant_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  permissions TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, role)
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT 'Main Hall',
  seats INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'free',
  lock_user_id INTEGER,
  lock_at TEXT,
  qr_token TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  veg INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  station TEXT NOT NULL DEFAULT 'Main Kitchen',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_no INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'dine_in',
  source TEXT NOT NULL DEFAULT 'pos',
  table_id INTEGER REFERENCES dining_tables(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  captain_id INTEGER,
  discount_type TEXT DEFAULT 'amount',
  discount_value REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  service_charge REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  delivery_fee REAL NOT NULL DEFAULT 0,
  round_off REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  bill_no TEXT,
  billed_at TEXT,
  paid_at TEXT,
  rider_id INTEGER,
  delivery_status TEXT,
  delivery_otp TEXT,
  cod INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_rest_status ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_rest_created ON orders(restaurant_id, created_at);

CREATE TABLE IF NOT EXISTS kots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kot_no INTEGER NOT NULL,
  station TEXT NOT NULL DEFAULT 'Main Kitchen',
  status TEXT NOT NULL DEFAULT 'new',
  client_key TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ready_at TEXT,
  served_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kots_rest_status ON kots(restaurant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kots_client ON kots(restaurant_id, client_key, station) WHERE client_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  kot_id INTEGER REFERENCES kots(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  veg INTEGER NOT NULL DEFAULT 1,
  station TEXT NOT NULL DEFAULT 'Main Kitchen',
  note TEXT DEFAULT '',
  seat TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  cancel_reason TEXT DEFAULT '',
  added_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  reference TEXT DEFAULT '',
  received_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS gateway_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_order_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  restaurant_id INTEGER,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  payment_id TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rider_status (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  online INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  table_id INTEGER,
  order_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  qty REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  supplier TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  restaurant_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, key)
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA);
  return wrap(raw);
}

function clean(params) {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function wrap(raw) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  const db = {
    raw,
    get: (sql, ...p) => { const r = stmt(sql).get(...clean(p)); return r ? { ...r } : undefined; },
    all: (sql, ...p) => stmt(sql).all(...clean(p)).map((r) => ({ ...r })),
    run: (sql, ...p) => {
      const r = stmt(sql).run(...clean(p));
      return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
    },
    exec: (sql) => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    nextCounter(restaurantId, key) {
      db.run(
        `INSERT INTO counters (restaurant_id, key, value) VALUES (?, ?, 1)
         ON CONFLICT(restaurant_id, key) DO UPDATE SET value = value + 1`,
        restaurantId, key,
      );
      return db.get('SELECT value FROM counters WHERE restaurant_id = ? AND key = ?', restaurantId, key).value;
    },
    close: () => raw.close(),
  };
  return db;
}

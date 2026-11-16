/**
 * Demo data: one restaurant with staff for every role, a menu, tables and a week of sales.
 *   npm run seed            → seeds into DB_FILE (skips if the demo restaurant already exists)
 */
import { config } from './config.js';
import { bootstrap } from './app.js';
import { DEFAULT_SETTINGS, hashSecret, restaurantSettings } from './lib/auth.js';
import { openDb } from './lib/db.js';
import { generateBill, recordPayments, sendKot } from './lib/orders.js';
import { activateSubscription } from './lib/subscriptions.js';
import { now, randomToken } from './lib/util.js';

export const DEMO = {
  restaurant: 'Spice Route Kitchen',
  password: 'Demo@123',
  staff: [
    { role: 'owner', name: 'Meera Nair', phone: '9876500001', pin: '1111' },
    { role: 'admin', name: 'Rahul Menon', phone: '9876500002', pin: '2222' },
    { role: 'manager', name: 'Anita Joseph', phone: '9876500003', pin: '3333' },
    { role: 'captain', name: 'Arjun Das', phone: '9876500004', pin: '4444' },
    { role: 'captain', name: 'Fathima K', phone: '9876500005', pin: '5555' },
    { role: 'cashier', name: 'Vinod Kumar', phone: '9876500006', pin: '6666' },
    { role: 'kitchen', name: 'Chef Thomas', phone: '9876500007', pin: '7777' },
    { role: 'rider', name: 'Sanjay R', phone: '9876500008', pin: '8888' },
    { role: 'store_keeper', name: 'Lakshmi P', phone: '9876500009', pin: '9999' },
  ],
};

const MENU = {
  Starters: [['Chicken 65', 220, 0, 'Main Kitchen'], ['Paneer Tikka', 240, 1, 'Tandoor'], ['Gobi Manchurian', 160, 1, 'Main Kitchen'], ['Fish Fry (Seer)', 320, 0, 'Main Kitchen'], ['Crispy Corn', 150, 1, 'Main Kitchen']],
  Biriyani: [['Chicken Dum Biriyani', 260, 0, 'Main Kitchen'], ['Mutton Biriyani', 340, 0, 'Main Kitchen'], ['Veg Biriyani', 190, 1, 'Main Kitchen'], ['Prawns Biriyani', 360, 0, 'Main Kitchen'], ['Egg Biriyani', 180, 0, 'Main Kitchen']],
  'Main Course': [['Butter Chicken', 290, 0, 'Main Kitchen'], ['Kerala Beef Roast', 260, 0, 'Main Kitchen'], ['Paneer Butter Masala', 240, 1, 'Main Kitchen'], ['Dal Tadka', 160, 1, 'Main Kitchen'], ['Fish Curry Meals', 210, 0, 'Main Kitchen']],
  Breads: [['Kerala Parotta', 25, 1, 'Tandoor'], ['Butter Naan', 45, 1, 'Tandoor'], ['Tandoori Roti', 30, 1, 'Tandoor'], ['Garlic Naan', 60, 1, 'Tandoor']],
  'Hot Drinks': [['Masala Chai', 30, 1, 'Beverages'], ['Filter Coffee', 40, 1, 'Beverages'], ['Ginger Lemon Tea', 35, 1, 'Beverages']],
  'Cool Drinks': [['Fresh Lime Soda', 60, 1, 'Beverages'], ['Mango Lassi', 90, 1, 'Beverages'], ['Cold Coffee', 110, 1, 'Beverages'], ['Watermelon Juice', 80, 1, 'Beverages']],
  Desserts: [['Gulab Jamun (2 pc)', 70, 1, 'Beverages'], ['Tender Coconut Pudding', 120, 1, 'Beverages'], ['Chocolate Brownie', 140, 1, 'Beverages']],
};

export function seedDemo(db, { history = true } = {}) {
  bootstrap(db);
  if (db.get('SELECT id FROM restaurants WHERE slug = ?', 'spice-route-kitchen')) return { skipped: true };
  const plan = db.get("SELECT * FROM plans WHERE code = 'premium'") || db.get('SELECT * FROM plans ORDER BY sort DESC LIMIT 1');
  const ts = now();
  const settings = { ...DEFAULT_SETTINGS, stations: ['Main Kitchen', 'Tandoor', 'Beverages'], service_charge_percent: 0, bill_footer: 'Thank you for dining with us! Visit again.' };
  const rid = db.run(`INSERT INTO restaurants (name, slug, owner_name, phone, email, address, city, status, plan_id, settings, created_at)
    VALUES (?, 'spice-route-kitchen', ?, ?, ?, ?, ?, 'active', ?, ?, ?)`, DEMO.restaurant, DEMO.staff[0].name, DEMO.staff[0].phone,
  'hello@spiceroute.example', 'MG Road, Ernakulam', 'Kochi', plan.id, JSON.stringify(settings), ts).id;
  activateSubscription(db, { restaurantId: rid, planId: plan.id, cycle: 'yearly', amount: plan.price_yearly, source: 'manual', note: 'Demo account' });

  const users = {};
  for (const s of DEMO.staff) {
    const id = db.run('INSERT INTO users (restaurant_id, name, phone, password_hash, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      rid, s.name, s.phone, hashSecret(DEMO.password), hashSecret(s.pin), s.role, ts).id;
    users[s.role] ??= { id, ...s };
  }
  db.run('INSERT INTO rider_status (user_id, online, updated_at) VALUES (?, 1, ?)', users.rider.id, ts);

  const tables = [];
  for (let i = 1; i <= 10; i++) tables.push(db.run('INSERT INTO dining_tables (restaurant_id, name, area, seats, qr_token, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    rid, `T${i}`, 'Main Hall', i % 3 === 0 ? 6 : 4, randomToken(9), i, ts).id);
  for (let i = 1; i <= 4; i++) tables.push(db.run('INSERT INTO dining_tables (restaurant_id, name, area, seats, qr_token, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    rid, `R${i}`, 'Rooftop', 2, randomToken(9), 10 + i, ts).id);

  let sort = 0;
  const itemIds = [];
  for (const [cat, items] of Object.entries(MENU)) {
    const cid = db.run('INSERT INTO categories (restaurant_id, name, sort, created_at) VALUES (?, ?, ?, ?)', rid, cat, ++sort, ts).id;
    for (const [name, price, veg, station] of items) {
      itemIds.push(db.run(`INSERT INTO menu_items (restaurant_id, category_id, name, price, veg, available, station, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, rid, cid, name, price, veg, station, ts).id);
    }
  }

  for (const [name, unit, qty, reorder, cost] of [['Basmati Rice', 'kg', 42, 15, 120], ['Chicken', 'kg', 18, 10, 220], ['Mutton', 'kg', 6, 5, 720],
    ['Paneer', 'kg', 4, 3, 360], ['Cooking Oil', 'L', 25, 10, 140], ['Milk', 'L', 12, 8, 56], ['Onion', 'kg', 30, 10, 38]]) {
    db.run('INSERT INTO inventory_items (restaurant_id, name, unit, qty, reorder_level, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', rid, name, unit, qty, reorder, cost, ts);
  }

  if (history) {
    const restaurant = db.get('SELECT * FROM restaurants WHERE id = ?', rid);
    const mk = (user) => ({ rid, restaurant, settings: restaurantSettings(restaurant), user: { id: user.id } });
    const pick = (n) => Array.from({ length: n }, () => ({ menu_item_id: itemIds[Math.floor(Math.random() * itemIds.length)], qty: 1 + Math.floor(Math.random() * 2) }));
    const methods = ['cash', 'upi', 'upi', 'card'];
    for (let day = 6; day >= 0; day--) {
      const count = 6 + Math.floor(Math.random() * 8) + (day === 0 ? -3 : 0);
      for (let k = 0; k < count; k++) {
        const captain = k % 2 ? users.captain : users.manager;
        const isTakeaway = k % 5 === 0;
        const { order } = sendKot(db, mk(captain), { type: isTakeaway ? 'takeaway' : 'dine_in', tableId: isTakeaway ? null : tables[k % tables.length], items: pick(2 + (k % 3)), force: true });
        generateBill(db, mk(users.cashier), order.id, k % 7 === 0 ? { discountType: 'percent', discountValue: 10 } : {});
        const o = db.get('SELECT * FROM orders WHERE id = ?', order.id);
        recordPayments(db, mk(users.cashier), order.id, [{ method: methods[k % methods.length], amount: o.total }]);
        const at = new Date(Date.now() - day * 86400000 - (k + 1) * 23 * 60000).toISOString();
        db.run('UPDATE orders SET created_at = ?, billed_at = ?, paid_at = ?, updated_at = ? WHERE id = ?', at, at, at, at, order.id);
        db.run('UPDATE order_items SET status = ?, created_at = ? WHERE order_id = ?', 'served', at, order.id);
        db.run("UPDATE kots SET status = 'served', created_at = ?, served_at = ? WHERE order_id = ?", at, at, order.id);
        db.run('UPDATE payments SET created_at = ? WHERE order_id = ?', at, order.id);
      }
    }
    // A couple of running tables so the floor looks alive.
    sendKot(db, mk(users.captain), { type: 'dine_in', tableId: tables[1], items: pick(3), force: true });
    sendKot(db, mk(users.captain), { type: 'dine_in', tableId: tables[4], items: pick(2), force: true });
    db.run("UPDATE dining_tables SET status = 'reserved' WHERE id = ?", tables[7]);
    db.run('UPDATE dining_tables SET status = \'free\', lock_user_id = NULL WHERE restaurant_id = ? AND status = \'billed\'', rid);
  }
  return { restaurantId: rid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(config.dbFile);
  const out = seedDemo(db);
  if (out.skipped) console.log('Demo restaurant already exists — nothing to do.');
  else {
    console.log(`\nSeeded "${DEMO.restaurant}". All demo staff use password ${DEMO.password}:`);
    for (const s of DEMO.staff) console.log(`  ${s.role.padEnd(13)} ${s.phone}  (PIN ${s.pin})  ${s.name}`);
    console.log(`\nSuper Admin: ${config.superAdmin.phone} / SUPERADMIN_PASSWORD\n`);
  }
  db.close();
}

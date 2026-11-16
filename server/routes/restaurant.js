import { can, hashSecret, publicSettings, verifySecret } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { PERMISSIONS, ROLES, rolePermissions, sanitizePermissions } from '../lib/permissions.js';
import { dayBounds, localDate, normalizePhone, now, num, oneOf, round2, str } from '../lib/util.js';

const STAFF_ROLES = ROLES.map((r) => r.key);

function pinTaken(db, rid, pin, exceptId) {
  return db.all('SELECT id, pin_hash FROM users WHERE restaurant_id = ? AND pin_hash IS NOT NULL AND id != ?', rid, exceptId || 0)
    .some((u) => verifySecret(pin, u.pin_hash));
}

export default function register(r, db) {
  // ---- Settings ----
  r.get('/api/settings', can('settings'), (ctx) => ({
    restaurant: { name: ctx.restaurant.name, phone: ctx.restaurant.phone, email: ctx.restaurant.email, address: ctx.restaurant.address, city: ctx.restaurant.city },
    settings: publicSettings(ctx.settings),
  }));

  r.put('/api/settings', can('settings'), (ctx) => {
    const b = ctx.body;
    const s = { ...ctx.settings };
    const set = b.settings || {};
    const bool = (k) => { if (k in set) s[k] = Boolean(set[k]); };
    const text = (k, max = 300) => { if (k in set) s[k] = str(set[k], k, { max }); };
    const number = (k, min, max) => { if (k in set) s[k] = num(set[k], k.replace(/_/g, ' '), { min, max }) ?? 0; };
    ['round_off', 'gst_enabled', 'online_ordering', 'delivery_enabled', 'cash_drawer'].forEach(bool);
    ['bill_footer', 'gstin', 'delivery_area', 'printer_bill', 'printer_kitchen', 'razorpay_key_id'].forEach((k) => text(k));
    number('service_charge_percent', 0, 30);
    number('gst_percent', 0, 28);
    number('delivery_fee', 0, 10000);
    number('kitchen_amber_minutes', 1, 240);
    number('kitchen_red_minutes', 1, 480);
    if ('stations' in set) {
      const st = (Array.isArray(set.stations) ? set.stations : String(set.stations).split(','))
        .map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
      s.stations = st.length ? st : ['Main Kitchen'];
    }
    if (set.razorpay_key_secret) s.razorpay_key_secret = str(set.razorpay_key_secret, 'Razorpay secret', { max: 200 });
    if (set.razorpay_webhook_secret) s.razorpay_webhook_secret = str(set.razorpay_webhook_secret, 'Razorpay webhook secret', { max: 200 });
    if (set.clear_razorpay) { s.razorpay_key_id = ''; s.razorpay_key_secret = ''; s.razorpay_webhook_secret = ''; }
    const info = b.restaurant || {};
    db.run('UPDATE restaurants SET name = ?, phone = ?, email = ?, address = ?, city = ?, settings = ? WHERE id = ?',
      str(info.name ?? ctx.restaurant.name, 'Restaurant name', { required: true, max: 100 }),
      str(info.phone ?? ctx.restaurant.phone, 'Phone', { max: 20 }), str(info.email ?? ctx.restaurant.email, 'Email', { max: 120 }),
      str(info.address ?? ctx.restaurant.address, 'Address', { max: 300 }), str(info.city ?? ctx.restaurant.city, 'City', { max: 80 }),
      JSON.stringify(s), ctx.rid);
    return { settings: publicSettings(s) };
  });

  // ---- Staff ----
  r.get('/api/staff', can('staff', 'delivery'), (ctx) => {
    const plan = db.get('SELECT max_staff FROM plans WHERE id = ?', ctx.restaurant.plan_id);
    const staff = db.all(`SELECT u.id, u.name, u.phone, u.email, u.role, u.active, u.last_login_at, u.created_at,
        u.pin_hash IS NOT NULL AS has_pin, COALESCE(rs.online, 0) AS online
      FROM users u LEFT JOIN rider_status rs ON rs.user_id = u.id WHERE u.restaurant_id = ? ORDER BY u.active DESC, u.id`, ctx.rid);
    return { staff, limit: plan?.max_staff ?? null, roles: ROLES };
  });

  r.post('/api/staff', can('staff'), (ctx) => {
    const b = ctx.body;
    const plan = db.get('SELECT max_staff FROM plans WHERE id = ?', ctx.restaurant.plan_id);
    const count = db.get('SELECT COUNT(*) AS c FROM users WHERE restaurant_id = ? AND active = 1', ctx.rid).c;
    if (plan && count >= plan.max_staff) throw forbidden(`Your plan allows ${plan.max_staff} active staff logins. Upgrade your plan to add more.`, 'PLAN_LIMIT');
    const role = oneOf(b.role, 'Role', STAFF_ROLES.filter((x) => x !== 'owner'));
    if (role === 'admin' && ctx.user.role !== 'owner' && ctx.user.role !== 'admin') throw forbidden('Only the owner can create Admin logins.');
    const phone = normalizePhone(str(b.phone, 'Mobile number', { required: true, max: 20 }));
    if (!/^\d{10,13}$/.test(phone)) throw badRequest('Enter a valid mobile number.');
    const pin = str(b.pin, 'PIN', { max: 4 });
    if (pin && !/^\d{4}$/.test(pin)) throw badRequest('PIN must be 4 digits.');
    if (pin && pinTaken(db, ctx.rid, pin)) throw conflict('Another staff member already uses this PIN.');
    const { id } = db.run(
      'INSERT INTO users (restaurant_id, name, phone, email, password_hash, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ctx.rid, str(b.name, 'Name', { required: true, max: 80 }), phone, str(b.email, 'Email', { max: 120 }).toLowerCase() || null,
      hashSecret(str(b.password, 'Password', { required: true, min: 6, max: 200 })), pin ? hashSecret(pin) : null, role, now(),
    );
    return { id };
  });

  r.put('/api/staff/:id', can('staff'), (ctx) => {
    const b = ctx.body;
    const u = db.get('SELECT * FROM users WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!u) throw notFound('Staff member not found.');
    if (u.role === 'owner' && ctx.user.role !== 'owner') throw forbidden('Only the owner can change the owner login.');
    const role = u.role === 'owner' ? 'owner' : oneOf(b.role ?? u.role, 'Role', STAFF_ROLES.filter((x) => x !== 'owner'));
    const phone = normalizePhone(str(b.phone ?? u.phone, 'Mobile number', { required: true, max: 20 }));
    db.run('UPDATE users SET name = ?, phone = ?, email = ?, role = ? WHERE id = ?',
      str(b.name ?? u.name, 'Name', { required: true, max: 80 }), phone, str(b.email ?? u.email, 'Email', { max: 120 }).toLowerCase() || null, role, u.id);
    if (b.password) {
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(str(b.password, 'Password', { min: 6, max: 200 })), u.id);
      db.run("UPDATE sessions SET revoked = 'password' WHERE user_id = ? AND revoked IS NULL", u.id);
    }
    if (b.pin !== undefined && b.pin !== '') {
      if (!/^\d{4}$/.test(String(b.pin))) throw badRequest('PIN must be 4 digits.');
      if (pinTaken(db, ctx.rid, String(b.pin), u.id)) throw conflict('Another staff member already uses this PIN.');
      db.run('UPDATE users SET pin_hash = ? WHERE id = ?', hashSecret(String(b.pin)), u.id);
    }
    if (role !== u.role) db.run("UPDATE sessions SET revoked = 'role' WHERE user_id = ? AND revoked IS NULL", u.id);
    return { ok: true };
  });

  /** Switch a login on/off (when someone leaves). */
  r.post('/api/staff/:id/active', can('staff'), (ctx) => {
    const u = db.get('SELECT * FROM users WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!u) throw notFound('Staff member not found.');
    if (u.role === 'owner') throw badRequest('The owner login cannot be switched off.');
    if (u.id === ctx.user.id) throw badRequest('You cannot switch off your own login.');
    const active = ctx.body.active ? 1 : 0;
    if (active && !u.active) {
      const plan = db.get('SELECT max_staff FROM plans WHERE id = ?', ctx.restaurant.plan_id);
      const count = db.get('SELECT COUNT(*) AS c FROM users WHERE restaurant_id = ? AND active = 1', ctx.rid).c;
      if (plan && count >= plan.max_staff) throw forbidden(`Your plan allows ${plan.max_staff} active staff logins.`, 'PLAN_LIMIT');
    }
    db.run('UPDATE users SET active = ? WHERE id = ?', active, u.id);
    if (!active) db.run("UPDATE sessions SET revoked = 'disabled' WHERE user_id = ? AND revoked IS NULL", u.id);
    return { ok: true };
  });

  // ---- Roles & permissions ----
  r.get('/api/roles', can('roles', 'staff'), (ctx) => ({
    permissions: PERMISSIONS,
    roles: ROLES.map((role) => ({ ...role, permissions: rolePermissions(db, ctx.rid, role.key) })),
    planFeatures: JSON.parse(db.get('SELECT features FROM plans WHERE id = ?', ctx.restaurant.plan_id)?.features || '[]'),
  }));

  r.put('/api/roles/:role', can('roles'), (ctx) => {
    const role = oneOf(ctx.params.role, 'Role', STAFF_ROLES);
    if (role === 'owner') throw badRequest('The Owner role always has full access.');
    if (role === 'admin' && ctx.user.role !== 'owner') throw forbidden('Only the owner can change Admin permissions.');
    if (ctx.body.reset) db.run('DELETE FROM role_permissions WHERE restaurant_id = ? AND role = ?', ctx.rid, role);
    else {
      db.run(`INSERT INTO role_permissions (restaurant_id, role, permissions) VALUES (?, ?, ?)
        ON CONFLICT(restaurant_id, role) DO UPDATE SET permissions = excluded.permissions`,
      ctx.rid, role, JSON.stringify(sanitizePermissions(ctx.body.permissions)));
    }
    return { role, permissions: rolePermissions(db, ctx.rid, role) };
  });

  // ---- Notifications (call waiter, new QR orders) ----
  r.get('/api/notifications', can(), (ctx) => {
    const since = Number(ctx.query.since) || 0;
    const items = db.all(`SELECT n.*, t.name AS table_name FROM notifications n LEFT JOIN dining_tables t ON t.id = n.table_id
      WHERE n.restaurant_id = ? AND n.id > ? ORDER BY n.id DESC LIMIT 30`, ctx.rid, since);
    const unread = db.get('SELECT COUNT(*) AS c FROM notifications WHERE restaurant_id = ? AND read = 0', ctx.rid).c;
    return { items, unread };
  });

  r.post('/api/notifications/read', can(), (ctx) => {
    if (ctx.body.id) db.run('UPDATE notifications SET read = 1 WHERE id = ? AND restaurant_id = ?', ctx.body.id, ctx.rid);
    else db.run('UPDATE notifications SET read = 1 WHERE restaurant_id = ?', ctx.rid);
    return { ok: true };
  });

  // ---- Dashboard ----
  r.get('/api/dashboard', can('dashboard'), (ctx) => {
    const off = ctx.settings.tz_offset_minutes;
    const today = dayBounds(null, off);
    const sales = db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(discount), 0) AS discount
      FROM orders WHERE restaurant_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?`, ctx.rid, today.from, today.to);
    const running = db.get(`SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS v FROM orders
      WHERE restaurant_id = ? AND status IN ('open','billed')`, ctx.rid);
    const tables = db.all('SELECT status, COUNT(*) AS c FROM dining_tables WHERE restaurant_id = ? GROUP BY status', ctx.rid);
    const kitchen = db.get("SELECT COUNT(*) AS c FROM kots WHERE restaurant_id = ? AND status IN ('new','preparing')", ctx.rid).c;
    const awaiting = db.get(`SELECT COUNT(DISTINCT o.id) AS c FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.restaurant_id = ? AND oi.status = 'pending' AND o.status IN ('awaiting','open','billed')`, ctx.rid).c;
    const from7 = dayBounds(localDate(new Date(Date.now() - 6 * 86400000).toISOString(), off), off).from;
    const rows = db.all(`SELECT paid_at, total FROM orders WHERE restaurant_id = ? AND status = 'paid' AND paid_at >= ?`, ctx.rid, from7);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = localDate(new Date(Date.now() - i * 86400000).toISOString(), off);
      days.push({ date: d, total: 0, orders: 0 });
    }
    for (const row of rows) {
      const d = days.find((x) => x.date === localDate(row.paid_at, off));
      if (d) { d.total = round2(d.total + row.total); d.orders++; }
    }
    const top = db.all(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS amount FROM order_items oi
      JOIN orders o ON o.id = oi.order_id WHERE o.restaurant_id = ? AND o.status = 'paid' AND o.paid_at >= ? AND oi.status != 'cancelled'
      GROUP BY oi.name ORDER BY qty DESC LIMIT 5`, ctx.rid, from7);
    const byType = db.all(`SELECT type, COUNT(*) AS c, COALESCE(SUM(total), 0) AS v FROM orders
      WHERE restaurant_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ? GROUP BY type`, ctx.rid, today.from, today.to);
    const methods = db.all(`SELECT p.method, SUM(p.amount) AS v FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.restaurant_id = ? AND p.created_at >= ? AND p.created_at < ? GROUP BY p.method`, ctx.rid, today.from, today.to);
    return { today: { ...sales, avg: sales.orders ? round2(sales.total / sales.orders) : 0 }, running, tables, kitchen, awaiting, days, top, byType, methods };
  });
}

import { config } from '../config.js';
import { DEFAULT_SETTINGS, hashSecret, superAdminOnly } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import {
  DEFAULT_ROLE_PERMISSIONS, FEATURES, PERMISSIONS, ROLES, rolePermissions, sanitizePermissions,
} from '../lib/permissions.js';
import { activateSubscription } from '../lib/subscriptions.js';
import { addDays, normalizePhone, now, num, oneOf, parseJson, randomToken, round2, slugify, str } from '../lib/util.js';

function planInput(b) {
  const features = Array.isArray(b.features) ? b.features.filter((f) => FEATURES.some((x) => x.key === f)) : [];
  return {
    name: str(b.name, 'Plan name', { required: true, max: 60 }),
    code: slugify(b.code || b.name),
    description: str(b.description, 'Description', { max: 300 }),
    price_monthly: num(b.price_monthly, 'Monthly price', { required: true, min: 0, max: 1e7 }),
    price_yearly: num(b.price_yearly, 'Yearly price', { min: 0, max: 1e8 }) ?? 0,
    max_tables: num(b.max_tables, 'Max tables', { required: true, min: 1, max: 10000, int: true }),
    max_staff: num(b.max_staff, 'Max staff', { required: true, min: 1, max: 10000, int: true }),
    max_menu_items: num(b.max_menu_items, 'Max menu items', { min: 1, max: 100000, int: true }) ?? 500,
    features: JSON.stringify(features),
    highlight: b.highlight ? 1 : 0,
    active: b.active === false ? 0 : 1,
    sort: num(b.sort, 'Sort', { min: 0, max: 1000, int: true }) ?? 0,
  };
}

const planOut = (p) => p && ({ ...p, features: parseJson(p.features, []), highlight: !!p.highlight, active: !!p.active });

function uniqueSlug(db, name) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; db.get('SELECT id FROM restaurants WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
  return slug;
}

export default function register(r, db) {
  r.get('/api/admin/meta', superAdminOnly, () => ({
    permissions: PERMISSIONS, features: FEATURES, roles: ROLES, defaults: DEFAULT_ROLE_PERMISSIONS,
    razorpayConfigured: Boolean(config.razorpay.keyId && config.razorpay.keySecret), trialDays: config.trialDays,
  }));

  r.get('/api/admin/stats', superAdminOnly, () => {
    const ts = now();
    const restaurants = db.get(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' AND subscription_ends_at > ? THEN 1 ELSE 0 END) AS live,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
        SUM(CASE WHEN status = 'active' AND (subscription_ends_at IS NULL OR subscription_ends_at <= ?) THEN 1 ELSE 0 END) AS lapsed
      FROM restaurants`, ts, ts);
    const mrr = db.get(`SELECT COALESCE(SUM(CASE WHEN s.cycle = 'yearly' THEN s.amount / 12.0 ELSE s.amount END), 0) AS v
      FROM subscriptions s WHERE s.status = 'active' AND s.ends_at > ? AND s.source != 'trial'`, ts).v;
    const revenue = db.get("SELECT COALESCE(SUM(amount), 0) AS v FROM subscriptions WHERE status IN ('active','replaced','expired') AND source != 'trial'").v;
    const byPlan = db.all(`SELECT p.name, COUNT(r.id) AS count FROM plans p LEFT JOIN restaurants r ON r.plan_id = p.id
      AND r.subscription_ends_at > ? GROUP BY p.id ORDER BY p.sort`, ts);
    const expiring = db.all(`SELECT r.id, r.name, r.subscription_ends_at, p.name AS plan_name FROM restaurants r
      LEFT JOIN plans p ON p.id = r.plan_id WHERE r.subscription_ends_at > ? AND r.subscription_ends_at <= ?
      ORDER BY r.subscription_ends_at LIMIT 8`, ts, addDays(ts, 10));
    const recent = db.all(`SELECT r.id, r.name, r.city, r.created_at, p.name AS plan_name FROM restaurants r
      LEFT JOIN plans p ON p.id = r.plan_id ORDER BY r.id DESC LIMIT 6`);
    const payments = db.all(`SELECT s.id, s.amount, s.cycle, s.source, s.created_at, r.name AS restaurant_name, p.name AS plan_name
      FROM subscriptions s JOIN restaurants r ON r.id = s.restaurant_id JOIN plans p ON p.id = s.plan_id
      WHERE s.status != 'pending' AND s.source != 'trial' ORDER BY s.id DESC LIMIT 6`);
    const ordersToday = db.get('SELECT COUNT(*) AS c FROM orders WHERE created_at >= ?', addDays(ts, -1)).c;
    return { restaurants, mrr: round2(mrr), revenue: round2(revenue), byPlan, expiring, recent, payments, ordersToday };
  });

  // ---- Plans ----
  r.get('/api/admin/plans', superAdminOnly, () => db.all(`SELECT p.*, (SELECT COUNT(*) FROM restaurants r WHERE r.plan_id = p.id) AS restaurants
    FROM plans p ORDER BY sort, id`).map(planOut));

  r.post('/api/admin/plans', superAdminOnly, (ctx) => {
    const p = planInput(ctx.body);
    const { id } = db.run(
      `INSERT INTO plans (name, code, description, price_monthly, price_yearly, max_tables, max_staff, max_menu_items, features, highlight, active, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.name, p.code, p.description, p.price_monthly, p.price_yearly, p.max_tables, p.max_staff, p.max_menu_items, p.features,
      p.highlight, p.active, p.sort, now(),
    );
    return planOut(db.get('SELECT * FROM plans WHERE id = ?', id));
  });

  r.put('/api/admin/plans/:id', superAdminOnly, (ctx) => {
    if (!db.get('SELECT id FROM plans WHERE id = ?', ctx.params.id)) throw notFound('Plan not found.');
    const p = planInput(ctx.body);
    db.run(
      `UPDATE plans SET name = ?, code = ?, description = ?, price_monthly = ?, price_yearly = ?, max_tables = ?, max_staff = ?,
         max_menu_items = ?, features = ?, highlight = ?, active = ?, sort = ? WHERE id = ?`,
      p.name, p.code, p.description, p.price_monthly, p.price_yearly, p.max_tables, p.max_staff, p.max_menu_items, p.features,
      p.highlight, p.active, p.sort, ctx.params.id,
    );
    return planOut(db.get('SELECT * FROM plans WHERE id = ?', ctx.params.id));
  });

  r.delete('/api/admin/plans/:id', superAdminOnly, (ctx) => {
    const used = db.get('SELECT COUNT(*) AS c FROM subscriptions WHERE plan_id = ?', ctx.params.id).c
      + db.get('SELECT COUNT(*) AS c FROM restaurants WHERE plan_id = ?', ctx.params.id).c;
    if (used) throw conflict('This plan has been purchased before. Switch it off instead of deleting it.', 'PLAN_IN_USE');
    db.run('DELETE FROM plans WHERE id = ?', ctx.params.id);
    return { ok: true };
  });

  // ---- Restaurants ----
  r.get('/api/admin/restaurants', superAdminOnly, (ctx) => {
    const q = `%${String(ctx.query.q || '').trim()}%`;
    return db.all(`SELECT r.id, r.name, r.slug, r.owner_name, r.phone, r.email, r.city, r.status, r.plan_id, r.subscription_ends_at,
        r.created_at, p.name AS plan_name,
        (SELECT COUNT(*) FROM users u WHERE u.restaurant_id = r.id) AS staff_count,
        (SELECT COUNT(*) FROM dining_tables t WHERE t.restaurant_id = r.id) AS table_count,
        (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id) AS order_count
      FROM restaurants r LEFT JOIN plans p ON p.id = r.plan_id
      WHERE r.name LIKE ? OR r.phone LIKE ? OR r.city LIKE ? OR r.owner_name LIKE ? ORDER BY r.id DESC`, q, q, q, q);
  });

  r.get('/api/admin/restaurants/:id', superAdminOnly, (ctx) => {
    const rest = db.get('SELECT r.*, p.name AS plan_name FROM restaurants r LEFT JOIN plans p ON p.id = r.plan_id WHERE r.id = ?', ctx.params.id);
    if (!rest) throw notFound('Restaurant not found.');
    const { settings, ...info } = rest;
    return {
      ...info,
      owner: db.get("SELECT id, name, phone, email, active, last_login_at FROM users WHERE restaurant_id = ? AND role = 'owner' ORDER BY id LIMIT 1", rest.id),
      staff: db.all('SELECT id, name, phone, role, active, last_login_at FROM users WHERE restaurant_id = ? ORDER BY id', rest.id),
      subscriptions: db.all(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.restaurant_id = ? ORDER BY s.id DESC`, rest.id),
      roles: ROLES.map((role) => ({ ...role, permissions: rolePermissions(db, rest.id, role.key),
        custom: Boolean(db.get('SELECT 1 FROM role_permissions WHERE restaurant_id = ? AND role = ?', rest.id, role.key)) })),
      stats: db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status = 'paid' THEN total END), 0) AS sales
        FROM orders WHERE restaurant_id = ?`, rest.id),
    };
  });

  r.post('/api/admin/restaurants', superAdminOnly, (ctx) => {
    const b = ctx.body;
    const name = str(b.name, 'Restaurant name', { required: true, max: 100 });
    const ownerName = str(b.owner_name, 'Owner name', { required: true, max: 80 });
    const phone = normalizePhone(str(b.phone, 'Owner mobile number', { required: true, max: 20 }));
    if (!/^\d{10,13}$/.test(phone)) throw badRequest('Enter a valid mobile number.');
    const email = str(b.email, 'Email', { max: 120 }).toLowerCase() || null;
    const password = str(b.password, 'Owner password', { required: true, min: 6, max: 200 });
    const planId = num(b.plan_id, 'Plan', { required: true, int: true });
    const plan = db.get('SELECT * FROM plans WHERE id = ?', planId);
    if (!plan) throw badRequest('Choose a plan.');
    const mode = oneOf(b.access, 'Access', ['trial', 'paid', 'pending'], 'trial');
    const cycle = oneOf(b.cycle, 'Billing cycle', ['monthly', 'yearly'], 'monthly');
    const tables = num(b.tables, 'Tables', { min: 0, max: plan.max_tables, int: true }) ?? 0;
    if (db.get('SELECT id FROM users WHERE phone = ?', phone)) throw conflict('A login with this mobile number already exists.');
    if (email && db.get('SELECT id FROM users WHERE email = ?', email)) throw conflict('A login with this email already exists.');

    const ts = now();
    const id = db.tx(() => {
      const { id: rid } = db.run(
        `INSERT INTO restaurants (name, slug, owner_name, phone, email, address, city, status, plan_id, settings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        name, uniqueSlug(db, name), ownerName, phone, email || '', str(b.address, 'Address', { max: 300 }), str(b.city, 'City', { max: 80 }),
        planId, JSON.stringify({ ...DEFAULT_SETTINGS }), ts,
      );
      db.run("INSERT INTO users (restaurant_id, name, phone, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)",
        rid, ownerName, phone, email, hashSecret(password), ts);
      for (let i = 1; i <= tables; i++) {
        db.run('INSERT INTO dining_tables (restaurant_id, name, area, seats, qr_token, sort, created_at) VALUES (?, ?, ?, 4, ?, ?, ?)',
          rid, `T${i}`, 'Main Hall', randomToken(9), i, ts);
      }
      if (mode === 'trial' && config.trialDays > 0) {
        activateSubscription(db, { restaurantId: rid, planId, cycle: 'monthly', days: config.trialDays, source: 'trial', note: 'Free trial', createdBy: ctx.user.id });
      } else if (mode === 'paid') {
        const amount = cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
        activateSubscription(db, { restaurantId: rid, planId, cycle, amount, source: 'manual', note: str(b.note, 'Note', { max: 200 }) || 'Activated by Super Admin', createdBy: ctx.user.id });
      }
      return rid;
    });
    return db.get('SELECT * FROM restaurants WHERE id = ?', id);
  });

  r.put('/api/admin/restaurants/:id', superAdminOnly, (ctx) => {
    const b = ctx.body;
    if (!db.get('SELECT id FROM restaurants WHERE id = ?', ctx.params.id)) throw notFound('Restaurant not found.');
    db.run('UPDATE restaurants SET name = ?, owner_name = ?, phone = ?, email = ?, address = ?, city = ? WHERE id = ?',
      str(b.name, 'Restaurant name', { required: true, max: 100 }), str(b.owner_name, 'Owner name', { max: 80 }),
      normalizePhone(str(b.phone, 'Phone', { max: 20 })), str(b.email, 'Email', { max: 120 }), str(b.address, 'Address', { max: 300 }),
      str(b.city, 'City', { max: 80 }), ctx.params.id);
    return { ok: true };
  });

  /** Grant or pause system access for a restaurant. */
  r.post('/api/admin/restaurants/:id/status', superAdminOnly, (ctx) => {
    const status = oneOf(ctx.body.status, 'Status', ['active', 'suspended']);
    const { changes } = db.run('UPDATE restaurants SET status = ? WHERE id = ?', status, ctx.params.id);
    if (!changes) throw notFound('Restaurant not found.');
    return { ok: true, status };
  });

  /** Manually assign / extend a plan (e.g. paid by bank transfer). */
  r.post('/api/admin/restaurants/:id/subscription', superAdminOnly, (ctx) => {
    const b = ctx.body;
    if (!db.get('SELECT id FROM restaurants WHERE id = ?', ctx.params.id)) throw notFound('Restaurant not found.');
    const plan = db.get('SELECT * FROM plans WHERE id = ?', num(b.plan_id, 'Plan', { required: true, int: true }));
    if (!plan) throw badRequest('Choose a plan.');
    const cycle = oneOf(b.cycle, 'Billing cycle', ['monthly', 'yearly'], 'monthly');
    const periods = num(b.periods, 'Periods', { min: 1, max: 36, int: true }) ?? 1;
    const amount = num(b.amount, 'Amount', { min: 0, max: 1e8 }) ?? (cycle === 'yearly' ? plan.price_yearly : plan.price_monthly) * periods;
    return activateSubscription(db, {
      restaurantId: Number(ctx.params.id), planId: plan.id, cycle, periods, amount, source: amount > 0 ? 'manual' : 'complimentary',
      note: str(b.note, 'Note', { max: 200 }) || 'Assigned by Super Admin', createdBy: ctx.user.id,
    });
  });

  r.post('/api/admin/restaurants/:id/owner-password', superAdminOnly, (ctx) => {
    const password = str(ctx.body.password, 'New password', { required: true, min: 6, max: 200 });
    const owner = db.get("SELECT id FROM users WHERE restaurant_id = ? AND role = 'owner' ORDER BY id LIMIT 1", ctx.params.id);
    if (!owner) throw notFound('Owner login not found.');
    db.run('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', hashSecret(password), owner.id);
    db.run("UPDATE sessions SET revoked = 'password' WHERE user_id = ? AND revoked IS NULL", owner.id);
    return { ok: true };
  });

  /** Role permissions — per restaurant (restaurant id) or platform defaults (id 0). */
  const putRole = (ctx, rid) => {
    const role = oneOf(ctx.params.role, 'Role', ROLES.map((x) => x.key));
    if (role === 'owner') throw badRequest('The Owner role always has full access.');
    if (ctx.body.reset) {
      db.run('DELETE FROM role_permissions WHERE restaurant_id = ? AND role = ?', rid, role);
    } else {
      db.run(`INSERT INTO role_permissions (restaurant_id, role, permissions) VALUES (?, ?, ?)
        ON CONFLICT(restaurant_id, role) DO UPDATE SET permissions = excluded.permissions`,
      rid, role, JSON.stringify(sanitizePermissions(ctx.body.permissions)));
    }
    return { role, permissions: rolePermissions(db, rid, role) };
  };
  r.put('/api/admin/restaurants/:id/roles/:role', superAdminOnly, (ctx) => putRole(ctx, Number(ctx.params.id)));
  r.get('/api/admin/roles', superAdminOnly, () => ROLES.map((role) => ({ ...role, permissions: rolePermissions(db, 0, role.key) })));
  r.put('/api/admin/roles/:role', superAdminOnly, (ctx) => putRole(ctx, 0));

  r.get('/api/admin/subscriptions', superAdminOnly, () => db.all(`SELECT s.*, r.name AS restaurant_name, p.name AS plan_name
    FROM subscriptions s JOIN restaurants r ON r.id = s.restaurant_id JOIN plans p ON p.id = s.plan_id ORDER BY s.id DESC LIMIT 500`));
}

import {
  authed, clearRateLimit, createSession, hashSecret, publicSettings, rateLimit, verifySecret,
} from '../lib/auth.js';
import { badRequest, unauthorized } from '../lib/http.js';
import { PERMISSIONS, ROLES } from '../lib/permissions.js';
import { normalizePhone, parseJson, str } from '../lib/util.js';

export function mePayload(ctx) {
  const { db, user } = ctx;
  const base = {
    user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, has_pin: Boolean(user.pin_hash) },
    permissions: ctx.perms,
  };
  if (ctx.isSuperAdmin) return { ...base, superAdmin: true };
  const r = ctx.restaurant;
  const plan = r.plan_id ? db.get('SELECT * FROM plans WHERE id = ?', r.plan_id) : null;
  return {
    ...base,
    roleLabel: ROLES.find((x) => x.key === user.role)?.label || user.role,
    restaurant: {
      id: r.id, name: r.name, slug: r.slug, phone: r.phone, email: r.email, address: r.address, city: r.city,
      status: r.status, subscription_ends_at: r.subscription_ends_at, settings: publicSettings(ctx.settings),
    },
    plan: plan ? { id: plan.id, name: plan.name, features: parseJson(plan.features, []), max_tables: plan.max_tables, max_staff: plan.max_staff } : null,
    subscription: ctx.subscription,
  };
}

export default function register(r, db) {
  r.post('/api/auth/login', (ctx) => {
    const login = str(ctx.body.login, 'Mobile number or email', { required: true, max: 120 });
    const password = str(ctx.body.password, 'Password', { required: true, max: 200 });
    const key = `login:${ctx.ip}:${login.toLowerCase()}`;
    rateLimit(key, 8);
    const user = login.includes('@')
      ? db.get('SELECT * FROM users WHERE email = ?', login.toLowerCase())
      : db.get('SELECT * FROM users WHERE phone = ?', normalizePhone(login));
    if (!user || !verifySecret(password, user.password_hash)) throw unauthorized('Mobile number / email or password is wrong.', 'BAD_LOGIN');
    if (!user.active) throw unauthorized('Your login has been switched off. Please contact your manager.', 'USER_DISABLED');
    clearRateLimit(key);
    const token = createSession(db, user, ctx.body.device || ctx.req.headers['user-agent']);
    ctx.req.headers.authorization = `Bearer ${token}`;
    authed(ctx);
    return { token, ...mePayload(ctx) };
  });

  r.post('/api/auth/logout', authed, (ctx) => {
    db.run("UPDATE sessions SET revoked = 'logout' WHERE token = ?", ctx.token);
    return { ok: true };
  });

  r.get('/api/auth/me', authed, (ctx) => mePayload(ctx));

  r.get('/api/auth/meta', () => ({ roles: ROLES, permissions: PERMISSIONS }));

  /** Quick switch on a shared counter device using a 4-digit PIN. */
  r.post('/api/auth/pin', authed, (ctx) => {
    if (ctx.isSuperAdmin) throw badRequest('PIN switch is for restaurant staff.');
    const pin = str(ctx.body.pin, 'PIN', { required: true, max: 6 });
    if (!/^\d{4}$/.test(pin)) throw badRequest('PIN must be 4 digits.');
    rateLimit(`pin:${ctx.ip}:${ctx.rid}`, 10);
    const staff = db.all('SELECT * FROM users WHERE restaurant_id = ? AND active = 1 AND pin_hash IS NOT NULL', ctx.rid);
    const user = staff.find((u) => verifySecret(pin, u.pin_hash));
    if (!user) throw unauthorized('That PIN does not match anyone.', 'BAD_PIN');
    clearRateLimit(`pin:${ctx.ip}:${ctx.rid}`);
    const token = createSession(db, user, ctx.req.headers['user-agent']);
    ctx.req.headers.authorization = `Bearer ${token}`;
    authed(ctx);
    return { token, ...mePayload(ctx) };
  });

  r.post('/api/auth/password', authed, (ctx) => {
    const current = str(ctx.body.current, 'Current password', { required: true, max: 200 });
    const next = str(ctx.body.next, 'New password', { required: true, min: 6, max: 200 });
    if (!verifySecret(current, ctx.user.password_hash)) throw badRequest('Current password is wrong.');
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(next), ctx.user.id);
    db.run("UPDATE sessions SET revoked = 'password' WHERE user_id = ? AND token != ? AND revoked IS NULL", ctx.user.id, ctx.token);
    return { ok: true };
  });

  r.post('/api/auth/pin/set', authed, (ctx) => {
    const pin = str(ctx.body.pin, 'PIN', { required: true });
    if (!/^\d{4}$/.test(pin)) throw badRequest('PIN must be 4 digits.');
    if (ctx.user.restaurant_id && db.all('SELECT pin_hash FROM users WHERE restaurant_id = ? AND id != ? AND pin_hash IS NOT NULL', ctx.user.restaurant_id, ctx.user.id)
      .some((u) => verifySecret(pin, u.pin_hash))) throw badRequest('Another staff member already uses this PIN. Choose a different one.');
    db.run('UPDATE users SET pin_hash = ? WHERE id = ?', hashSecret(pin), ctx.user.id);
    return { ok: true };
  });
}

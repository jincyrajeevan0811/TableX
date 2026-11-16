import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError, forbidden, unauthorized } from './http.js';
import { effectivePermissions, MULTI_DEVICE_ROLES } from './permissions.js';
import { addDays, now, parseJson, randomToken } from './util.js';

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(String(secret), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

export const DEFAULT_SETTINGS = {
  bill_footer: 'Thank you! Visit again.',
  service_charge_percent: 0,
  round_off: true,
  gst_enabled: false,
  gst_percent: 5,
  gstin: '',
  online_ordering: true,
  delivery_enabled: true,
  delivery_fee: 30,
  delivery_area: '',
  currency: 'INR',
  tz_offset_minutes: 330,
  kitchen_amber_minutes: 10,
  kitchen_red_minutes: 20,
  stations: ['Main Kitchen'],
  razorpay_key_id: '',
  razorpay_key_secret: '',
  razorpay_webhook_secret: '',
  printer_bill: '',
  printer_kitchen: '',
  cash_drawer: false,
};

export function restaurantSettings(restaurant) {
  return { ...DEFAULT_SETTINGS, ...parseJson(restaurant?.settings, {}) };
}

/** Settings safe to send to the browser (gateway secret removed). */
export function publicSettings(settings) {
  const { razorpay_key_secret, razorpay_webhook_secret, ...rest } = settings;
  return { ...rest, razorpay_secret_set: Boolean(razorpay_key_secret), razorpay_webhook_set: Boolean(razorpay_webhook_secret) };
}

export function createSession(db, user, device = '') {
  const token = randomToken(32);
  const ts = now();
  db.tx(() => {
    if (!MULTI_DEVICE_ROLES.has(user.role)) {
      // One device at a time: the older device gets signed out with a clear message.
      db.run("UPDATE sessions SET revoked = 'replaced' WHERE user_id = ? AND revoked IS NULL", user.id);
    }
    db.run(
      'INSERT INTO sessions (token, user_id, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      token, user.id, String(device).slice(0, 200), ts, ts, addDays(ts, config.sessionDays),
    );
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', ts, user.id);
  });
  return token;
}

export function subscriptionState(restaurant) {
  if (!restaurant) return { active: true };
  if (restaurant.status !== 'active') return { active: false, reason: 'suspended' };
  if (!restaurant.subscription_ends_at || restaurant.subscription_ends_at < now()) return { active: false, reason: 'expired' };
  return { active: true };
}

/** Middleware: resolves the session into ctx.user / ctx.restaurant / ctx.perms. */
export function authenticate(ctx) {
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();
  const session = ctx.db.get('SELECT * FROM sessions WHERE token = ?', token);
  if (!session) throw unauthorized('Your session expired. Please sign in again.', 'SESSION_EXPIRED');
  if (session.revoked === 'replaced') {
    throw unauthorized('This login is now in use on another device. Every person needs their own login — ask the owner to create one for you.', 'SESSION_REPLACED');
  }
  if (session.revoked || session.expires_at < now()) throw unauthorized('Your session expired. Please sign in again.', 'SESSION_EXPIRED');
  const user = ctx.db.get('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!user || !user.active) throw unauthorized('Your login has been switched off. Please contact your manager.', 'USER_DISABLED');

  ctx.token = token;
  ctx.user = user;
  ctx.perms = [];
  if (user.role === 'super_admin') {
    ctx.isSuperAdmin = true;
  } else {
    const restaurant = ctx.db.get('SELECT * FROM restaurants WHERE id = ?', user.restaurant_id);
    if (!restaurant) throw unauthorized('Restaurant not found.', 'NO_RESTAURANT');
    ctx.restaurant = restaurant;
    ctx.rid = restaurant.id;
    ctx.settings = restaurantSettings(restaurant);
    ctx.perms = effectivePermissions(ctx.db, restaurant, user.role);
    ctx.subscription = subscriptionState(restaurant);
  }
  // Touch at most once a minute to keep writes low.
  if (!session.last_seen_at || Date.now() - Date.parse(session.last_seen_at) > 60000) {
    ctx.db.run('UPDATE sessions SET last_seen_at = ? WHERE token = ?', now(), token);
  }
}

export const authed = (ctx) => authenticate(ctx);

export const superAdminOnly = (ctx) => {
  authenticate(ctx);
  if (!ctx.isSuperAdmin) throw forbidden('Super Admin access only.');
};

/**
 * Restaurant-staff middleware. Passes when the user holds ANY of the listed permissions
 * (or no permission is listed). Blocks restaurants whose access is suspended or whose plan lapsed,
 * except for the subscription screens so the owner can renew.
 */
export const can = (...perms) => (ctx) => {
  authenticate(ctx);
  if (ctx.isSuperAdmin) throw forbidden('Sign in with a restaurant login to use this screen.');
  if (!ctx.subscription.active && !perms.includes('subscription')) {
    if (ctx.subscription.reason === 'suspended') {
      throw new HttpError(403, 'Access to this restaurant has been paused by TableX. Please contact support.', 'RESTAURANT_SUSPENDED');
    }
    throw new HttpError(402, 'Your TableX subscription has ended. Please renew your plan to continue.', 'SUBSCRIPTION_EXPIRED');
  }
  if (perms.length && !perms.some((p) => ctx.perms.includes(p))) throw forbidden();
};

export const has = (ctx, perm) => ctx.isSuperAdmin || ctx.perms.includes(perm);

/** Simple in-memory limiter for sign-in attempts. */
const attempts = new Map();
export function rateLimit(key, max = 10, windowMs = 5 * 60000) {
  const t = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: t + windowMs };
  if (t > entry.reset) { entry.count = 0; entry.reset = t + windowMs; }
  entry.count++;
  attempts.set(key, entry);
  if (entry.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.', 'RATE_LIMITED');
}
export const clearRateLimit = (key) => attempts.delete(key);

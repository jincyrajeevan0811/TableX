import crypto from 'node:crypto';
import { badRequest } from './http.js';

export const now = () => new Date().toISOString();
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const randomDigits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'restaurant';
}

export function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

/** Light-weight input validation helpers. */
export function str(v, field, { required = false, max = 500, min = 0 } = {}) {
  if (v === undefined || v === null) v = '';
  v = String(v).trim();
  if (required && !v) throw badRequest(`${field} is required.`);
  if (v.length > max) throw badRequest(`${field} is too long (max ${max}).`);
  if (v && v.length < min) throw badRequest(`${field} must be at least ${min} characters.`);
  return v;
}

export function num(v, field, { required = false, min = -Infinity, max = Infinity, int = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${field} is required.`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`);
  if (int && !Number.isInteger(n)) throw badRequest(`${field} must be a whole number.`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return n;
}

export function oneOf(v, field, options, fallback) {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field} is required.`);
  }
  if (!options.includes(v)) throw badRequest(`${field} must be one of: ${options.join(', ')}.`);
  return v;
}

export function normalizePhone(p) {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  return digits.replace(/^\+?91(?=\d{10}$)/, '');
}

/** Day bounds (UTC ISO strings) for a local YYYY-MM-DD with a fixed UTC offset in minutes. */
export function dayBounds(dateStr, offsetMin = 330) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; } else {
    const local = new Date(Date.now() + offsetMin * 60000);
    y = local.getUTCFullYear(); mo = local.getUTCMonth(); d = local.getUTCDate();
  }
  const start = Date.UTC(y, mo, d) - offsetMin * 60000;
  return { from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString(), date: new Date(Date.UTC(y, mo, d)).toISOString().slice(0, 10) };
}

export function localDate(iso, offsetMin = 330) {
  return new Date(new Date(iso).getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86400000).toISOString();
}

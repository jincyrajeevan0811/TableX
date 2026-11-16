import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { hashSecret } from './lib/auth.js';
import { openDb } from './lib/db.js';
import { HttpError, createRouter, readBody, sendJson, serveStatic } from './lib/http.js';
import { now } from './lib/util.js';
import registerAuth from './routes/auth.js';
import registerAdmin from './routes/admin.js';
import registerRestaurant from './routes/restaurant.js';
import registerMenu from './routes/menu.js';
import registerTables from './routes/tables.js';
import registerOrders from './routes/orders.js';
import registerKitchen from './routes/kitchen.js';
import registerDelivery from './routes/delivery.js';
import registerReports from './routes/reports.js';
import registerInventory from './routes/inventory.js';
import registerSubscription from './routes/subscription.js';
import registerPublic from './routes/public.js';

export const DEFAULT_PLANS = [
  {
    name: 'Average', code: 'average', description: 'For cafés and small restaurants getting started.',
    price_monthly: 999, price_yearly: 9990, max_tables: 12, max_staff: 6, max_menu_items: 150,
    features: ['qr_ordering', 'offline_mode', 'reports'], highlight: 0, sort: 1,
  },
  {
    name: 'Medium', code: 'medium', description: 'For busy restaurants with delivery and online payments.',
    price_monthly: 1999, price_yearly: 19990, max_tables: 30, max_staff: 20, max_menu_items: 500,
    features: ['qr_ordering', 'offline_mode', 'reports', 'delivery', 'online_payments', 'multi_station'], highlight: 1, sort: 2,
  },
  {
    name: 'Premium', code: 'premium', description: 'Everything in TableX, for large and multi-counter outlets.',
    price_monthly: 3999, price_yearly: 39990, max_tables: 200, max_staff: 100, max_menu_items: 2000,
    features: ['qr_ordering', 'offline_mode', 'reports', 'delivery', 'online_payments', 'multi_station', 'inventory'], highlight: 0, sort: 3,
  },
];

export function bootstrap(db) {
  if (!db.get('SELECT id FROM plans LIMIT 1')) {
    for (const p of DEFAULT_PLANS) {
      db.run(
        `INSERT INTO plans (name, code, description, price_monthly, price_yearly, max_tables, max_staff, max_menu_items, features, highlight, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.name, p.code, p.description, p.price_monthly, p.price_yearly, p.max_tables, p.max_staff, p.max_menu_items,
        JSON.stringify(p.features), p.highlight, p.sort, now(),
      );
    }
  }
  if (!db.get("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1")) {
    const sa = config.superAdmin;
    db.run(
      "INSERT INTO users (restaurant_id, name, phone, email, password_hash, role, created_at) VALUES (NULL, ?, ?, ?, ?, 'super_admin', ?)",
      sa.name, sa.phone, sa.email.toLowerCase(), hashSecret(sa.password), now(),
    );
  }
}

export function createApp({ dbFile = config.dbFile } = {}) {
  const db = openDb(dbFile);
  bootstrap(db);

  const router = createRouter();
  for (const register of [registerAuth, registerAdmin, registerRestaurant, registerMenu, registerTables, registerOrders,
    registerKitchen, registerDelivery, registerReports, registerInventory, registerSubscription, registerPublic]) {
    register(router, db);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    if (url.pathname.startsWith('/api/')) {
      const match = router.match(req.method, url.pathname);
      if (!match) return sendJson(res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
      if (match.methodNotAllowed) return sendJson(res, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' });
      const ctx = {
        req, res, db, params: match.params, query: Object.fromEntries(url.searchParams), body: {},
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
      };
      try {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          ctx.rawBody = await readBody(req);
          if (ctx.rawBody.length) {
            try { ctx.body = JSON.parse(ctx.rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body.', 'BAD_JSON'); }
            if (typeof ctx.body !== 'object' || ctx.body === null) ctx.body = {};
          }
        }
        let result;
        for (const h of match.handlers) result = await h(ctx);
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: err.message, code: err.code, ...(err.extra ? { details: err.extra } : {}) });
        } else if (String(err?.message).includes('UNIQUE constraint failed')) {
          const field = /\.(\w+)$/.exec(err.message)?.[1] || 'value';
          sendJson(res, 409, { error: `That ${field.replace('_', ' ')} is already in use.`, code: 'DUPLICATE' });
        } else {
          console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`, err);
          sendJson(res, 500, { error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' });
        }
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/m/')) {
      if (serveStatic(res, config.publicDir, 'order.html')) return;
    }
    if (url.pathname !== '/' && serveStatic(res, config.publicDir, url.pathname)) return;
    if (path.extname(url.pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    serveStatic(res, config.publicDir, 'index.html');
  });

  return { server, db };
}

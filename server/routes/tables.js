import { can, has } from '../lib/auth.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { activeOrderForTable, orderDetail } from '../lib/orders.js';
import { now, num, oneOf, randomToken, str } from '../lib/util.js';

const LOCK_TTL_MS = 4 * 3600 * 1000;

export function baseUrl(ctx) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = ctx.req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host}`;
}

function getTable(db, rid, id) {
  const t = db.get('SELECT * FROM dining_tables WHERE id = ? AND restaurant_id = ?', id, rid);
  if (!t) throw notFound('Table not found.');
  return t;
}

export default function register(r, db) {
  r.get('/api/tables', can('pos', 'tables_manage', 'qr_orders', 'billing', 'live_orders'), (ctx) => {
    const tables = db.all(`SELECT t.*, u.name AS lock_name FROM dining_tables t LEFT JOIN users u ON u.id = t.lock_user_id
      WHERE t.restaurant_id = ? ORDER BY t.area, t.sort, t.id`, ctx.rid);
    const orders = db.all(`SELECT o.id, o.table_id, o.status, o.total, o.created_at, o.order_no,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'pending') AS pending_items,
        (SELECT COALESCE(SUM(qty), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.status NOT IN ('cancelled','pending')) AS item_count
      FROM orders o WHERE o.restaurant_id = ? AND o.status IN ('awaiting','open','billed') AND o.table_id IS NOT NULL`, ctx.rid);
    const t0 = Date.now();
    return tables.map((t) => {
      const lockLive = t.lock_user_id && t.lock_at && t0 - Date.parse(t.lock_at) < LOCK_TTL_MS;
      return {
        ...t,
        lock_user_id: lockLive ? t.lock_user_id : null,
        lock_name: lockLive ? t.lock_name : null,
        locked_by_me: lockLive && t.lock_user_id === ctx.user.id,
        order: orders.find((o) => o.table_id === t.id) || null,
      };
    });
  });

  r.post('/api/tables', can('tables_manage'), (ctx) => {
    const b = ctx.body;
    const plan = db.get('SELECT max_tables FROM plans WHERE id = ?', ctx.restaurant.plan_id);
    const count = db.get('SELECT COUNT(*) AS c FROM dining_tables WHERE restaurant_id = ?', ctx.rid).c;
    const bulk = num(b.count, 'Number of tables', { min: 1, max: 100, int: true });
    const adding = bulk || 1;
    if (plan && count + adding > plan.max_tables) {
      throw forbidden(`Your plan allows ${plan.max_tables} tables. Upgrade your plan to add more.`, 'PLAN_LIMIT');
    }
    const area = str(b.area, 'Area', { max: 40 }) || 'Main Hall';
    const seats = num(b.seats, 'Seats', { min: 1, max: 50, int: true }) ?? 4;
    const ts = now();
    const created = [];
    db.tx(() => {
      if (bulk) {
        const prefix = str(b.prefix, 'Prefix', { max: 10 }) || 'T';
        let n = 1;
        for (let i = 0; i < bulk; i++) {
          while (db.get('SELECT id FROM dining_tables WHERE restaurant_id = ? AND name = ?', ctx.rid, `${prefix}${n}`)) n++;
          created.push(db.run('INSERT INTO dining_tables (restaurant_id, name, area, seats, qr_token, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ctx.rid, `${prefix}${n}`, area, seats, randomToken(9), count + i + 1, ts).id);
          n++;
        }
      } else {
        const name = str(b.name, 'Table name', { required: true, max: 30 });
        if (db.get('SELECT id FROM dining_tables WHERE restaurant_id = ? AND name = ?', ctx.rid, name)) throw conflict(`A table named ${name} already exists.`);
        created.push(db.run('INSERT INTO dining_tables (restaurant_id, name, area, seats, qr_token, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ctx.rid, name, area, seats, randomToken(9), count + 1, ts).id);
      }
    });
    return { created };
  });

  r.put('/api/tables/:id', can('tables_manage'), (ctx) => {
    const t = getTable(db, ctx.rid, ctx.params.id);
    const name = str(ctx.body.name ?? t.name, 'Table name', { required: true, max: 30 });
    if (db.get('SELECT id FROM dining_tables WHERE restaurant_id = ? AND name = ? AND id != ?', ctx.rid, name, t.id)) throw conflict(`A table named ${name} already exists.`);
    db.run('UPDATE dining_tables SET name = ?, area = ?, seats = ? WHERE id = ?', name,
      str(ctx.body.area ?? t.area, 'Area', { max: 40 }) || 'Main Hall', num(ctx.body.seats ?? t.seats, 'Seats', { min: 1, max: 50, int: true }), t.id);
    return { ok: true };
  });

  r.delete('/api/tables/:id', can('tables_manage'), (ctx) => {
    const t = getTable(db, ctx.rid, ctx.params.id);
    if (activeOrderForTable(db, ctx.rid, t.id)) throw conflict('This table has a running order. Settle it first.');
    db.run('DELETE FROM dining_tables WHERE id = ?', t.id);
    return { ok: true };
  });

  r.post('/api/tables/:id/regenerate-qr', can('tables_manage'), (ctx) => {
    const t = getTable(db, ctx.rid, ctx.params.id);
    db.run('UPDATE dining_tables SET qr_token = ? WHERE id = ?', randomToken(9), t.id);
    return { ok: true };
  });

  r.get('/api/tables/qr', can('tables_manage'), (ctx) => ({
    restaurant: ctx.restaurant.name,
    tables: db.all('SELECT id, name, area, qr_token FROM dining_tables WHERE restaurant_id = ? ORDER BY area, sort, id', ctx.rid)
      .map((t) => ({ ...t, url: `${baseUrl(ctx)}/m/${t.qr_token}` })),
  }));

  /** Open a table: it becomes yours. Others see a lock with your name; the owner can still open it. */
  r.post('/api/tables/:id/open', can('pos'), (ctx) => {
    const t = getTable(db, ctx.rid, ctx.params.id);
    const t0 = Date.now();
    const lockLive = t.lock_user_id && t.lock_at && t0 - Date.parse(t.lock_at) < LOCK_TTL_MS;
    let openedAsOwner = false;
    if (lockLive && t.lock_user_id !== ctx.user.id) {
      const holder = db.get('SELECT name FROM users WHERE id = ?', t.lock_user_id);
      if (!has(ctx, 'open_any_table')) {
        throw new HttpError(423, `Table ${t.name} is being served by ${holder?.name || 'another waiter'} right now.`, 'TABLE_LOCKED', { by: holder?.name });
      }
      openedAsOwner = true;
    } else {
      db.run('UPDATE dining_tables SET lock_user_id = ?, lock_at = ? WHERE id = ?', ctx.user.id, now(), t.id);
    }
    const order = activeOrderForTable(db, ctx.rid, t.id);
    return {
      table: db.get('SELECT * FROM dining_tables WHERE id = ?', t.id),
      order: order ? orderDetail(db, ctx.rid, order.id) : null,
      openedAsOwner,
      message: openedAsOwner ? 'Opened as owner. The waiter keeps the table.' : null,
    };
  });

  r.post('/api/tables/:id/close', can('pos'), (ctx) => {
    const t = getTable(db, ctx.rid, ctx.params.id);
    if (t.lock_user_id === ctx.user.id) db.run('UPDATE dining_tables SET lock_user_id = NULL, lock_at = NULL WHERE id = ?', t.id);
    return { ok: true };
  });

  /** Mark free (after cleaning), reserved or cleaning. */
  r.post('/api/tables/:id/status', can('pos', 'tables_manage'), (ctx) => {
    const t = getTable(db, ctx.rid, ctx.params.id);
    const status = oneOf(ctx.body.status, 'Status', ['free', 'reserved', 'cleaning']);
    if (activeOrderForTable(db, ctx.rid, t.id)) throw badRequest(`Table ${t.name} has a running order.`);
    db.run('UPDATE dining_tables SET status = ?, lock_user_id = NULL, lock_at = NULL WHERE id = ?', status, t.id);
    return { ok: true };
  });
}

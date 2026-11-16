import { can, has } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { recalcOrder } from '../lib/orders.js';
import { now } from '../lib/util.js';

const NEXT = { new: 'preparing', preparing: 'ready', ready: 'served' };
const STAMP = { preparing: 'started_at', ready: 'ready_at', served: 'served_at' };

export default function register(r, db) {
  r.get('/api/kitchen', can('kitchen', 'pos'), (ctx) => {
    const station = ctx.query.station;
    const params = [ctx.rid];
    let where = "k.restaurant_id = ? AND (k.status IN ('new','preparing','ready') OR (k.status = 'served' AND k.served_at >= ?))";
    params.push(new Date(Date.now() - 15 * 60000).toISOString());
    if (station) { where += ' AND k.station = ?'; params.push(station); }
    const kots = db.all(`SELECT k.*, o.order_no, o.type, o.customer_name, o.source, t.name AS table_name, u.name AS created_by_name
      FROM kots k JOIN orders o ON o.id = k.order_id LEFT JOIN dining_tables t ON t.id = o.table_id
      LEFT JOIN users u ON u.id = k.created_by WHERE ${where} ORDER BY k.created_at`, ...params);
    for (const k of kots) {
      k.items = db.all("SELECT id, name, qty, note, seat, veg, status FROM order_items WHERE kot_id = ? AND status != 'cancelled' ORDER BY id", k.id);
    }
    return {
      kots: kots.filter((k) => k.items.length),
      stations: ctx.settings.stations,
      amber: ctx.settings.kitchen_amber_minutes,
      red: ctx.settings.kitchen_red_minutes,
      server_time: now(),
    };
  });

  /** Tap to move a ticket along: New → Preparing → Ready → Picked up. */
  r.post('/api/kitchen/kots/:id/advance', can('kitchen', 'pos'), (ctx) => {
    const k = db.get('SELECT * FROM kots WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!k) throw notFound('Ticket not found.');
    const to = ctx.body.to || NEXT[k.status];
    if (!to || !Object.values(NEXT).includes(to)) throw badRequest('This ticket is already complete.');
    if (!has(ctx, 'kitchen') && to !== 'served') throw forbidden('Only the kitchen can change cooking status.');
    const ts = now();
    db.tx(() => {
      db.run(`UPDATE kots SET status = ?, ${STAMP[to]} = ? WHERE id = ?`, to, ts, k.id);
      db.run("UPDATE order_items SET status = ? WHERE kot_id = ? AND status NOT IN ('cancelled')", to, k.id);
    });
    return db.get('SELECT * FROM kots WHERE id = ?', k.id);
  });

  r.post('/api/kitchen/kots/:id/cancel', can('cancel_items'), (ctx) => {
    const k = db.get('SELECT * FROM kots WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!k) throw notFound('Ticket not found.');
    db.tx(() => {
      db.run("UPDATE kots SET status = 'cancelled' WHERE id = ?", k.id);
      db.run("UPDATE order_items SET status = 'cancelled', cancel_reason = ? WHERE kot_id = ?", String(ctx.body.reason || 'KOT cancelled').slice(0, 200), k.id);
      recalcOrder(db, k.order_id, ctx.settings);
    });
    return { ok: true };
  });
}

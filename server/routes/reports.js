import { can } from '../lib/auth.js';
import { badRequest } from '../lib/http.js';
import { dayBounds, localDate, round2 } from '../lib/util.js';

export default function register(r, db) {
  /** Daily item sales: every item sold that day, totals, discounts, net sales and payment split. */
  r.get('/api/reports/daily-items', can('reports'), (ctx) => {
    const day = dayBounds(ctx.query.date, ctx.settings.tz_offset_minutes);
    const base = "o.restaurant_id = ? AND o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ?";
    const items = db.all(`SELECT oi.name, SUM(oi.qty) AS qty, COUNT(DISTINCT o.id) AS orders, SUM(oi.qty * oi.price) AS amount
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${base} AND oi.status NOT IN ('cancelled','pending')
      GROUP BY oi.name ORDER BY amount DESC`, ctx.rid, day.from, day.to).map((x) => ({ ...x, amount: round2(x.amount) }));
    const t = db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal), 0) AS gross, COALESCE(SUM(discount), 0) AS discount,
        COALESCE(SUM(service_charge), 0) AS service_charge, COALESCE(SUM(tax), 0) AS tax, COALESCE(SUM(delivery_fee), 0) AS delivery_fee,
        COALESCE(SUM(round_off), 0) AS round_off, COALESCE(SUM(total), 0) AS net
      FROM orders o WHERE ${base}`, ctx.rid, day.from, day.to);
    const methods = db.all(`SELECT p.method, SUM(p.amount) AS amount, COUNT(*) AS count FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE ${base} GROUP BY p.method ORDER BY amount DESC`, ctx.rid, day.from, day.to);
    const byType = db.all(`SELECT type, COUNT(*) AS orders, SUM(total) AS amount FROM orders o WHERE ${base} GROUP BY type`, ctx.rid, day.from, day.to);
    const cancelled = db.get(`SELECT COUNT(*) AS c, COALESCE(SUM(oi.qty * oi.price), 0) AS v FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.restaurant_id = ? AND oi.status = 'cancelled' AND oi.created_at >= ? AND oi.created_at < ?`, ctx.rid, day.from, day.to);
    const open = db.get("SELECT COUNT(*) AS c FROM orders WHERE restaurant_id = ? AND status IN ('open','billed','awaiting')", ctx.rid).c;
    return {
      date: day.date,
      items,
      totals: { ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round2(v)])), quantity: items.reduce((s, x) => s + x.qty, 0) },
      methods: methods.map((m) => ({ ...m, amount: round2(m.amount) })),
      byType,
      cancelled,
      open_orders: open,
    };
  });

  /** Sales summary across a date range (max 92 days). */
  r.get('/api/reports/summary', can('reports'), (ctx) => {
    const off = ctx.settings.tz_offset_minutes;
    const to = dayBounds(ctx.query.to, off);
    const from = dayBounds(ctx.query.from || localDate(new Date(Date.parse(to.from) - 29 * 86400000 + off * 60000).toISOString(), 0), off);
    const span = (Date.parse(to.to) - Date.parse(from.from)) / 86400000;
    if (span < 1 || span > 92) throw badRequest('Choose a range of up to 92 days.');
    const rows = db.all(`SELECT paid_at, total, discount FROM orders WHERE restaurant_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?`,
      ctx.rid, from.from, to.to);
    const days = new Map();
    for (let t = Date.parse(from.from); t < Date.parse(to.to); t += 86400000) {
      const d = localDate(new Date(t).toISOString(), off);
      days.set(d, { date: d, orders: 0, total: 0 });
    }
    for (const row of rows) {
      const d = days.get(localDate(row.paid_at, off));
      if (d) { d.orders++; d.total = round2(d.total + row.total); }
    }
    const series = [...days.values()];
    const total = round2(series.reduce((s, d) => s + d.total, 0));
    const orders = series.reduce((s, d) => s + d.orders, 0);
    const categories = db.all(`SELECT COALESCE(c.name, 'Other') AS name, SUM(oi.qty * oi.price) AS amount FROM order_items oi
      JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.menu_item_id LEFT JOIN categories c ON c.id = m.category_id
      WHERE o.restaurant_id = ? AND o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ? AND oi.status NOT IN ('cancelled','pending')
      GROUP BY 1 ORDER BY amount DESC LIMIT 8`, ctx.rid, from.from, to.to);
    const staff = db.all(`SELECT u.name, COUNT(*) AS orders, SUM(o.total) AS amount FROM orders o JOIN users u ON u.id = o.captain_id
      WHERE o.restaurant_id = ? AND o.status = 'paid' AND o.paid_at >= ? AND o.paid_at < ? GROUP BY u.id ORDER BY amount DESC LIMIT 8`,
    ctx.rid, from.from, to.to);
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0 }));
    for (const row of rows) hours[new Date(Date.parse(row.paid_at) + off * 60000).getUTCHours()].orders++;
    return { from: from.date, to: to.date, series, total, orders, avg: orders ? round2(total / orders) : 0, categories, staff, hours };
  });
}

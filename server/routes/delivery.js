import { can } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { getOrder, orderDetail, recordPayments } from '../lib/orders.js';
import { dayBounds, now, str } from '../lib/util.js';

function riders(db, rid) {
  return db.all(`SELECT u.id, u.name, u.phone, COALESCE(rs.online, 0) AS online,
      (SELECT COUNT(*) FROM orders o WHERE o.rider_id = u.id AND o.delivery_status IN ('assigned','accepted','picked_up')) AS active
    FROM users u LEFT JOIN rider_status rs ON rs.user_id = u.id
    WHERE u.restaurant_id = ? AND u.role = 'rider' AND u.active = 1 ORDER BY online DESC, active, u.name`, rid);
}

function riderOrder(db, ctx) {
  const o = getOrder(db, ctx.rid, ctx.params.id);
  if (o.rider_id !== ctx.user.id) throw notFound('This delivery is not assigned to you.');
  return o;
}

export default function register(r, db) {
  r.get('/api/delivery', can('delivery'), (ctx) => {
    const today = dayBounds(null, ctx.settings.tz_offset_minutes);
    const orders = db.all(`SELECT o.*, u.name AS rider_name, u.phone AS rider_phone FROM orders o LEFT JOIN users u ON u.id = o.rider_id
      WHERE o.restaurant_id = ? AND o.type = 'delivery' AND (o.delivery_status != 'delivered' OR o.updated_at >= ?)
        AND o.status != 'cancelled' ORDER BY o.id DESC`, ctx.rid, today.from);
    for (const o of orders) o.items = db.all("SELECT name, qty, status FROM order_items WHERE order_id = ? AND status != 'cancelled'", o.id);
    return { orders, riders: riders(db, ctx.rid) };
  });

  /** Assign a rider — or auto-assign the free online rider with the fewest active deliveries. */
  r.post('/api/delivery/:id/assign', can('delivery'), (ctx) => {
    const o = getOrder(db, ctx.rid, ctx.params.id);
    if (o.type !== 'delivery') throw badRequest('This is not a delivery order.');
    if (['picked_up', 'delivered'].includes(o.delivery_status)) throw conflict('This order is already on its way.');
    let riderId = Number(ctx.body.rider_id);
    if (ctx.body.auto || !riderId) {
      const pick = riders(db, ctx.rid).find((x) => x.online);
      if (!pick) throw conflict('No rider is online right now.', 'NO_RIDER');
      riderId = pick.id;
    } else if (!db.get("SELECT id FROM users WHERE id = ? AND restaurant_id = ? AND role = 'rider' AND active = 1", riderId, ctx.rid)) {
      throw notFound('Rider not found.');
    }
    db.run("UPDATE orders SET rider_id = ?, delivery_status = 'assigned', updated_at = ? WHERE id = ?", riderId, now(), o.id);
    return orderDetail(db, ctx.rid, o.id);
  });

  // ---- Rider app ----
  r.get('/api/rider', can('rider'), (ctx) => {
    const status = db.get('SELECT online FROM rider_status WHERE user_id = ?', ctx.user.id);
    const today = dayBounds(null, ctx.settings.tz_offset_minutes);
    const orders = db.all(`SELECT o.* FROM orders o WHERE o.restaurant_id = ? AND o.rider_id = ? AND o.status != 'cancelled'
      AND (o.delivery_status != 'delivered' OR o.updated_at >= ?) ORDER BY o.delivery_status = 'delivered', o.id DESC`, ctx.rid, ctx.user.id, today.from);
    for (const o of orders) o.items = db.all("SELECT name, qty FROM order_items WHERE order_id = ? AND status != 'cancelled'", o.id);
    const cash = db.get(`SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p WHERE p.received_by = ? AND p.method = 'cash' AND p.created_at >= ?`,
      ctx.user.id, today.from).v;
    return { online: Boolean(status?.online), orders: orders.map(({ delivery_otp, ...o }) => o), cash_collected: cash };
  });

  r.post('/api/rider/online', can('rider'), (ctx) => {
    db.run(`INSERT INTO rider_status (user_id, online, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET online = excluded.online, updated_at = excluded.updated_at`, ctx.user.id, ctx.body.online ? 1 : 0, now());
    return { online: Boolean(ctx.body.online) };
  });

  r.post('/api/rider/orders/:id/accept', can('rider'), (ctx) => {
    const o = riderOrder(db, ctx);
    if (o.delivery_status !== 'assigned') throw conflict('This delivery was already accepted.');
    db.run("UPDATE orders SET delivery_status = 'accepted', updated_at = ? WHERE id = ?", now(), o.id);
    return { ok: true };
  });

  r.post('/api/rider/orders/:id/pickup', can('rider'), (ctx) => {
    const o = riderOrder(db, ctx);
    if (!['assigned', 'accepted'].includes(o.delivery_status)) throw conflict('This delivery is already picked up.');
    db.run("UPDATE orders SET delivery_status = 'picked_up', updated_at = ? WHERE id = ?", now(), o.id);
    db.run("UPDATE kots SET status = 'served', served_at = COALESCE(served_at, ?) WHERE order_id = ? AND status IN ('new','preparing','ready')", now(), o.id);
    db.run("UPDATE order_items SET status = 'served' WHERE order_id = ? AND status IN ('new','preparing','ready')", o.id);
    return { ok: true };
  });

  /** At the door: verify the customer's 4-digit code, then mark delivered (and collect COD). */
  r.post('/api/rider/orders/:id/deliver', can('rider'), (ctx) => {
    const o = riderOrder(db, ctx);
    if (o.delivery_status !== 'picked_up') throw conflict('Tap "Picked up" before delivering.');
    const otp = str(ctx.body.otp, 'Delivery code', { required: true, max: 6 });
    if (otp !== o.delivery_otp) throw badRequest('That code is not right. Ask the customer to check the 4-digit code.', 'BAD_OTP');
    db.tx(() => {
      const due = Math.round((o.total - o.paid) * 100) / 100;
      if (due > 0 && o.cod) recordPayments(db, ctx, o.id, [{ method: 'cash', amount: due, reference: 'Cash on delivery' }], { receivedBy: ctx.user.id });
      db.run("UPDATE orders SET delivery_status = 'delivered', updated_at = ? WHERE id = ?", now(), o.id);
    });
    return orderDetail(db, ctx.rid, o.id);
  });
}

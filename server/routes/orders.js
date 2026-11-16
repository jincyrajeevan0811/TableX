import { can, has } from '../lib/auth.js';
import { restaurantKeys, startCheckout, verifyCheckout } from '../lib/gateway.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import {
  ACTIVE_STATUSES, generateBill, getOrder, kitchenState, orderDetail, recalcOrder, recordPayments, sendKot,
} from '../lib/orders.js';
import { planFeatures } from '../lib/permissions.js';
import { dayBounds, now, num, oneOf, str } from '../lib/util.js';

export default function register(r, db) {
  /** Send KOT — creates the order if needed. Only the new items go to the kitchen. */
  r.post('/api/orders/kot', can('pos'), (ctx) => {
    const b = ctx.body;
    const type = oneOf(b.type, 'Order type', ['dine_in', 'takeaway', 'delivery'], 'dine_in');
    if (type === 'delivery' && !planFeatures(db, ctx.restaurant.plan_id).includes('delivery')) {
      throw forbidden('Home delivery is not part of your plan. Upgrade to enable it.', 'PLAN_FEATURE');
    }
    const tableId = num(b.table_id, 'Table', { int: true });
    if (type === 'dine_in' && tableId && !b.order_id) {
      const t = db.get('SELECT * FROM dining_tables WHERE id = ? AND restaurant_id = ?', tableId, ctx.rid);
      if (t?.lock_user_id && t.lock_user_id !== ctx.user.id && !has(ctx, 'open_any_table')
        && Date.now() - Date.parse(t.lock_at) < 4 * 3600 * 1000) {
        const holder = db.get('SELECT name FROM users WHERE id = ?', t.lock_user_id);
        throw new HttpError(423, `Table ${t.name} is being served by ${holder?.name || 'another waiter'} right now.`, 'TABLE_LOCKED');
      }
    }
    const customer = b.customer || {};
    const { order, replayed } = sendKot(db, ctx, {
      orderId: num(b.order_id, 'Order', { int: true }),
      tableId,
      type,
      customer: {
        name: str(customer.name, 'Customer name', { max: 80 }),
        phone: str(customer.phone, 'Customer phone', { max: 20 }),
        address: str(customer.address, 'Address', { max: 400 }),
        notes: str(customer.notes, 'Notes', { max: 300 }),
        cod: customer.cod !== false,
      },
      items: b.items,
      clientKey: str(b.client_key, 'client key', { max: 80 }) || null,
      force: Boolean(b.force),
    });
    return { order: orderDetail(db, ctx.rid, order.id), replayed: Boolean(replayed) };
  });

  r.get('/api/orders', can('pos', 'billing', 'live_orders', 'delivery'), (ctx) => {
    const type = ctx.query.type;
    const rows = db.all(`SELECT o.*, t.name AS table_name, c.name AS captain_name, r.name AS rider_name
      FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN users c ON c.id = o.captain_id
      LEFT JOIN users r ON r.id = o.rider_id
      WHERE o.restaurant_id = ? AND o.status IN ('awaiting','open','billed') ${type ? 'AND o.type = ?' : ''}
      ORDER BY o.id DESC LIMIT 200`, ...(type ? [ctx.rid, type] : [ctx.rid]));
    return rows;
  });

  r.get('/api/orders/:id', can('pos', 'billing', 'bills', 'live_orders', 'delivery', 'qr_orders'), (ctx) => orderDetail(db, ctx.rid, ctx.params.id));

  r.patch('/api/orders/:id', can('pos', 'billing', 'delivery'), (ctx) => {
    const o = getOrder(db, ctx.rid, ctx.params.id);
    const b = ctx.body;
    db.run('UPDATE orders SET customer_name = ?, customer_phone = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?',
      str(b.customer_name ?? o.customer_name, 'Customer name', { max: 80 }), str(b.customer_phone ?? o.customer_phone, 'Phone', { max: 20 }),
      str(b.address ?? o.address, 'Address', { max: 400 }), str(b.notes ?? o.notes, 'Notes', { max: 300 }), now(), o.id);
    return orderDetail(db, ctx.rid, o.id);
  });

  /** Move a running order to another (free) table. */
  r.post('/api/orders/:id/move', can('pos'), (ctx) => {
    const o = getOrder(db, ctx.rid, ctx.params.id);
    if (!ACTIVE_STATUSES.includes(o.status) || o.type !== 'dine_in') throw badRequest('Only running dine-in orders can be moved.');
    const to = db.get('SELECT * FROM dining_tables WHERE id = ? AND restaurant_id = ?', ctx.body.table_id, ctx.rid);
    if (!to) throw notFound('Table not found.');
    if (db.get("SELECT id FROM orders WHERE table_id = ? AND status IN ('awaiting','open','billed')", to.id)) throw conflict(`Table ${to.name} already has an order.`);
    db.tx(() => {
      db.run('UPDATE orders SET table_id = ?, updated_at = ? WHERE id = ?', to.id, now(), o.id);
      db.run("UPDATE dining_tables SET status = ?, lock_user_id = ?, lock_at = ? WHERE id = ?", o.status === 'billed' ? 'billed' : 'occupied', ctx.user.id, now(), to.id);
      db.run("UPDATE dining_tables SET status = 'cleaning', lock_user_id = NULL, lock_at = NULL WHERE id = ?", o.table_id);
    });
    return orderDetail(db, ctx.rid, o.id);
  });

  r.post('/api/order-items/:id/cancel', can('cancel_items'), (ctx) => {
    const item = db.get(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ? AND o.restaurant_id = ?`, ctx.params.id, ctx.rid);
    if (!item) throw notFound('Item not found.');
    const o = getOrder(db, ctx.rid, item.order_id);
    if (!ACTIVE_STATUSES.includes(o.status)) throw conflict('This order is already closed.');
    const qty = num(ctx.body.qty, 'Quantity', { min: 1, max: item.qty, int: true }) ?? item.qty;
    const reason = str(ctx.body.reason, 'Reason', { max: 200 });
    db.tx(() => {
      if (qty < item.qty) {
        db.run('UPDATE order_items SET qty = ? WHERE id = ?', item.qty - qty, item.id);
        db.run(`INSERT INTO order_items (order_id, menu_item_id, kot_id, name, price, qty, veg, station, note, seat, status, cancel_reason, added_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cancelled', ?, ?, ?)`, item.order_id, item.menu_item_id, item.kot_id, item.name, item.price, qty,
        item.veg, item.station, item.note, item.seat, reason, ctx.user.id, now());
      } else {
        db.run("UPDATE order_items SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, item.id);
      }
      if (item.kot_id && !db.get("SELECT id FROM order_items WHERE kot_id = ? AND status != 'cancelled'", item.kot_id)) {
        db.run("UPDATE kots SET status = 'cancelled' WHERE id = ?", item.kot_id);
      }
      recalcOrder(db, o.id, ctx.settings);
      if (o.status === 'billed') db.run("UPDATE orders SET status = 'open' WHERE id = ?", o.id);
    });
    return orderDetail(db, ctx.rid, o.id);
  });

  r.post('/api/orders/:id/cancel', can('cancel_items'), (ctx) => {
    const o = getOrder(db, ctx.rid, ctx.params.id);
    if (!ACTIVE_STATUSES.includes(o.status)) throw conflict('This order is already closed.');
    if (o.paid > 0) throw conflict('This order has payments. Refund them before cancelling.');
    const reason = str(ctx.body.reason, 'Reason', { max: 200 });
    db.tx(() => {
      db.run("UPDATE order_items SET status = 'cancelled', cancel_reason = ? WHERE order_id = ? AND status != 'cancelled'", reason, o.id);
      db.run("UPDATE kots SET status = 'cancelled' WHERE order_id = ? AND status != 'served'", o.id);
      db.run("UPDATE orders SET status = 'cancelled', notes = TRIM(notes || ' ' || ?), updated_at = ? WHERE id = ?", reason ? `Cancelled: ${reason}` : '', now(), o.id);
      if (o.table_id) db.run("UPDATE dining_tables SET status = 'free', lock_user_id = NULL, lock_at = NULL WHERE id = ?", o.table_id);
    });
    return { ok: true };
  });

  /** Print bill (optionally with a discount). */
  r.post('/api/orders/:id/bill', can('billing'), (ctx) => {
    const b = ctx.body;
    let discount = {};
    if (b.discount_value !== undefined) {
      const value = num(b.discount_value, 'Discount', { min: 0, max: 1e6 }) ?? 0;
      const type = oneOf(b.discount_type, 'Discount type', ['amount', 'percent'], 'amount');
      if (type === 'percent' && value > 100) throw badRequest('Discount cannot be more than 100%.');
      const o = getOrder(db, ctx.rid, ctx.params.id);
      const changed = value !== o.discount_value || type !== o.discount_type;
      if (changed && !has(ctx, 'discounts')) throw forbidden('You are not allowed to give discounts.');
      discount = { discountType: type, discountValue: value };
    }
    generateBill(db, ctx, ctx.params.id, discount);
    return orderDetail(db, ctx.rid, ctx.params.id);
  });

  /** Take payment — one or several methods (split). */
  r.post('/api/orders/:id/pay', can('billing'), (ctx) => {
    const payments = Array.isArray(ctx.body.payments) ? ctx.body.payments : [];
    if (!payments.length) throw badRequest('Choose a payment method.');
    recordPayments(db, ctx, ctx.params.id, payments.map((p) => ({
      method: String(p.method || ''), amount: Number(p.amount), reference: str(p.reference, 'Reference', { max: 120 }),
    })));
    return orderDetail(db, ctx.rid, ctx.params.id);
  });

  /** Collect the balance online with Razorpay (restaurant's own account). */
  r.post('/api/orders/:id/razorpay', can('billing'), async (ctx) => {
    if (!planFeatures(db, ctx.restaurant.plan_id).includes('online_payments')) throw forbidden('Online payments are not part of your plan.', 'PLAN_FEATURE');
    let o = getOrder(db, ctx.rid, ctx.params.id);
    if (o.status === 'open') o = generateBill(db, ctx, o.id);
    if (o.status !== 'billed') throw conflict('This bill cannot take payments.');
    const due = Math.round((o.total - o.paid) * 100) / 100;
    return startCheckout(db, {
      purpose: 'order', refId: o.id, restaurantId: ctx.rid, amount: due, receipt: o.bill_no,
      keys: restaurantKeys(ctx.settings), notes: { bill_no: o.bill_no, restaurant: ctx.restaurant.name },
    });
  });

  r.post('/api/orders/:id/razorpay/verify', can('billing'), (ctx) => {
    verifyCheckout(db, {
      gatewayOrderId: ctx.body.razorpay_order_id, paymentId: ctx.body.razorpay_payment_id, signature: ctx.body.razorpay_signature,
      keys: restaurantKeys(ctx.settings), expectPurpose: 'order', restaurantId: ctx.rid,
    });
    return orderDetail(db, ctx.rid, ctx.params.id);
  });

  // ---- QR orders awaiting acceptance ----
  r.get('/api/qr-orders', can('qr_orders'), (ctx) => {
    const orders = db.all(`SELECT DISTINCT o.*, t.name AS table_name FROM orders o JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN dining_tables t ON t.id = o.table_id
      WHERE o.restaurant_id = ? AND oi.status = 'pending' AND o.status IN ('awaiting','open','billed') ORDER BY o.updated_at`, ctx.rid);
    return orders.map((o) => ({
      ...o, items: db.all("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending' ORDER BY id", o.id),
    }));
  });

  r.post('/api/orders/:id/accept', can('qr_orders'), (ctx) => {
    const o = getOrder(db, ctx.rid, ctx.params.id);
    const pending = db.all("SELECT * FROM order_items WHERE order_id = ? AND status = 'pending'", o.id);
    if (!pending.length) throw conflict('Nothing is waiting for acceptance.');
    db.tx(() => {
      const ts = now();
      const byStation = new Map();
      for (const it of pending) {
        if (!byStation.has(it.station)) byStation.set(it.station, []);
        byStation.get(it.station).push(it);
      }
      for (const [station, items] of byStation) {
        const kotId = db.run(`INSERT INTO kots (restaurant_id, order_id, kot_no, station, status, created_by, created_at)
          VALUES (?, ?, ?, ?, 'new', ?, ?)`, ctx.rid, o.id, db.nextCounter(ctx.rid, 'kot'), station, ctx.user.id, ts).id;
        for (const it of items) db.run("UPDATE order_items SET status = 'new', kot_id = ?, created_at = ? WHERE id = ?", kotId, ts, it.id);
      }
      db.run("UPDATE orders SET status = 'open', captain_id = COALESCE(captain_id, ?), updated_at = ? WHERE id = ?", ctx.user.id, ts, o.id);
      if (o.table_id) db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", o.table_id);
      recalcOrder(db, o.id, ctx.settings);
    });
    return orderDetail(db, ctx.rid, o.id);
  });

  r.post('/api/orders/:id/reject', can('qr_orders'), (ctx) => {
    const o = getOrder(db, ctx.rid, ctx.params.id);
    db.tx(() => {
      db.run("UPDATE order_items SET status = 'cancelled', cancel_reason = ? WHERE order_id = ? AND status = 'pending'",
        str(ctx.body.reason, 'Reason', { max: 200 }) || 'Rejected', o.id);
      const live = db.get("SELECT COUNT(*) AS c FROM order_items WHERE order_id = ? AND status != 'cancelled'", o.id).c;
      if (!live) {
        db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), o.id);
        if (o.table_id && !db.get("SELECT id FROM orders WHERE table_id = ? AND id != ? AND status IN ('awaiting','open','billed')", o.table_id, o.id)) {
          db.run("UPDATE dining_tables SET status = 'free' WHERE id = ? AND status = 'occupied'", o.table_id);
        }
      }
    });
    return { ok: true };
  });

  // ---- Live orders ----
  r.get('/api/live-orders', can('live_orders'), (ctx) => {
    const orders = db.all(`SELECT o.*, t.name AS table_name, c.name AS captain_name FROM orders o
      LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN users c ON c.id = o.captain_id
      WHERE o.restaurant_id = ? AND o.status IN ('awaiting','open','billed') ORDER BY o.created_at`, ctx.rid);
    return orders.map((o) => {
      const items = db.all('SELECT id, name, qty, price, status, note FROM order_items WHERE order_id = ? ORDER BY id', o.id);
      return { ...o, items, kitchen_state: kitchenState(items) };
    });
  });

  // ---- Bills ----
  r.get('/api/bills', can('bills', 'billing'), (ctx) => {
    const q = String(ctx.query.q || '').trim();
    const params = [ctx.rid];
    let where = "o.restaurant_id = ? AND o.bill_no IS NOT NULL";
    if (q) {
      where += ' AND (o.bill_no LIKE ? OR t.name LIKE ? OR o.customer_phone LIKE ? OR o.customer_name LIKE ? OR CAST(o.order_no AS TEXT) = ?)';
      params.push(`%${q}%`, q, `%${q}%`, `%${q}%`, q);
    } else {
      const day = dayBounds(ctx.query.date, ctx.settings.tz_offset_minutes);
      where += ' AND o.billed_at >= ? AND o.billed_at < ?';
      params.push(day.from, day.to);
    }
    const bills = db.all(`SELECT o.id, o.bill_no, o.order_no, o.type, o.status, o.total, o.paid, o.customer_name, o.customer_phone,
        o.billed_at, o.paid_at, t.name AS table_name,
        (SELECT GROUP_CONCAT(DISTINCT method) FROM payments p WHERE p.order_id = o.id) AS methods
      FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id WHERE ${where} ORDER BY o.billed_at DESC LIMIT 300`, ...params);
    return { bills, total: bills.reduce((s, b) => s + (b.status === 'paid' ? b.total : 0), 0) };
  });
}

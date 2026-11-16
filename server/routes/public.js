import { config } from '../config.js';
import { rateLimit, restaurantSettings, subscriptionState } from '../lib/auth.js';
import { restaurantKeys, startCheckout, verifyCheckout } from '../lib/gateway.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/http.js';
import { activeOrderForTable, createOrder, generateBill, recalcOrder } from '../lib/orders.js';
import { planFeatures } from '../lib/permissions.js';
import { isConfigured } from '../lib/razorpay.js';
import { now, str } from '../lib/util.js';

/** Resolve a table QR token into a guest context. */
function guest(db, token) {
  const table = db.get('SELECT * FROM dining_tables WHERE qr_token = ?', String(token));
  if (!table) throw notFound('This QR code is not valid any more. Please ask the staff for help.');
  const restaurant = db.get('SELECT * FROM restaurants WHERE id = ?', table.restaurant_id);
  const settings = restaurantSettings(restaurant);
  const features = planFeatures(db, restaurant.plan_id);
  const sub = subscriptionState(restaurant);
  let ordering = true;
  let reason = null;
  if (!sub.active) { ordering = false; reason = 'Online ordering is not available right now. Please order with the staff.'; }
  else if (!features.includes('qr_ordering')) { ordering = false; reason = 'Please order with the staff.'; }
  else if (!settings.online_ordering) { ordering = false; reason = 'Online ordering is switched off right now. Please order with the staff.'; }
  const payOnline = sub.active && features.includes('online_payments')
    && (isConfigured(restaurantKeys(settings)) || config.allowDemoPayments);
  return { table, restaurant, settings, ordering, reason, payOnline, ctx: { rid: restaurant.id, restaurant, settings, user: null } };
}

function tableStatus(db, g) {
  const order = activeOrderForTable(db, g.restaurant.id, g.table.id);
  if (!order) return { order: null };
  const items = db.all("SELECT id, name, qty, price, veg, status FROM order_items WHERE order_id = ? AND status != 'cancelled' ORDER BY id", order.id);
  return {
    order: {
      id: order.id, order_no: order.order_no, status: order.status, bill_no: order.bill_no, subtotal: order.subtotal, discount: order.discount,
      service_charge: order.service_charge, tax: order.tax, round_off: order.round_off, total: order.total, paid: order.paid,
      balance: Math.round((order.total - order.paid) * 100) / 100, items,
    },
  };
}

export default function register(r, db) {
  r.get('/api/public/t/:token', (ctx) => {
    const g = guest(db, ctx.params.token);
    const { settings } = g;
    return {
      restaurant: { name: g.restaurant.name, address: g.restaurant.address, phone: g.restaurant.phone, city: g.restaurant.city },
      table: { name: g.table.name, area: g.table.area },
      ordering: g.ordering,
      reason: g.reason,
      pay_online: g.payOnline,
      charges: { service_charge_percent: settings.service_charge_percent, gst_enabled: settings.gst_enabled, gst_percent: settings.gst_percent },
      categories: db.all('SELECT id, name FROM categories WHERE restaurant_id = ? ORDER BY sort, name', g.restaurant.id),
      items: db.all('SELECT id, category_id, name, description, price, veg FROM menu_items WHERE restaurant_id = ? AND available = 1 ORDER BY name', g.restaurant.id),
      ...tableStatus(db, g),
    };
  });

  r.get('/api/public/t/:token/status', (ctx) => tableStatus(db, guest(db, ctx.params.token)));

  /** Guest places an order — it waits in "Awaiting acceptance" until staff accept it. */
  r.post('/api/public/t/:token/order', (ctx) => {
    const g = guest(db, ctx.params.token);
    if (!g.ordering) throw new HttpError(403, g.reason, 'ORDERING_OFF');
    rateLimit(`qr:${ctx.ip}:${g.table.id}`, 12, 10 * 60000);
    const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
    if (!items.length || items.length > 50) throw badRequest('Add items to your order.');
    const lines = items.map((it) => {
      const mi = db.get('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ? AND available = 1', Number(it.menu_item_id), g.restaurant.id);
      if (!mi) throw badRequest('Some items are not available any more. Please refresh the menu.', 'ITEM_UNAVAILABLE');
      const qty = Math.floor(Number(it.qty));
      if (!(qty >= 1 && qty <= 30)) throw badRequest('Please check the quantities.');
      return { mi, qty, note: String(it.note || '').slice(0, 120) };
    });
    const name = str(ctx.body.name, 'Name', { max: 60 });
    const phone = str(ctx.body.phone, 'Phone', { max: 15 });
    const orderId = db.tx(() => {
      let order = activeOrderForTable(db, g.restaurant.id, g.table.id);
      if (order && order.status === 'billed') throw conflict('Your bill is already printed. Please ask the staff to add more items.', 'BILLED');
      if (!order) {
        order = createOrder(db, g.ctx, { type: 'dine_in', tableId: g.table.id, source: 'qr', status: 'awaiting', customer: { name, phone }, settings: g.settings });
        db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", g.table.id);
      } else if (name || phone) {
        db.run("UPDATE orders SET customer_name = COALESCE(NULLIF(customer_name, ''), ?), customer_phone = COALESCE(NULLIF(customer_phone, ''), ?) WHERE id = ?", name, phone, order.id);
      }
      const ts = now();
      for (const l of lines) {
        db.run(`INSERT INTO order_items (order_id, menu_item_id, name, price, qty, veg, station, note, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, order.id, l.mi.id, l.mi.name, l.mi.price, l.qty, l.mi.veg, l.mi.station, l.note, ts);
      }
      db.run('UPDATE orders SET updated_at = ? WHERE id = ?', ts, order.id);
      db.run(`INSERT INTO notifications (restaurant_id, type, title, body, table_id, order_id, created_at) VALUES (?, 'qr_order', ?, ?, ?, ?, ?)`,
        g.restaurant.id, `New QR order — ${g.table.name}`, lines.map((l) => `${l.qty} × ${l.mi.name}`).join(', '), g.table.id, order.id, ts);
      recalcOrder(db, order.id, g.settings);
      return order.id;
    });
    return { ok: true, order_id: orderId, ...tableStatus(db, g) };
  });

  r.post('/api/public/t/:token/call-waiter', (ctx) => {
    const g = guest(db, ctx.params.token);
    const reason = ['waiter', 'bill', 'water'].includes(ctx.body.reason) ? ctx.body.reason : 'waiter';
    const recent = db.get(`SELECT id FROM notifications WHERE table_id = ? AND type = 'call_waiter' AND created_at > ?`,
      g.table.id, new Date(Date.now() - 30000).toISOString());
    if (recent) return { ok: true, throttled: true };
    const label = { waiter: 'is calling a waiter', bill: 'is asking for the bill', water: 'needs water' }[reason];
    db.run(`INSERT INTO notifications (restaurant_id, type, title, body, table_id, created_at) VALUES (?, 'call_waiter', ?, ?, ?, ?)`,
      g.restaurant.id, `Table ${g.table.name} ${label}`, '', g.table.id, now());
    return { ok: true };
  });

  /** Guest pays the table's balance online with Razorpay (restaurant's own account). */
  r.post('/api/public/t/:token/pay', async (ctx) => {
    const g = guest(db, ctx.params.token);
    if (!g.payOnline) throw new HttpError(403, 'Online payment is not available. Please pay at the counter.', 'PAY_OFF');
    let order = activeOrderForTable(db, g.restaurant.id, g.table.id);
    if (order && db.get("SELECT id FROM order_items WHERE order_id = ? AND status = 'pending'", order.id)) {
      throw conflict('Some items are still waiting for the staff to accept. Please try again in a moment.');
    }
    if (!order || order.subtotal <= 0) throw badRequest('There is no bill to pay yet.');
    if (order.status === 'open') order = generateBill(db, g.ctx, order.id);
    const due = Math.round((order.total - order.paid) * 100) / 100;
    const checkout = await startCheckout(db, {
      purpose: 'order', refId: order.id, restaurantId: g.restaurant.id, amount: due, receipt: order.bill_no,
      keys: restaurantKeys(g.settings), notes: { bill_no: order.bill_no, table: g.table.name },
    });
    return { ...checkout, name: g.restaurant.name, description: `Bill ${order.bill_no} — Table ${g.table.name}` };
  });

  r.post('/api/public/t/:token/pay/verify', (ctx) => {
    const g = guest(db, ctx.params.token);
    verifyCheckout(db, {
      gatewayOrderId: ctx.body.razorpay_order_id, paymentId: ctx.body.razorpay_payment_id, signature: ctx.body.razorpay_signature,
      keys: restaurantKeys(g.settings), expectPurpose: 'order', restaurantId: g.restaurant.id,
    });
    return { ok: true, ...tableStatus(db, g) };
  });
}

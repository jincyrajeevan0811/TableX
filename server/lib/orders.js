import { badRequest, conflict, notFound } from './http.js';
import { now, randomDigits, round2 } from './util.js';

export const ACTIVE_STATUSES = ['awaiting', 'open', 'billed'];
const COUNTED = "status NOT IN ('cancelled','pending')";

export function getOrder(db, rid, id) {
  const o = db.get('SELECT * FROM orders WHERE id = ? AND restaurant_id = ?', id, rid);
  if (!o) throw notFound('Order not found.');
  return o;
}

export function activeOrderForTable(db, rid, tableId) {
  return db.get(
    `SELECT * FROM orders WHERE restaurant_id = ? AND table_id = ? AND status IN ('awaiting','open','billed')
     ORDER BY id DESC LIMIT 1`, rid, tableId,
  );
}

export function recalcOrder(db, orderId, settings) {
  const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const { s } = db.get(`SELECT COALESCE(SUM(price * qty), 0) AS s FROM order_items WHERE order_id = ? AND ${COUNTED}`, orderId);
  const subtotal = round2(s);
  let discount = o.discount_type === 'percent' ? subtotal * (o.discount_value || 0) / 100 : (o.discount_value || 0);
  discount = round2(Math.min(Math.max(discount, 0), subtotal));
  const taxable = subtotal - discount;
  const svcPct = Number(settings.service_charge_percent) || 0;
  const service = o.type === 'dine_in' && svcPct > 0 ? round2(taxable * svcPct / 100) : 0;
  const tax = settings.gst_enabled ? round2((taxable + service) * (Number(settings.gst_percent) || 0) / 100) : 0;
  const deliveryFee = o.type === 'delivery' && subtotal > 0 ? round2(o.delivery_fee || 0) : 0;
  const gross = round2(taxable + service + tax + deliveryFee);
  const total = settings.round_off ? Math.round(gross) : gross;
  db.run(
    `UPDATE orders SET subtotal = ?, discount = ?, service_charge = ?, tax = ?, round_off = ?, total = ?, updated_at = ?
     WHERE id = ?`,
    subtotal, discount, service, tax, round2(total - gross), total, now(), orderId,
  );
  return db.get('SELECT * FROM orders WHERE id = ?', orderId);
}

export function createOrder(db, ctx, { type, tableId = null, source = 'pos', status = 'open', customer = {}, settings }) {
  const rid = ctx.rid;
  const ts = now();
  const orderNo = db.nextCounter(rid, 'order');
  const isDelivery = type === 'delivery';
  const { id } = db.run(
    `INSERT INTO orders (restaurant_id, order_no, type, source, table_id, status, customer_name, customer_phone, address,
       notes, captain_id, delivery_status, delivery_otp, delivery_fee, cod, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rid, orderNo, type, source, tableId, status, customer.name || '', customer.phone || '', customer.address || '',
    customer.notes || '', ctx.user?.id ?? null, isDelivery ? 'pending' : null, isDelivery ? randomDigits(4) : null,
    isDelivery ? Number(settings.delivery_fee) || 0 : 0, customer.cod === false ? 0 : 1, ts, ts,
  );
  return db.get('SELECT * FROM orders WHERE id = ?', id);
}

function loadMenuItems(db, rid, items) {
  if (!Array.isArray(items) || !items.length) throw badRequest('Add at least one item.');
  if (items.length > 200) throw badRequest('Too many items in one ticket.');
  return items.map((it) => {
    const mi = db.get('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?', Number(it.menu_item_id), rid);
    if (!mi) throw badRequest('One of the items is no longer on the menu. Please refresh.');
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) throw badRequest(`Quantity for ${mi.name} is not valid.`);
    return { mi, qty, note: String(it.note || '').slice(0, 200), seat: String(it.seat || '').slice(0, 20) };
  });
}

/**
 * Send a KOT: adds items to an order (creating it when needed) and splits them into one ticket per
 * kitchen station. `clientKey` makes the call idempotent so offline re-syncs never double-enter.
 */
export function sendKot(db, ctx, { orderId, tableId, type = 'dine_in', customer = {}, items, clientKey, force = false }) {
  const rid = ctx.rid;
  const settings = ctx.settings;
  return db.tx(() => {
    if (clientKey) {
      const prior = db.get('SELECT order_id FROM kots WHERE restaurant_id = ? AND client_key = ?', rid, clientKey);
      if (prior) return { order: db.get('SELECT * FROM orders WHERE id = ?', prior.order_id), replayed: true };
    }
    const lines = loadMenuItems(db, rid, items);
    let order = null;
    if (orderId) {
      order = getOrder(db, rid, orderId);
      if (!ACTIVE_STATUSES.includes(order.status)) throw conflict('This order is already closed.', 'ORDER_CLOSED');
    } else if (type === 'dine_in') {
      if (!tableId) throw badRequest('Choose a table.');
      const table = db.get('SELECT * FROM dining_tables WHERE id = ? AND restaurant_id = ?', tableId, rid);
      if (!table) throw notFound('Table not found.');
      order = activeOrderForTable(db, rid, table.id);
    }

    if (order && !force) {
      const recent = db.all(
        `SELECT oi.menu_item_id, oi.qty, u.name AS by_name FROM order_items oi LEFT JOIN users u ON u.id = oi.added_by
         WHERE oi.order_id = ? AND oi.status != 'cancelled' AND oi.status != 'pending' AND oi.created_at >= ?`,
        order.id, new Date(Date.now() - 120000).toISOString(),
      );
      const dupes = lines.filter((l) => recent.some((r) => r.menu_item_id === l.mi.id && r.qty === l.qty));
      if (recent.length && dupes.length === lines.length) {
        const by = recent.find((r) => r.menu_item_id === dupes[0].mi.id)?.by_name || 'someone';
        throw conflict(
          `Already added — these items were already added to this order by ${by} a moment ago.`,
          'DUPLICATE_ITEMS', { items: dupes.map((d) => `${d.qty} × ${d.mi.name}`), by },
        );
      }
    }

    if (!order) {
      if (type === 'delivery' && !String(customer.phone || '').trim()) throw badRequest('Customer mobile number is required for delivery.');
      if (type === 'delivery' && !String(customer.address || '').trim()) throw badRequest('Delivery address is required.');
      order = createOrder(db, ctx, { type, tableId: type === 'dine_in' ? tableId : null, customer, settings });
    }

    const ts = now();
    const byStation = new Map();
    for (const l of lines) {
      const station = l.mi.station || 'Main Kitchen';
      if (!byStation.has(station)) byStation.set(station, []);
      byStation.get(station).push(l);
    }
    const kotIds = [];
    for (const [station, group] of byStation) {
      const kotNo = db.nextCounter(rid, 'kot');
      const { id: kotId } = db.run(
        `INSERT INTO kots (restaurant_id, order_id, kot_no, station, status, client_key, created_by, created_at)
         VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`,
        rid, order.id, kotNo, station, clientKey || null, ctx.user.id, ts,
      );
      kotIds.push(kotId);
      for (const l of group) {
        db.run(
          `INSERT INTO order_items (order_id, menu_item_id, kot_id, name, price, qty, veg, station, note, seat, status, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
          order.id, l.mi.id, kotId, l.mi.name, l.mi.price, l.qty, l.mi.veg, station, l.note, l.seat, ctx.user.id, ts,
        );
      }
    }
    // Adding items to a printed bill re-opens it so the bill is regenerated with the new items.
    db.run(
      `UPDATE orders SET status = 'open', captain_id = COALESCE(captain_id, ?), updated_at = ? WHERE id = ?`,
      ctx.user.id, ts, order.id,
    );
    if (order.table_id) db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", order.table_id);
    return { order: recalcOrder(db, order.id, settings), kotIds };
  });
}

export function generateBill(db, ctx, orderId, { discountType, discountValue } = {}) {
  return db.tx(() => {
    const order = getOrder(db, ctx.rid, orderId);
    if (!['open', 'billed'].includes(order.status)) throw conflict('Only running orders can be billed.', 'ORDER_CLOSED');
    if (discountType !== undefined) {
      db.run('UPDATE orders SET discount_type = ?, discount_value = ? WHERE id = ?', discountType, discountValue || 0, order.id);
    }
    const o = recalcOrder(db, order.id, ctx.settings);
    if (o.subtotal <= 0) throw badRequest('There is nothing to bill yet.');
    const billNo = o.bill_no || `TX${String(db.nextCounter(ctx.rid, 'bill')).padStart(5, '0')}`;
    db.run(
      "UPDATE orders SET status = 'billed', bill_no = ?, billed_at = COALESCE(billed_at, ?), updated_at = ? WHERE id = ?",
      billNo, now(), now(), o.id,
    );
    if (o.table_id) db.run("UPDATE dining_tables SET status = 'billed' WHERE id = ?", o.table_id);
    return db.get('SELECT * FROM orders WHERE id = ?', o.id);
  });
}

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'razorpay', 'wallet', 'other'];

/** Record one or more payments (split payments supported). Settles the order when fully paid. */
export function recordPayments(db, ctx, orderId, payments, { receivedBy } = {}) {
  return db.tx(() => {
    let order = getOrder(db, ctx.rid, orderId);
    if (order.status === 'paid') throw conflict('This bill is already paid.', 'ALREADY_PAID');
    if (!['open', 'billed'].includes(order.status)) throw conflict('This order cannot take payments.', 'ORDER_CLOSED');
    if (order.status === 'open') order = generateBill(db, ctx, order.id);
    const ts = now();
    let added = 0;
    for (const p of payments) {
      const amount = round2(p.amount);
      if (!(amount > 0)) continue;
      if (!PAYMENT_METHODS.includes(p.method)) throw badRequest('Choose a valid payment method.');
      db.run(
        'INSERT INTO payments (restaurant_id, order_id, method, amount, reference, received_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ctx.rid, order.id, p.method, amount, String(p.reference || '').slice(0, 120), receivedBy ?? ctx.user?.id ?? null, ts,
      );
      added += amount;
    }
    if (added <= 0) throw badRequest('Enter the amount received.');
    const paid = round2((order.paid || 0) + added);
    if (paid > order.total + 0.005) throw badRequest(`Payment is more than the bill. Balance due is ₹${round2(order.total - order.paid)}.`);
    db.run('UPDATE orders SET paid = ?, updated_at = ? WHERE id = ?', paid, ts, order.id);
    if (paid >= order.total - 0.005) settleOrder(db, order.id);
    return db.get('SELECT * FROM orders WHERE id = ?', order.id);
  });
}

export function settleOrder(db, orderId) {
  const ts = now();
  const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  db.run("UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?", ts, ts, orderId);
  if (o.table_id) {
    const other = db.get(
      "SELECT id FROM orders WHERE table_id = ? AND id != ? AND status IN ('awaiting','open','billed')", o.table_id, orderId,
    );
    if (!other) db.run("UPDATE dining_tables SET status = 'free', lock_user_id = NULL, lock_at = NULL WHERE id = ?", o.table_id);
  }
}

export function orderDetail(db, rid, id) {
  const o = db.get(
    `SELECT o.*, t.name AS table_name, c.name AS captain_name, r.name AS rider_name, r.phone AS rider_phone
     FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN users c ON c.id = o.captain_id
     LEFT JOIN users r ON r.id = o.rider_id WHERE o.id = ? AND o.restaurant_id = ?`, id, rid,
  );
  if (!o) throw notFound('Order not found.');
  o.items = db.all(
    `SELECT oi.*, k.kot_no, u.name AS added_by_name FROM order_items oi LEFT JOIN kots k ON k.id = oi.kot_id
     LEFT JOIN users u ON u.id = oi.added_by WHERE oi.order_id = ? ORDER BY oi.id`, id,
  );
  o.payments = db.all(
    'SELECT p.*, u.name AS received_by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by WHERE p.order_id = ? ORDER BY p.id', id,
  );
  o.kots = db.all('SELECT * FROM kots WHERE order_id = ? ORDER BY id', id);
  o.balance = round2(o.total - o.paid);
  return o;
}

/** Overall kitchen state of an order, for Live Orders. */
export function kitchenState(items) {
  const live = items.filter((i) => !['cancelled'].includes(i.status));
  if (!live.length) return 'empty';
  if (live.some((i) => i.status === 'pending')) return 'awaiting';
  if (live.some((i) => i.status === 'new' || i.status === 'preparing')) return 'in_kitchen';
  if (live.some((i) => i.status === 'ready')) return 'ready';
  return 'served';
}

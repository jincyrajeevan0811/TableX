import { config } from '../config.js';
import { restaurantSettings } from './auth.js';
import { HttpError, badRequest, notFound } from './http.js';
import { recordPayments } from './orders.js';
import * as razorpay from './razorpay.js';
import { activateSubscription } from './subscriptions.js';
import { now } from './util.js';

export const platformKeys = () => ({ keyId: config.razorpay.keyId, keySecret: config.razorpay.keySecret });
export const restaurantKeys = (settings) => ({ keyId: settings.razorpay_key_id, keySecret: settings.razorpay_key_secret });

/** Create a Razorpay order and remember what it pays for. */
export async function startCheckout(db, { purpose, refId, restaurantId, amount, receipt, keys, notes }) {
  const order = await razorpay.createOrder(keys, { amount, receipt, notes }, { allowDemo: config.allowDemoPayments });
  db.run(
    `INSERT INTO gateway_orders (gateway_order_id, purpose, ref_id, restaurant_id, amount, status, demo, created_at)
     VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
    order.id, purpose, refId, restaurantId, amount, order.demo ? 1 : 0, now(),
  );
  return { key_id: order.demo ? 'demo' : keys.keyId, order_id: order.id, amount: order.amount, currency: order.currency, demo: order.demo };
}

/** Apply a captured payment exactly once (checkout callback and webhook may both arrive). */
export function applyPayment(db, gw, paymentId) {
  return db.tx(() => {
    const fresh = db.get('SELECT * FROM gateway_orders WHERE id = ?', gw.id);
    if (fresh.status === 'paid') return { already: true };
    db.run("UPDATE gateway_orders SET status = 'paid', payment_id = ? WHERE id = ?", paymentId, gw.id);
    if (gw.purpose === 'order') {
      const restaurant = db.get('SELECT * FROM restaurants WHERE id = ?', gw.restaurant_id);
      const ctx = { rid: restaurant.id, restaurant, settings: restaurantSettings(restaurant), user: null };
      const order = db.get('SELECT * FROM orders WHERE id = ?', gw.ref_id);
      if (order && order.status !== 'paid') {
        const due = Math.round((order.total - order.paid) * 100) / 100;
        recordPayments(db, ctx, order.id, [{ method: 'razorpay', amount: Math.min(due, gw.amount), reference: paymentId }], { receivedBy: null });
      }
    } else if (gw.purpose === 'subscription') {
      const sub = db.get('SELECT * FROM subscriptions WHERE id = ?', gw.ref_id);
      if (sub && sub.status === 'pending') {
        activateSubscription(db, {
          restaurantId: sub.restaurant_id, planId: sub.plan_id, cycle: sub.cycle, amount: sub.amount, source: gw.demo ? 'demo' : 'razorpay',
          subscriptionId: sub.id, razorpayOrderId: gw.gateway_order_id, razorpayPaymentId: paymentId,
        });
      }
    }
    return { already: false };
  });
}

/** Verify the checkout handler response and apply it. */
export function verifyCheckout(db, { gatewayOrderId, paymentId, signature, keys, expectPurpose, restaurantId }) {
  const gw = db.get('SELECT * FROM gateway_orders WHERE gateway_order_id = ?', String(gatewayOrderId || ''));
  if (!gw || gw.purpose !== expectPurpose || (restaurantId && gw.restaurant_id !== restaurantId)) throw notFound('Payment not found.');
  if (gw.demo) {
    if (!config.allowDemoPayments) throw new HttpError(400, 'Demo payments are disabled.', 'DEMO_DISABLED');
    return applyPayment(db, gw, paymentId || `demo_pay_${gw.id}`);
  }
  if (!paymentId || !signature) throw badRequest('Payment details are missing.');
  if (!razorpay.verifyPaymentSignature(keys.keySecret, gw.gateway_order_id, paymentId, signature)) {
    db.run("UPDATE gateway_orders SET status = 'failed' WHERE id = ?", gw.id);
    throw badRequest('Payment could not be verified. If money was deducted it will be refunded by Razorpay.', 'SIGNATURE_MISMATCH');
  }
  return applyPayment(db, gw, paymentId);
}

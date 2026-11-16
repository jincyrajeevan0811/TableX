import { addDays, now } from './util.js';

export const cycleDays = (cycle) => (cycle === 'yearly' ? 365 : 30);

/**
 * Activate (or extend) a restaurant's subscription. Time stacks: renewing early adds to the current end date.
 * Pass `subscriptionId` to activate an existing pending row (Razorpay flow); otherwise a new row is written.
 */
export function activateSubscription(db, { restaurantId, planId, cycle = 'monthly', periods = 1, days, amount = 0, source = 'manual',
  subscriptionId, razorpayOrderId = null, razorpayPaymentId = null, note = '', createdBy = null }) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM restaurants WHERE id = ?', restaurantId);
    const ts = now();
    const samePlanActive = r.subscription_ends_at && r.subscription_ends_at > ts && r.plan_id === planId;
    const start = samePlanActive ? r.subscription_ends_at : ts;
    const end = addDays(start, days ?? cycleDays(cycle) * periods);
    let id = subscriptionId;
    if (id) {
      db.run(
        `UPDATE subscriptions SET status = 'active', starts_at = ?, ends_at = ?, razorpay_payment_id = ?, source = ? WHERE id = ?`,
        start, end, razorpayPaymentId, source, id,
      );
    } else {
      ({ id } = db.run(
        `INSERT INTO subscriptions (restaurant_id, plan_id, cycle, amount, status, source, starts_at, ends_at, razorpay_order_id,
           razorpay_payment_id, note, created_by, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        restaurantId, planId, cycle, amount, source, start, end, razorpayOrderId, razorpayPaymentId, note, createdBy, ts,
      ));
    }
    // Switching plan replaces the old one immediately.
    if (!samePlanActive) {
      db.run("UPDATE subscriptions SET status = 'replaced' WHERE restaurant_id = ? AND status = 'active' AND id != ?", restaurantId, id);
    }
    db.run('UPDATE restaurants SET plan_id = ?, subscription_ends_at = ? WHERE id = ?', planId, end, restaurantId);
    return db.get('SELECT * FROM subscriptions WHERE id = ?', id);
  });
}

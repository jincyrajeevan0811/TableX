import { config } from '../config.js';
import { can } from '../lib/auth.js';
import { applyPayment, platformKeys, startCheckout, verifyCheckout } from '../lib/gateway.js';
import { badRequest, sendJson } from '../lib/http.js';
import { verifyWebhookSignature } from '../lib/razorpay.js';
import { FEATURES } from '../lib/permissions.js';
import { now, oneOf, parseJson } from '../lib/util.js';

export default function register(r, db) {
  r.get('/api/subscription', can('subscription'), (ctx) => {
    const r0 = ctx.restaurant;
    return {
      current: {
        plan: r0.plan_id ? { ...db.get('SELECT * FROM plans WHERE id = ?', r0.plan_id), features: undefined } : null,
        ends_at: r0.subscription_ends_at,
        active: ctx.subscription.active,
        reason: ctx.subscription.reason || null,
      },
      plans: db.all('SELECT * FROM plans WHERE active = 1 ORDER BY sort, id').map((p) => ({ ...p, features: parseJson(p.features, []) })),
      features: FEATURES,
      history: db.all(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.restaurant_id = ? AND s.status != 'pending' ORDER BY s.id DESC LIMIT 50`, ctx.rid),
      usage: {
        tables: db.get('SELECT COUNT(*) AS c FROM dining_tables WHERE restaurant_id = ?', ctx.rid).c,
        staff: db.get('SELECT COUNT(*) AS c FROM users WHERE restaurant_id = ? AND active = 1', ctx.rid).c,
        menu_items: db.get('SELECT COUNT(*) AS c FROM menu_items WHERE restaurant_id = ?', ctx.rid).c,
      },
      demo: !(config.razorpay.keyId && config.razorpay.keySecret),
    };
  });

  /** Buy / renew / change plan through Razorpay (platform account). */
  r.post('/api/subscription/checkout', can('subscription'), async (ctx) => {
    const plan = db.get('SELECT * FROM plans WHERE id = ? AND active = 1', Number(ctx.body.plan_id));
    if (!plan) throw badRequest('Choose a plan.');
    const cycle = oneOf(ctx.body.cycle, 'Billing cycle', ['monthly', 'yearly'], 'monthly');
    const amount = cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
    if (!(amount > 0)) throw badRequest('This plan has no price for that billing cycle.');
    const { id: subId } = db.run(`INSERT INTO subscriptions (restaurant_id, plan_id, cycle, amount, status, source, created_by, created_at)
      VALUES (?, ?, ?, ?, 'pending', 'razorpay', ?, ?)`, ctx.rid, plan.id, cycle, amount, ctx.user.id, now());
    const checkout = await startCheckout(db, {
      purpose: 'subscription', refId: subId, restaurantId: ctx.rid, amount, receipt: `sub_${subId}`, keys: platformKeys(),
      notes: { restaurant: ctx.restaurant.name, plan: plan.name, cycle },
    });
    db.run('UPDATE subscriptions SET razorpay_order_id = ? WHERE id = ?', checkout.order_id, subId);
    return {
      ...checkout, name: 'TableX', description: `${plan.name} plan — ${cycle}`,
      prefill: { name: ctx.user.name, email: ctx.user.email || '', contact: ctx.user.phone || '' },
    };
  });

  r.post('/api/subscription/verify', can('subscription'), (ctx) => {
    verifyCheckout(db, {
      gatewayOrderId: ctx.body.razorpay_order_id, paymentId: ctx.body.razorpay_payment_id, signature: ctx.body.razorpay_signature,
      keys: platformKeys(), expectPurpose: 'subscription', restaurantId: ctx.rid,
    });
    const r0 = db.get('SELECT subscription_ends_at, plan_id FROM restaurants WHERE id = ?', ctx.rid);
    return { ok: true, ends_at: r0.subscription_ends_at, plan_id: r0.plan_id };
  });

  /**
   * Razorpay webhook (configure in the Razorpay dashboard → Webhooks, event: payment.captured / order.paid).
   * Platform webhook secret verifies subscription payments; restaurant-level guest payments are verified
   * with that restaurant's own webhook secret (Settings → Payments).
   */
  r.post('/api/webhooks/razorpay', (ctx) => {
    const signature = ctx.req.headers['x-razorpay-signature'];
    const payload = JSON.parse(ctx.rawBody?.toString('utf8') || '{}');
    const entity = payload?.payload?.payment?.entity || {};
    const gw = entity.order_id ? db.get('SELECT * FROM gateway_orders WHERE gateway_order_id = ?', entity.order_id) : null;
    let secret = config.razorpay.webhookSecret;
    if (gw?.purpose === 'order') {
      const rest = db.get('SELECT settings FROM restaurants WHERE id = ?', gw.restaurant_id);
      secret = parseJson(rest?.settings, {}).razorpay_webhook_secret || '';
    }
    if (!verifyWebhookSignature(secret, ctx.rawBody || Buffer.alloc(0), signature)) {
      return sendJson(ctx.res, 400, { error: 'Invalid signature.' });
    }
    if (gw && ['payment.captured', 'order.paid'].includes(payload.event) && entity.status === 'captured') {
      applyPayment(db, gw, entity.id);
    }
    return { ok: true };
  });
}

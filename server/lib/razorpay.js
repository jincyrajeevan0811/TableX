import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { randomToken } from './util.js';

const API = 'https://api.razorpay.com/v1';

export const isConfigured = (keys) => Boolean(keys?.keyId && keys?.keySecret);

/**
 * Create a Razorpay order. When keys are missing and demo payments are allowed, a local demo order
 * is returned instead so the full flow can be exercised without a live account.
 */
export async function createOrder(keys, { amount, receipt, notes = {} }, { allowDemo = true } = {}) {
  const paise = Math.round(Number(amount) * 100);
  if (paise < 100) throw new HttpError(400, 'Amount must be at least ₹1.', 'AMOUNT_TOO_LOW');
  if (!isConfigured(keys)) {
    if (!allowDemo) throw new HttpError(503, 'Online payments are not configured yet.', 'PAYMENTS_NOT_CONFIGURED');
    return { id: `demo_order_${randomToken(10)}`, amount: paise, currency: 'INR', receipt, demo: true };
  }
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount: paise, currency: 'INR', receipt: String(receipt).slice(0, 40), notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(502, data?.error?.description || 'Could not reach Razorpay. Please try again.', 'GATEWAY_ERROR');
  }
  return { id: data.id, amount: data.amount, currency: data.currency, receipt: data.receipt, demo: false };
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Verify the checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyPaymentSignature(keySecret, orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Verify a webhook: HMAC_SHA256(raw body, webhook secret) === X-Razorpay-Signature. */
export function verifyWebhookSignature(webhookSecret, rawBody, signature) {
  if (!webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

// Razorpay Checkout helper shared by the staff app and the guest QR page.
import { session } from './api.js';
import { esc, icon, modal, money } from './ui.js';

// ---------------------------------------------------------------------------
// Razorpay Checkout
// ---------------------------------------------------------------------------
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Razorpay. Check the internet connection.'));
    document.head.appendChild(s);
  });
}

/** Opens Razorpay Checkout (or a clearly-labelled demo when keys are not configured). Resolves with the handler payload. */
export async function razorpayPay(checkout) {
  if (checkout.demo) {
    return new Promise((resolve, reject) => {
      let ok = false;
      const m = modal({
        title: 'Demo payment', size: 'narrow',
        body: `<div class="notice warning" style="margin-bottom:14px">${icon('info')}<div>Razorpay keys are not configured, so this is a <b>demo</b> — no money moves. Add keys in your environment / settings to take real payments.</div></div>
          <div style="text-align:center"><div class="muted">${esc(checkout.description || '')}</div><div style="font-size:30px;font-weight:800;margin-top:6px">${money(checkout.amount / 100)}</div></div>`,
        foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Simulate successful payment</button>',
        onClose: () => { if (!ok) reject(new Error('Payment cancelled.')); },
      });
      m.el.querySelector('[data-ok]').addEventListener('click', () => {
        ok = true; m.close();
        resolve({ razorpay_order_id: checkout.order_id, razorpay_payment_id: `demo_pay_${Date.now()}`, razorpay_signature: 'demo' });
      });
    });
  }
  await loadRazorpay();
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key: checkout.key_id, amount: checkout.amount, currency: checkout.currency || 'INR', name: checkout.name || session.me?.restaurant?.name || 'TableX',
      description: checkout.description || '', order_id: checkout.order_id, prefill: checkout.prefill || {},
      theme: { color: '#6247F5' }, handler: resolve, modal: { ondismiss: () => reject(new Error('Payment cancelled.')) },
    });
    rzp.on('payment.failed', (r) => reject(new Error(r.error?.description || 'Payment failed.')));
    rzp.open();
  });
}


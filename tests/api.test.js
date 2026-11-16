import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

process.env.SUPERADMIN_PHONE = '9000000000';
process.env.SUPERADMIN_PASSWORD = 'Super@123';
process.env.ALLOW_DEMO_PAYMENTS = 'true';
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';

const { createApp } = await import('../server/app.js');
const { verifyPaymentSignature, verifyWebhookSignature } = await import('../server/lib/razorpay.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tablex-test-'));
const { server, db } = createApp({ dbFile: path.join(tmp, 'test.db') });
let base;

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const login = async (loginId, password) => (await ok('POST', '/api/auth/login', { body: { login: loginId, password } })).token;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const S = {};

describe('TableX end-to-end', () => {
  test('super admin signs in and sees default plans', async () => {
    S.sa = await login('9000000000', 'Super@123');
    const plans = await ok('GET', '/api/admin/plans', { token: S.sa });
    assert.deepEqual(plans.map((p) => p.name), ['Average', 'Medium', 'Premium']);
    S.medium = plans.find((p) => p.code === 'medium');
    const bad = await call('POST', '/api/auth/login', { body: { login: '9000000000', password: 'nope' } });
    assert.equal(bad.status, 401);
  });

  test('super admin creates a custom plan', async () => {
    const p = await ok('POST', '/api/admin/plans', { token: S.sa, body: { name: 'Starter Lite', price_monthly: 499, price_yearly: 4990, max_tables: 3, max_staff: 3, features: ['qr_ordering', 'bogus'] } });
    assert.deepEqual(p.features, ['qr_ordering']);
    S.lite = p;
  });

  test('onboarding with pending access blocks staff until the plan is bought', async () => {
    const r = await ok('POST', '/api/admin/restaurants', { token: S.sa, body: { name: 'Test Bistro', owner_name: 'Olivia Owner', phone: '9811111111', password: 'Owner@123', plan_id: S.medium.id, access: 'pending', tables: 4 } });
    S.rid = r.id;
    S.owner = await login('9811111111', 'Owner@123');
    const me = await ok('GET', '/api/auth/me', { token: S.owner });
    assert.equal(me.subscription.active, false);
    const blocked = await call('GET', '/api/tables', { token: S.owner });
    assert.equal(blocked.status, 402);
    const sub = await ok('GET', '/api/subscription', { token: S.owner });
    assert.equal(sub.demo, true);
  });

  test('owner buys the Medium plan via (demo) Razorpay checkout', async () => {
    const co = await ok('POST', '/api/subscription/checkout', { token: S.owner, body: { plan_id: S.medium.id, cycle: 'monthly' } });
    assert.equal(co.demo, true);
    assert.equal(co.amount, S.medium.price_monthly * 100);
    const v = await ok('POST', '/api/subscription/verify', { token: S.owner, body: { razorpay_order_id: co.order_id, razorpay_payment_id: 'demo_pay_1', razorpay_signature: 'demo' } });
    assert.ok(Date.parse(v.ends_at) > Date.now() + 29 * 86400000);
    const again = await ok('POST', '/api/subscription/verify', { token: S.owner, body: { razorpay_order_id: co.order_id, razorpay_payment_id: 'demo_pay_1' } });
    assert.equal(again.ends_at, v.ends_at, 'verifying twice must not extend twice');
    await ok('GET', '/api/tables', { token: S.owner });
  });

  test('owner sets up staff, menu (CSV import) and settings', async () => {
    for (const [name, phone, role, pin] of [['Cara Captain', '9822222222', 'captain', '1234'], ['Cody Captain', '9822222223', 'captain', '2345'],
      ['Cash Carl', '9833333333', 'cashier', '3456'], ['Kitchen Kim', '9844444444', 'kitchen', ''], ['Rider Ravi', '9855555555', 'rider', ''], ['Adam Admin', '9866666666', 'admin', '']]) {
      await ok('POST', '/api/staff', { token: S.owner, body: { name, phone, role, password: 'Staff@123', pin } });
    }
    const dupPin = await call('POST', '/api/staff', { token: S.owner, body: { name: 'X', phone: '9877777777', role: 'captain', password: 'Staff@123', pin: '1234' } });
    assert.equal(dupPin.status, 409);
    const imp = await ok('POST', '/api/menu/import', { token: S.owner, body: { csv: 'name,category,price,veg\nChicken Biriyani, Biriyani, 250, non_veg\nVeg Biriyani, Biriyani, 180, veg\n"Tea, Masala", Hot Drinks, 30, veg\nbroken line' } });
    assert.equal(imp.imported, 3);
    assert.equal(imp.errors.length, 1);
    const menu = await ok('GET', '/api/menu', { token: S.owner });
    S.items = Object.fromEntries(menu.items.map((i) => [i.name, i]));
    assert.ok(S.items['Tea, Masala']);
    await ok('PUT', '/api/settings', { token: S.owner, body: { settings: { gst_enabled: true, gst_percent: 5, service_charge_percent: 10, round_off: true } } });
    S.tables = await ok('GET', '/api/tables', { token: S.owner });
    assert.equal(S.tables.length, 4);
  });

  test('captain opens a table; another captain sees the lock; owner opens as owner', async () => {
    S.cap1 = await login('9822222222', 'Staff@123');
    S.cap2 = await login('9822222223', 'Staff@123');
    const t1 = S.tables[0];
    const open = await ok('POST', `/api/tables/${t1.id}/open`, { token: S.cap1 });
    assert.equal(open.order, null);
    const locked = await call('POST', `/api/tables/${t1.id}/open`, { token: S.cap2 });
    assert.equal(locked.status, 423);
    assert.match(locked.data.error, /being served by Cara Captain/);
    const asOwner = await ok('POST', `/api/tables/${t1.id}/open`, { token: S.owner });
    assert.equal(asOwner.openedAsOwner, true);
  });

  test('send KOT splits by station, detects duplicates and is idempotent', async () => {
    const t1 = S.tables[0];
    const items = [{ menu_item_id: S.items['Chicken Biriyani'].id, qty: 2, note: 'less spicy' }, { menu_item_id: S.items['Tea, Masala'].id, qty: 1 }];
    const r = await ok('POST', '/api/orders/kot', { token: S.cap1, body: { type: 'dine_in', table_id: t1.id, items, client_key: 'k-1' } });
    S.order = r.order;
    assert.equal(r.order.items.length, 2);
    // subtotal 530, service 10% = 53, GST 5% of 583 = 29.15, gross 612.15 → 612
    assert.equal(r.order.subtotal, 530);
    assert.equal(r.order.service_charge, 53);
    assert.equal(r.order.tax, 29.15);
    assert.equal(r.order.total, 612);
    const replay = await ok('POST', '/api/orders/kot', { token: S.cap1, body: { type: 'dine_in', table_id: t1.id, items, client_key: 'k-1' } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.items.length, 2);
    const dup = await call('POST', '/api/orders/kot', { token: S.cap1, body: { type: 'dine_in', table_id: t1.id, items, client_key: 'k-2' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.code, 'DUPLICATE_ITEMS');
    const forced = await ok('POST', '/api/orders/kot', { token: S.cap1, body: { type: 'dine_in', table_id: t1.id, items: [items[1]], client_key: 'k-3', force: true } });
    assert.equal(forced.order.items.length, 3);
    const tables = await ok('GET', '/api/tables', { token: S.cap1 });
    assert.equal(tables.find((t) => t.id === t1.id).status, 'occupied');
    const otherCaptain = await call('POST', '/api/orders/kot', { token: S.cap2, body: { type: 'dine_in', table_id: t1.id, items: [items[1]] } });
    assert.equal(otherCaptain.status, 423);
  });

  test('kitchen moves tickets New → Preparing → Ready → Served', async () => {
    S.kitchen = await login('9844444444', 'Staff@123');
    const k = await ok('GET', '/api/kitchen', { token: S.kitchen });
    assert.ok(k.kots.length >= 1);
    const kot = k.kots[0];
    for (const expected of ['preparing', 'ready', 'served']) {
      const res = await ok('POST', `/api/kitchen/kots/${kot.id}/advance`, { token: S.kitchen, body: {} });
      assert.equal(res.status, expected);
    }
    const denied = await call('GET', '/api/reports/daily-items', { token: S.kitchen });
    assert.equal(denied.status, 403);
  });

  test('captain cannot bill; cashier bills with discount and takes split payment', async () => {
    const no = await call('POST', `/api/orders/${S.order.id}/bill`, { token: S.cap1, body: {} });
    assert.equal(no.status, 403);
    S.cashier = await login('9833333333', 'Staff@123');
    const billed = await ok('POST', `/api/orders/${S.order.id}/bill`, { token: S.cashier, body: { discount_type: 'amount', discount_value: 60 } });
    assert.equal(billed.status, 'billed');
    assert.match(billed.bill_no, /^TX\d{5}$/);
    const over = await call('POST', `/api/orders/${S.order.id}/pay`, { token: S.cashier, body: { payments: [{ method: 'cash', amount: billed.total + 100 }] } });
    assert.equal(over.status, 400);
    const part = await ok('POST', `/api/orders/${S.order.id}/pay`, { token: S.cashier, body: { payments: [{ method: 'cash', amount: 200 }] } });
    assert.equal(part.status, 'billed');
    const done = await ok('POST', `/api/orders/${S.order.id}/pay`, { token: S.cashier, body: { payments: [{ method: 'upi', amount: part.balance, reference: 'UPI123' }] } });
    assert.equal(done.status, 'paid');
    const tables = await ok('GET', '/api/tables', { token: S.cashier });
    const t1 = tables.find((t) => t.id === S.tables[0].id);
    assert.equal(t1.status, 'free');
    assert.equal(t1.lock_user_id, null);
    const bills = await ok('GET', `/api/bills?q=${billed.bill_no}`, { token: S.cashier });
    assert.equal(bills.bills.length, 1);
  });

  test('guest orders from the QR code, staff accept, guest pays online', async () => {
    const t2 = S.tables[1];
    const pub = await ok('GET', `/api/public/t/${t2.qr_token}`);
    assert.equal(pub.ordering, true);
    assert.equal(pub.pay_online, true);
    const placed = await ok('POST', `/api/public/t/${t2.qr_token}/order`, { body: { name: 'Guest Gita', items: [{ menu_item_id: S.items['Veg Biriyani'].id, qty: 2 }] } });
    assert.equal(placed.order.items[0].status, 'pending');
    const earlyPay = await call('POST', `/api/public/t/${t2.qr_token}/pay`, { body: {} });
    assert.equal(earlyPay.status, 409, 'cannot pay before staff accept');
    const waiting = await ok('GET', '/api/qr-orders', { token: S.cap2 });
    assert.equal(waiting.length, 1);
    const notifs = await ok('GET', '/api/notifications', { token: S.cap2 });
    assert.ok(notifs.items.some((n) => n.type === 'qr_order'));
    await ok('POST', `/api/orders/${placed.order.id}/accept`, { token: S.cap2 });
    await ok('POST', `/api/public/t/${t2.qr_token}/call-waiter`, { body: { reason: 'bill' } });
    const co = await ok('POST', `/api/public/t/${t2.qr_token}/pay`, { body: {} });
    assert.equal(co.demo, true);
    await ok('POST', `/api/public/t/${t2.qr_token}/pay/verify`, { body: { razorpay_order_id: co.order_id, razorpay_payment_id: 'demo_pay_2' } });
    const o = await ok('GET', `/api/orders/${placed.order.id}`, { token: S.owner });
    assert.equal(o.status, 'paid');
    assert.equal(o.payments[0].method, 'razorpay');
  });

  test('delivery: auto-assign rider, OTP check, cash on delivery', async () => {
    S.rider = await login('9855555555', 'Staff@123');
    const noRider = await ok('POST', '/api/orders/kot', { token: S.cap1, body: { type: 'delivery', customer: { name: 'Dev', phone: '9000011111', address: '12 Lake Road' }, items: [{ menu_item_id: S.items['Chicken Biriyani'].id, qty: 1 }] } });
    const conflict = await call('POST', `/api/delivery/${noRider.order.id}/assign`, { token: S.owner, body: { auto: true } });
    assert.equal(conflict.status, 409);
    await ok('POST', '/api/rider/online', { token: S.rider, body: { online: true } });
    const assigned = await ok('POST', `/api/delivery/${noRider.order.id}/assign`, { token: S.owner, body: { auto: true } });
    assert.equal(assigned.rider_name, 'Rider Ravi');
    assert.equal(assigned.delivery_fee, 30);
    const mine = await ok('GET', '/api/rider', { token: S.rider });
    assert.equal(mine.orders.length, 1);
    assert.equal(mine.orders[0].delivery_otp, undefined, 'rider must not see the OTP');
    await ok('POST', `/api/rider/orders/${assigned.id}/accept`, { token: S.rider });
    await ok('POST', `/api/rider/orders/${assigned.id}/pickup`, { token: S.rider });
    const wrong = await call('POST', `/api/rider/orders/${assigned.id}/deliver`, { token: S.rider, body: { otp: assigned.delivery_otp === '0000' ? '1111' : '0000' } });
    assert.equal(wrong.status, 400);
    const delivered = await ok('POST', `/api/rider/orders/${assigned.id}/deliver`, { token: S.rider, body: { otp: assigned.delivery_otp } });
    assert.equal(delivered.status, 'paid');
    assert.equal(delivered.delivery_status, 'delivered');
    assert.equal((await ok('GET', '/api/rider', { token: S.rider })).cash_collected, delivered.total);
  });

  test('daily item sales report adds up', async () => {
    const r = await ok('GET', '/api/reports/daily-items', { token: S.owner });
    assert.equal(r.totals.orders, 3);
    const methodSum = r.methods.reduce((s, m) => s + m.amount, 0);
    assert.equal(Math.round(methodSum * 100) / 100, r.totals.net);
    const dash = await ok('GET', '/api/dashboard', { token: S.owner });
    assert.equal(dash.today.orders, 3);
  });

  test('one login = one device for waiters', async () => {
    const fresh = await login('9822222222', 'Staff@123');
    const old = await call('GET', '/api/auth/me', { token: S.cap1 });
    assert.equal(old.status, 401);
    assert.equal(old.data.code, 'SESSION_REPLACED');
    S.cap1 = fresh;
    const ownerAgain = await login('9811111111', 'Owner@123');
    await ok('GET', '/api/auth/me', { token: S.owner }); // owners may use several devices
    S.owner = ownerAgain;
  });

  test('PIN quick switch on a shared device', async () => {
    const r = await ok('POST', '/api/auth/pin', { token: S.cashier, body: { pin: '2345' } });
    assert.equal(r.user.name, 'Cody Captain');
    const bad = await call('POST', '/api/auth/pin', { token: S.cashier, body: { pin: '9999' } });
    assert.equal(bad.status, 401);
  });

  test('role permissions: owner removes POS from captains, super admin restores per restaurant', async () => {
    await ok('PUT', '/api/roles/captain', { token: S.owner, body: { permissions: ['qr_orders'] } });
    const denied = await call('GET', '/api/menu', { token: S.cap1 });
    assert.equal(denied.status, 403);
    const detail = await ok('GET', `/api/admin/restaurants/${S.rid}`, { token: S.sa });
    assert.equal(detail.roles.find((x) => x.key === 'captain').custom, true);
    await ok('PUT', `/api/admin/restaurants/${S.rid}/roles/captain`, { token: S.sa, body: { reset: true } });
    await ok('GET', '/api/menu', { token: S.cap1 });
    const ownerLocked = await call('PUT', '/api/roles/owner', { token: S.owner, body: { permissions: [] } });
    assert.equal(ownerLocked.status, 400);
  });

  test('plan features gate permissions (inventory not in Medium)', async () => {
    const me = await ok('GET', '/api/auth/me', { token: S.owner });
    assert.ok(!me.permissions.includes('inventory'));
    assert.ok(me.permissions.includes('delivery'));
    const r = await call('GET', '/api/inventory', { token: S.owner });
    assert.equal(r.status, 403);
  });

  test('plan limits are enforced', async () => {
    await ok('POST', `/api/admin/restaurants/${S.rid}/subscription`, { token: S.sa, body: { plan_id: S.lite.id, cycle: 'monthly', amount: 0 } });
    const r = await call('POST', '/api/tables', { token: S.owner, body: { name: 'T99' } });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'PLAN_LIMIT');
    await ok('POST', `/api/admin/restaurants/${S.rid}/subscription`, { token: S.sa, body: { plan_id: S.medium.id, cycle: 'monthly' } });
  });

  test('super admin pauses and restores system access', async () => {
    await ok('POST', `/api/admin/restaurants/${S.rid}/status`, { token: S.sa, body: { status: 'suspended' } });
    const r = await call('GET', '/api/tables', { token: S.owner });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'RESTAURANT_SUSPENDED');
    const pub = await ok('GET', `/api/public/t/${S.tables[2].qr_token}`);
    assert.equal(pub.ordering, false);
    await ok('POST', `/api/admin/restaurants/${S.rid}/status`, { token: S.sa, body: { status: 'active' } });
    await ok('GET', '/api/tables', { token: S.owner });
    const stats = await ok('GET', '/api/admin/stats', { token: S.sa });
    assert.equal(stats.restaurants.total, 1);
    const notSa = await call('GET', '/api/admin/stats', { token: S.owner });
    assert.equal(notSa.status, 403);
  });

  test('restaurants cannot see each other\'s data', async () => {
    await ok('POST', '/api/admin/restaurants', { token: S.sa, body: { name: 'Other Place', owner_name: 'Otto', phone: '9899999999', password: 'Other@123', plan_id: S.medium.id, access: 'trial', tables: 1 } });
    const other = await login('9899999999', 'Other@123');
    const r = await call('GET', `/api/orders/${S.order.id}`, { token: other });
    assert.equal(r.status, 404);
    const kot = await call('POST', '/api/orders/kot', { token: other, body: { type: 'takeaway', items: [{ menu_item_id: S.items['Veg Biriyani'].id, qty: 1 }] } });
    assert.equal(kot.status, 400);
  });

  test('Razorpay signatures are verified with HMAC-SHA256', async () => {
    const secret = 'test_secret';
    const sig = crypto.createHmac('sha256', secret).update('order_1|pay_1').digest('hex');
    assert.equal(verifyPaymentSignature(secret, 'order_1', 'pay_1', sig), true);
    assert.equal(verifyPaymentSignature(secret, 'order_1', 'pay_2', sig), false);
    const body = Buffer.from('{"event":"payment.captured"}');
    const wsig = crypto.createHmac('sha256', 'wh').update(body).digest('hex');
    assert.equal(verifyWebhookSignature('wh', body, wsig), true);
    assert.equal(verifyWebhookSignature('', body, wsig), false);
    const hook = await fetch(`${base}/api/webhooks/razorpay`, { method: 'POST', headers: { 'x-razorpay-signature': 'bad' }, body });
    assert.equal(hook.status, 400);
  });

  test('static app and guest page are served', async () => {
    const home = await fetch(`${base}/`);
    assert.match(await home.text(), /<title>TableX/);
    const guest = await fetch(`${base}/m/${S.tables[0].qr_token}`);
    assert.match(await guest.text(), /order\.js/);
    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.notEqual(traversal.status, 200);
  });
});

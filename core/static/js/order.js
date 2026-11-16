// Guest QR ordering — opened by scanning a table's QR code (/m/<token>).
import { api } from './api.js';
import {
  $, busy, empty, esc, icon, modal, money, on, toast, toastError, vegDot,
} from './ui.js';
import { razorpayPay } from './pay.js';

const token = location.pathname.split('/').filter(Boolean)[1];
const KEY = `tx_guest_cart_${token}`;
let data = null;
let cart = (() => { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch { return {}; } })();
let q = '';
let cat = 'all';
let vegOnly = false;
let view = 'menu';

const saveCart = () => { try { sessionStorage.setItem(KEY, JSON.stringify(cart)); } catch { /* ignore */ } };
const count = () => Object.values(cart).reduce((s, x) => s + x, 0);
const cartTotal = () => Object.entries(cart).reduce((s, [id, n]) => s + (data.items.find((i) => String(i.id) === id)?.price || 0) * n, 0);
const ITEM_STATUS = { pending: ['danger', 'Waiting for staff'], new: ['primary', 'In the kitchen'], preparing: ['warning', 'Being prepared'], ready: ['success', 'Ready'], served: ['', 'Served'] };

async function load() {
  try {
    data = await api(`/api/public/t/${token}`, { auth: false });
    document.title = `${data.restaurant.name} · Table ${data.table.name}`;
    // Drop cart items that are no longer on the menu.
    Object.keys(cart).forEach((id) => { if (!data.items.some((i) => String(i.id) === id)) delete cart[id]; });
    draw();
  } catch (e) {
    $('#root').innerHTML = `<div class="g-wrap"><div class="card" style="margin:40px 16px">${empty('qr', 'Menu not available', e.message)}</div></div>`;
  }
}

async function refreshStatus() {
  try {
    const s = await api(`/api/public/t/${token}/status`, { auth: false });
    data.order = s.order;
    if (view === 'status') draw();
  } catch { /* ignore */ }
}

function draw() {
  const items = data.items.filter((i) => (cat === 'all' || i.category_id === Number(cat)) && (!vegOnly || i.veg) && (!q || i.name.toLowerCase().includes(q.toLowerCase())));
  const groups = (cat === 'all' ? [...data.categories, { id: null, name: 'More' }] : data.categories.filter((c) => String(c.id) === String(cat)))
    .map((c) => ({ ...c, items: items.filter((i) => (c.id === null ? !data.categories.some((x) => x.id === i.category_id) : i.category_id === c.id)) }))
    .filter((g) => g.items.length);
  const o = data.order;
  $('#root').innerHTML = `<div class="g-wrap">
    <header class="g-hero"><div class="row" style="position:relative;z-index:1"><img src="/static/assets/logo.svg" width="30" height="30" alt="" style="border-radius:9px;box-shadow:0 0 0 2px rgba(255,255,255,.3)"><span class="spacer"></span>
      ${o ? `<button class="btn sm" data-view="${view === 'menu' ? 'status' : 'menu'}" style="background:rgba(255,255,255,.2);border:0;color:#fff">${icon(view === 'menu' ? 'receipt' : 'menu_book', 15)} ${view === 'menu' ? 'My order' : 'Menu'}</button>` : ''}</div>
      <h1 style="margin-top:14px">${esc(data.restaurant.name)}</h1>
      <div class="t">${icon('armchair', 14)} Table ${esc(data.table.name)}</div></header>
    ${view === 'status' && o ? statusView(o) : `
    <div class="g-tools"><div class="card"><div class="input-icon">${icon('search', 17)}<input class="input" id="gq" placeholder="Search the menu…" value="${esc(q)}"></div></div></div>
    ${!data.ordering ? `<div class="notice warning" style="margin:14px">${icon('info')}<div>${esc(data.reason)}</div></div>` : ''}
    <div class="g-sticky"><div class="chips">
      <button class="chip ${vegOnly ? 'active' : ''}" data-veg>${vegDot(1)} Veg only</button>
      <button class="chip ${cat === 'all' ? 'active' : ''}" data-cat="all">All</button>
      ${data.categories.map((c) => `<button class="chip ${String(cat) === String(c.id) ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
    </div></div>
    ${groups.length ? groups.map((g) => `<div class="g-cat">${esc(g.name)}</div><div class="g-list">${g.items.map(itemRow).join('')}</div>`).join('')
    : `<div class="card" style="margin:14px">${empty('search', 'Nothing found', 'Try another search.')}</div>`}
    <p class="muted small" style="text-align:center;margin:26px 14px">${data.charges.gst_enabled ? `Prices exclude ${data.charges.gst_percent}% GST. ` : ''}${data.charges.service_charge_percent ? `${data.charges.service_charge_percent}% service charge applies. ` : ''}Powered by <b class="grad-text">TableX</b></p>`}
  </div>
  <div class="g-bar"><div class="inner">${barHtml()}</div></div>`;
  const gq = $('#gq');
  gq?.addEventListener('input', () => { q = gq.value; const p = gq.selectionStart; draw(); const n = $('#gq'); n.focus(); n.setSelectionRange(p, p); });
}

function itemRow(i) {
  const n = cart[i.id] || 0;
  return `<div class="g-item"><div style="flex:1;min-width:0"><div class="row" style="gap:7px">${vegDot(i.veg)}<span class="nm">${esc(i.name)}</span></div>
    ${i.description ? `<div class="ds">${esc(i.description)}</div>` : ''}<div class="pr money">${money(i.price)}</div></div>
    <div class="g-add">${!data.ordering ? '' : n ? `<div class="stepper"><button data-dec="${i.id}">${icon('minus', 14)}</button><span>${n}</span><button data-inc="${i.id}">${icon('plus', 14)}</button></div>`
    : `<button class="btn soft sm" data-inc="${i.id}">${icon('plus', 14)} Add</button>`}</div></div>`;
}

function barHtml() {
  const o = data.order;
  if (view === 'menu' && count()) return `<button class="btn primary xl block" data-cart>${icon('cart')} View cart · ${count()} item${count() > 1 ? 's' : ''} · ${money(cartTotal())}</button>`;
  if (view === 'menu' && o) return `<button class="btn xl block" data-view="status" style="background:var(--surface)">${icon('receipt')} My order · ${money(o.total)}</button>`;
  if (view === 'status') return `<button class="btn xl" data-view="menu" style="flex:1;background:var(--surface)">${icon('plus')} Order more</button>${data.pay_online && o && o.balance > 0 && !o.items.some((i) => i.status === 'pending') ? `<button class="btn primary xl" data-pay style="flex:1">${icon('card')} Pay ${money(o.balance)}</button>` : ''}`;
  return `<button class="btn xl block" data-call="waiter" style="background:var(--surface)">${icon('hand')} Call waiter</button>`;
}

function statusView(o) {
  const pendingSum = o.items.filter((i) => i.status === 'pending').reduce((t, i) => t + i.qty * i.price, 0);
  return `<div class="status-card card pad" style="margin-top:-34px;position:relative;z-index:2">
      <div class="row"><h2 style="flex:1">Your order</h2>${o.bill_no ? `<span class="badge info">Bill ${esc(o.bill_no)}</span>` : `<span class="badge primary">#${o.order_no}</span>`}</div>
      <div class="col" style="gap:10px;margin-top:14px">${o.items.map((i) => {
        const [cls, label] = ITEM_STATUS[i.status] || ['', i.status];
        return `<div class="row"><span class="st-dot ${i.status}"></span><span style="flex:1"><b>${i.qty}×</b> ${esc(i.name)}</span><span class="badge ${cls}">${label}</span></div>`;
      }).join('')}</div>
      <div style="border-top:1px dashed var(--border-strong);margin:14px 0 8px"></div>
      ${pendingSum ? `<div class="sum-row"><span>Waiting for confirmation</span><span class="money">${money(pendingSum)}</span></div>` : ''}
      <div class="sum-row"><span>${pendingSum ? 'Confirmed items' : 'Subtotal'}</span><span class="money">${money(o.subtotal)}</span></div>
      ${o.discount ? `<div class="sum-row"><span>Discount</span><span class="money">−${money(o.discount)}</span></div>` : ''}
      ${o.service_charge ? `<div class="sum-row"><span>Service charge</span><span class="money">${money(o.service_charge)}</span></div>` : ''}
      ${o.tax ? `<div class="sum-row"><span>GST</span><span class="money">${money(o.tax)}</span></div>` : ''}
      <div class="sum-row total"><span>${pendingSum ? 'Estimated total' : 'Total'}</span><span class="money">${money(o.total + pendingSum)}</span></div>
      ${pendingSum && (data.charges.gst_enabled || data.charges.service_charge_percent) ? '<div class="tiny muted">Taxes on new items are added once the staff confirm them.</div>' : ''}
      ${o.paid ? `<div class="sum-row"><span>Paid</span><span class="money">${money(o.paid)}</span></div>` : ''}
      ${o.items.some((i) => i.status === 'pending') ? `<div class="notice" style="margin-top:12px">${icon('clock')}<div>Your order has reached the staff. They will confirm it in a moment.</div></div>` : ''}
    </div>
    <div class="card pad" style="margin:14px">
      <div class="bold" style="margin-bottom:10px">Need something?</div>
      <div class="g-actions"><button class="btn" data-call="waiter">${icon('hand', 20)} Call waiter</button><button class="btn" data-call="water">${icon('water', 20)} Water</button><button class="btn" data-call="bill">${icon('receipt', 20)} Ask for bill</button></div>
    </div>`;
}

function openCart() {
  const lines = Object.entries(cart).map(([id, n]) => ({ item: data.items.find((i) => String(i.id) === id), n })).filter((l) => l.item);
  const m = modal({
    title: 'Your cart',
    body: `<div class="col" style="gap:12px" id="cl">${lines.map((l) => `<div class="row">${vegDot(l.item.veg)}<span style="flex:1" class="bold">${esc(l.item.name)}</span>
        <div class="stepper"><button data-cdec="${l.item.id}">${icon('minus', 14)}</button><span>${l.n}</span><button data-cinc="${l.item.id}">${icon('plus', 14)}</button></div>
        <span class="money" style="width:70px;text-align:right">${money(l.item.price * l.n)}</span></div>`).join('')}</div>
      <div class="sum-row total"><span>Items total</span><span class="money">${money(cartTotal())}</span></div>
      <div class="form-grid" style="margin-top:16px">
        <div class="field"><label>Your name (optional)</label><input class="input" id="gname" autocomplete="name"></div>
        <div class="field"><label>Mobile (optional)</label><input class="input" id="gphone" type="tel" autocomplete="tel"></div>
        <div class="field full"><label>Note for the kitchen</label><input class="input" id="gnote" placeholder="less spicy, no onion…" maxlength="120"></div>
      </div>`,
    foot: `<button class="btn" data-close>Add more</button><button class="btn primary lg" data-place>${icon('send')} Place order</button>`,
  });
  const refresh = () => { m.close(); if (count()) openCart(); draw(); };
  on(m.el, 'click', '[data-cinc]', (e, b) => { cart[b.dataset.cinc] = (cart[b.dataset.cinc] || 0) + 1; saveCart(); refresh(); });
  on(m.el, 'click', '[data-cdec]', (e, b) => { cart[b.dataset.cdec]--; if (cart[b.dataset.cdec] <= 0) delete cart[b.dataset.cdec]; saveCart(); refresh(); });
  m.el.querySelector('[data-place]').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const note = m.el.querySelector('#gnote').value;
      const res = await api(`/api/public/t/${token}/order`, {
        method: 'POST', auth: false,
        body: { name: m.el.querySelector('#gname').value, phone: m.el.querySelector('#gphone').value, items: Object.entries(cart).map(([id, qty], idx) => ({ menu_item_id: Number(id), qty, note: idx === 0 ? note : '' })) },
      });
      cart = {}; saveCart();
      data.order = res.order;
      view = 'status';
      m.close();
      draw();
      toast('Order sent! The staff will confirm it shortly.');
    } catch (err) { toastError(err); }
  }));
}

on(document, 'click', '[data-inc]', (e, b) => { cart[b.dataset.inc] = (cart[b.dataset.inc] || 0) + 1; saveCart(); draw(); });
on(document, 'click', '[data-dec]', (e, b) => { cart[b.dataset.dec]--; if (cart[b.dataset.dec] <= 0) delete cart[b.dataset.dec]; saveCart(); draw(); });
on(document, 'click', '[data-cat]', (e, b) => { cat = b.dataset.cat; draw(); });
on(document, 'click', '[data-veg]', () => { vegOnly = !vegOnly; draw(); });
on(document, 'click', '[data-view]', (e, b) => { view = b.dataset.view; draw(); window.scrollTo(0, 0); });
on(document, 'click', '[data-cart]', () => openCart());
on(document, 'click', '[data-call]', async (e, b) => {
  try {
    await api(`/api/public/t/${token}/call-waiter`, { method: 'POST', auth: false, body: { reason: b.dataset.call } });
    toast(b.dataset.call === 'bill' ? 'The staff will bring your bill' : b.dataset.call === 'water' ? 'Water is on its way' : 'A waiter is coming to your table');
  } catch (err) { toastError(err); }
});
on(document, 'click', '[data-pay]', (e, b) => busy(b, async () => {
  try {
    const checkout = await api(`/api/public/t/${token}/pay`, { method: 'POST', auth: false, body: {} });
    const resp = await razorpayPay(checkout);
    await api(`/api/public/t/${token}/pay/verify`, { method: 'POST', auth: false, body: resp });
    data.order = null;
    view = 'menu';
    draw();
    modal({ title: 'Payment successful', size: 'narrow', body: `<div class="empty" style="padding:10px"><div class="em-icon">${icon('check_circle', 30)}</div><h3>Thank you!</h3><p>Your bill is paid. We hope to see you again at ${esc(data.restaurant.name)}.</p></div>` });
  } catch (err) { toastError(err); }
}));

load();
setInterval(() => { if (!document.hidden && data) refreshStatus(); }, 10000);

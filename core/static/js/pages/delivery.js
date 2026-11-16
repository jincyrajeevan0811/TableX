import { api } from '../api.js';
import { can } from '../app.js';
import {
  badge, busy, empty, esc, formModal, icon, money, on, timeAgo, toast, toastError,
} from '../ui.js';
import { printBill } from './shared.js';

export default async function delivery(ctx) {
  let data = { orders: [], riders: [] };
  ctx.setTitle(`${icon('truck', 20)}<span>Delivery</span>`, can('pos') ? `<a class="btn primary sm" href="#/pos/new/delivery">${icon('plus', 15)} New delivery</a>` : '');

  const load = async () => {
    try { data = await api('/api/delivery'); if (ctx.isCurrent()) draw(); } catch (e) { if (e.code !== 'OFFLINE') toastError(e); }
  };

  const draw = () => {
    const active = data.orders.filter((o) => o.delivery_status !== 'delivered');
    const done = data.orders.filter((o) => o.delivery_status === 'delivered');
    ctx.el.innerHTML = `
      <div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;align-items:start" id="dl-grid">
        <div class="col" style="gap:16px">
          ${active.length ? active.map(card).join('') : `<div class="card">${empty('truck', 'No active deliveries', 'New delivery orders appear here. Assign a rider to send them out.')}</div>`}
          ${done.length ? `<h3 style="margin-top:8px">Delivered today (${done.length})</h3>${done.map(card).join('')}` : ''}
        </div>
        <div class="card"><div class="card-head"><h3>Riders</h3></div>
          ${data.riders.length ? data.riders.map((r) => `<div class="row" style="padding:12px 18px;border-bottom:1px solid var(--border)">
            <span class="avatar" style="${r.online ? '' : 'background:var(--surface-3);color:var(--muted)'}">${icon('bike', 16)}</span>
            <div style="flex:1"><div class="bold">${esc(r.name)}</div><div class="tiny muted">${r.online ? `Online · ${r.active} active` : 'Offline'}</div></div>
            ${r.phone ? `<a class="btn ghost icon sm" href="tel:${esc(r.phone)}">${icon('phone', 15)}</a>` : ''}</div>`).join('')
    : `<div class="card-body muted small">No rider logins yet. Add riders from Staff & Roles.</div>`}
        </div>
      </div>`;
    const g = ctx.el.querySelector('#dl-grid');
    if (window.innerWidth < 900) g.style.gridTemplateColumns = 'minmax(0,1fr)';
  };

  const card = (o) => `<div class="card lo-card">
    <div class="row"><div style="flex:1;min-width:0"><h2>#${o.order_no} · ${esc(o.customer_name || 'Guest')}</h2>
      <div class="small muted">${icon('phone', 12)} ${esc(o.customer_phone)} · ${timeAgo(o.created_at)}</div></div>
      ${badge(o.delivery_status || 'pending')}</div>
    <div class="small">${icon('pin', 13)} ${esc(o.address)}</div>
    <div class="small muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
    <div class="row wrap" style="gap:8px">
      <span class="badge">${o.cod ? 'Cash on delivery' : 'Prepaid'}</span>
      <span class="badge primary">Code ${esc(o.delivery_otp || '')}</span>
      ${o.rider_name ? `<span class="badge info">${icon('bike', 12)} ${esc(o.rider_name)}</span>` : ''}
      <span class="spacer"></span><b class="money">${money(o.total)}</b>
    </div>
    ${o.delivery_status !== 'delivered' ? `<div class="row wrap" style="gap:8px">
      <button class="btn sm" data-print="${o.id}">${icon('printer', 14)} Bill</button>
      <a class="btn sm" href="#/pos/order/${o.id}">${icon('pencil', 14)} Edit order</a>
      <span class="spacer"></span>
      ${['picked_up'].includes(o.delivery_status) ? '' : `<button class="btn sm" data-assign="${o.id}">${icon('users', 14)} ${o.rider_id ? 'Change rider' : 'Assign rider'}</button>
      <button class="btn sm primary" data-auto="${o.id}">${icon('zap', 14)} Auto-assign</button>`}
    </div>` : ''}
  </div>`;

  on(ctx.el, 'click', '[data-auto]', (e, b) => busy(b, async () => {
    try { const o = await api(`/api/delivery/${b.dataset.auto}/assign`, { method: 'POST', body: { auto: true } }); toast(`Assigned to ${o.rider_name}`); load(); } catch (err) { toastError(err); }
  }));
  on(ctx.el, 'click', '[data-assign]', async (e, b) => {
    if (!data.riders.length) return toast('No rider logins yet', 'info');
    await formModal({
      title: 'Assign rider', submitText: 'Assign',
      fields: [{ name: 'rider_id', label: 'Rider', type: 'select', full: true, options: data.riders.map((r) => [r.id, `${r.name} — ${r.online ? `online, ${r.active} active` : 'offline'}`]) }],
      onSubmit: async (v) => { const o = await api(`/api/delivery/${b.dataset.assign}/assign`, { method: 'POST', body: { rider_id: Number(v.rider_id) } }); toast(`Assigned to ${o.rider_name}`); load(); },
    });
  });
  on(ctx.el, 'click', '[data-print]', async (e, b) => {
    try {
      let o = await api(`/api/orders/${b.dataset.print}`);
      if (!o.bill_no && can('billing')) o = await api(`/api/orders/${o.id}/bill`, { method: 'POST', body: {} });
      printBill(o);
    } catch (err) { toastError(err); }
  });

  await load();
  ctx.every(load, 7000);
}

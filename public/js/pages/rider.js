import { api } from '../api.js';
import {
  badge, busy, empty, esc, formModal, icon, money, on, toast, toastError,
} from '../ui.js';

export default async function rider(ctx) {
  let data = { online: false, orders: [], cash_collected: 0 };
  ctx.setTitle(`${icon('bike', 20)}<span>Rider</span>`);

  const load = async () => {
    try { data = await api('/api/rider'); if (ctx.isCurrent()) draw(); } catch (e) { if (e.code !== 'OFFLINE') toastError(e); }
  };

  const draw = () => {
    const active = data.orders.filter((o) => o.delivery_status !== 'delivered');
    const done = data.orders.filter((o) => o.delivery_status === 'delivered');
    ctx.el.innerHTML = `<div class="rider-wrap col" style="gap:16px">
      <div class="card big-toggle ${data.online ? 'on' : ''}">
        <div class="avatar lg" style="background:${data.online ? 'rgba(255,255,255,.25)' : 'var(--surface-3)'};color:${data.online ? '#fff' : 'var(--muted)'}">${icon('bike', 22)}</div>
        <div style="flex:1"><div class="bold" style="font-size:17px">${data.online ? 'You are online' : 'You are offline'}</div>
          <div class="small" style="opacity:.8">${data.online ? 'New deliveries can be assigned to you.' : 'Switch online when you start work.'}</div></div>
        <label class="switch" style="transform:scale(1.25)"><input type="checkbox" id="online" ${data.online ? 'checked' : ''}><span></span></label>
      </div>
      <div class="grid g2"><div class="card kpi"><div class="kpi-label">Active</div><div class="kpi-value">${active.length}</div></div>
        <div class="card kpi"><div class="kpi-label">Cash collected today</div><div class="kpi-value money">${money(data.cash_collected)}</div></div></div>
      ${active.length ? active.map(card).join('') : `<div class="card">${empty('package', 'No deliveries right now', data.online ? 'You will see new deliveries here.' : 'Go online to receive deliveries.')}</div>`}
      ${done.length ? `<h3>Delivered today (${done.length})</h3>${done.map(card).join('')}` : ''}
    </div>`;
  };

  const card = (o) => {
    const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}`;
    return `<div class="card lo-card">
      <div class="row"><h2 style="flex:1">#${o.order_no} · ${esc(o.customer_name || 'Customer')}</h2>${badge(o.delivery_status)}</div>
      <div>${icon('pin', 14)} ${esc(o.address)}</div>
      <div class="small muted">${o.items.map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
      <div class="row"><span class="badge ${o.cod ? 'warning' : 'success'}">${o.cod ? `Collect ${money(o.total - o.paid)} cash` : 'Prepaid'}</span><span class="spacer"></span><b class="money">${money(o.total)}</b></div>
      ${o.delivery_status !== 'delivered' ? `<div class="grid g2" style="gap:8px">
        <a class="btn" href="${maps}" target="_blank" rel="noopener">${icon('navigation', 16)} Directions</a>
        <a class="btn" href="tel:${esc(o.customer_phone)}">${icon('phone', 16)} Call</a>
        ${o.delivery_status === 'assigned' ? `<button class="btn primary" style="grid-column:1/-1" data-accept="${o.id}">${icon('check')} Accept delivery</button>` : ''}
        ${['assigned', 'accepted'].includes(o.delivery_status) ? `<button class="btn ${o.delivery_status === 'accepted' ? 'primary' : ''}" style="grid-column:1/-1" data-pickup="${o.id}">${icon('package_check')} Picked up</button>` : ''}
        ${o.delivery_status === 'picked_up' ? `<button class="btn success lg" style="grid-column:1/-1" data-deliver="${o.id}">${icon('check_circle')} Delivered</button>` : ''}
      </div>` : ''}
    </div>`;
  };

  ctx.el.addEventListener('change', async (e) => {
    if (e.target.id !== 'online') return;
    try { await api('/api/rider/online', { method: 'POST', body: { online: e.target.checked } }); toast(e.target.checked ? 'You are online' : 'You are offline'); load(); } catch (err) { toastError(err); }
  });
  on(ctx.el, 'click', '[data-accept]', (e, b) => busy(b, async () => { try { await api(`/api/rider/orders/${b.dataset.accept}/accept`, { method: 'POST' }); load(); } catch (err) { toastError(err); } }));
  on(ctx.el, 'click', '[data-pickup]', (e, b) => busy(b, async () => { try { await api(`/api/rider/orders/${b.dataset.pickup}/pickup`, { method: 'POST' }); toast('Have a safe ride!'); load(); } catch (err) { toastError(err); } }));
  on(ctx.el, 'click', '[data-deliver]', async (e, b) => {
    const o = data.orders.find((x) => String(x.id) === b.dataset.deliver);
    await formModal({
      title: 'Confirm delivery', submitText: 'Mark delivered', size: 'narrow',
      intro: `<p class="muted">Ask the customer for their 4-digit delivery code.${o.cod ? ` Collect <b>${money(o.total - o.paid)}</b> in cash.` : ''}</p>`,
      fields: [{ name: 'otp', label: 'Delivery code', type: 'tel', required: true, maxlength: 4, pattern: '\\d{4}', placeholder: '0000', full: true }],
      onSubmit: async (v) => { await api(`/api/rider/orders/${o.id}/deliver`, { method: 'POST', body: v }); toast('Delivered — great job!'); load(); },
    });
  });

  await load();
  ctx.every(load, 8000);
}

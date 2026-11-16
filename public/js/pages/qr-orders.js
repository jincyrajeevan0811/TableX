import { api } from '../api.js';
import {
  beep, busy, empty, esc, formModal, icon, money, on, timeAgo, toast, toastError, vegDot,
} from '../ui.js';

export default async function qrOrders(ctx) {
  let list = [];
  let known = null;
  ctx.setTitle(`${icon('qr', 20)}<span>QR Orders</span>`);

  const load = async () => {
    try {
      list = await api('/api/qr-orders');
      const sig = new Set(list.map((o) => `${o.id}:${o.items.length}`));
      if (known && [...sig].some((s) => !known.has(s))) beep(2);
      known = sig;
      if (ctx.isCurrent()) draw();
    } catch (e) { if (e.code !== 'OFFLINE') toastError(e); }
  };

  const draw = () => {
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Awaiting acceptance</h1>
        <div class="sub">Orders placed by guests from the table QR code. Accept to send them to the kitchen.</div></div></div>
      ${list.length ? `<div class="lo-grid">${list.map((o) => {
        const total = o.items.reduce((s, i) => s + i.qty * i.price, 0);
        return `<div class="card lo-card">
          <div class="row"><div style="flex:1"><h2>Table ${esc(o.table_name || '—')}</h2>
            <div class="small muted">${o.customer_name ? `${esc(o.customer_name)} · ` : ''}${o.customer_phone ? `${esc(o.customer_phone)} · ` : ''}${timeAgo(o.updated_at)}</div></div>
            <span class="badge danger"><span class="dot"></span>New</span></div>
          <div class="lo-items">${o.items.map((i) => `<div>${vegDot(i.veg)}<span style="flex:1"><b>${i.qty}×</b> ${esc(i.name)}${i.note ? ` <span class="muted small">— ${esc(i.note)}</span>` : ''}</span><span class="money small">${money(i.qty * i.price)}</span></div>`).join('')}</div>
          <div class="sum-row total"><span>Total</span><span class="money">${money(total)}</span></div>
          <div class="row"><button class="btn danger-ghost" data-reject="${o.id}">${icon('x')} Reject</button><span class="spacer"></span>
            <button class="btn success" data-accept="${o.id}">${icon('check')} Accept & send KOT</button></div>
        </div>`;
      }).join('')}</div>` : `<div class="card">${empty('qr', 'No QR orders waiting', 'When a guest orders from their table QR code, it appears here with a sound.')}</div>`}`;
  };

  on(ctx.el, 'click', '[data-accept]', (e, b) => busy(b, async () => {
    try { await api(`/api/orders/${b.dataset.accept}/accept`, { method: 'POST' }); toast('Accepted — sent to the kitchen'); load(); } catch (err) { toastError(err); }
  }));
  on(ctx.el, 'click', '[data-reject]', async (e, b) => {
    await formModal({
      title: 'Reject order', submitText: 'Reject', danger: true,
      fields: [{ name: 'reason', label: 'Reason (optional)', placeholder: 'e.g. Item not available', full: true }],
      onSubmit: async (v) => { await api(`/api/orders/${b.dataset.reject}/reject`, { method: 'POST', body: v }); toast('Order rejected'); load(); },
    });
  });

  await load();
  ctx.every(load, 5000);
}

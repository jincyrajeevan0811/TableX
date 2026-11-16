import { api } from '../api.js';
import { can } from '../app.js';
import {
  ORDER_TYPE, badge, empty, esc, icon, minutesSince, money, on, toastError,
} from '../ui.js';

export default async function live(ctx) {
  let orders = [];
  let filter = 'all';
  ctx.setTitle(`${icon('activity', 20)}<span>Live Orders</span>`);

  const load = async () => {
    try { orders = await api('/api/live-orders'); if (ctx.isCurrent()) draw(); } catch (e) { if (e.code !== 'OFFLINE') toastError(e); }
  };

  const draw = () => {
    const total = orders.reduce((s, o) => s + o.total, 0);
    const shown = orders.filter((o) => filter === 'all' || o.type === filter);
    ctx.el.innerHTML = `
      <div class="grid g4" style="margin-bottom:20px">
        <div class="card kpi hero"><div class="kpi-label">Open orders</div><div class="kpi-value">${orders.length}</div><div class="kpi-icon">${icon('activity')}</div></div>
        <div class="card kpi"><div class="kpi-label">Running value</div><div class="kpi-value money">${money(total)}</div><div class="kpi-icon">${icon('rupee')}</div></div>
        <div class="card kpi"><div class="kpi-label">In kitchen</div><div class="kpi-value">${orders.filter((o) => o.kitchen_state === 'in_kitchen').length}</div><div class="kpi-icon">${icon('flame')}</div></div>
        <div class="card kpi"><div class="kpi-label">Billed, awaiting payment</div><div class="kpi-value">${orders.filter((o) => o.status === 'billed').length}</div><div class="kpi-icon">${icon('receipt')}</div></div>
      </div>
      <div class="row wrap" style="margin-bottom:16px"><div class="seg">
        ${['all', 'dine_in', 'takeaway', 'delivery'].map((f) => `<button data-f="${f}" class="${filter === f ? 'active' : ''}">${f === 'all' ? 'All' : ORDER_TYPE[f]}</button>`).join('')}
      </div><span class="spacer"></span><span class="muted small">${icon('refresh', 13)} Refreshes by itself every few seconds</span></div>
      ${shown.length ? `<div class="lo-grid">${shown.map((o) => `
        <div class="card lo-card" ${can('pos') ? `data-open="${o.table_id ? `/pos/table/${o.table_id}` : `/pos/order/${o.id}`}" style="cursor:pointer"` : ''}>
          <div class="row"><div style="flex:1;min-width:0"><h2>${o.table_name ? `Table ${esc(o.table_name)}` : `${ORDER_TYPE[o.type]} #${o.order_no}`}</h2>
            <div class="small muted">${icon('users', 12)} ${esc(o.captain_name || (o.source === 'qr' ? 'QR guest' : '—'))} · ${minutesSince(o.created_at)} min ago</div></div>
            <div class="col" style="gap:4px;align-items:flex-end">${badge(o.kitchen_state)}${o.status === 'billed' ? badge('billed') : ''}</div></div>
          <div class="lo-items">${o.items.slice(0, 8).map((i) => `<div><span class="st-dot ${i.status}"></span><span style="flex:1;${i.status === 'cancelled' ? 'text-decoration:line-through;color:var(--muted)' : ''}">${i.qty}× ${esc(i.name)}</span><span class="tiny muted">${i.status === 'pending' ? 'Not sent' : i.status === 'new' ? 'In kitchen' : esc(i.status)}</span></div>`).join('')}
            ${o.items.length > 8 ? `<div class="muted small">+${o.items.length - 8} more</div>` : ''}</div>
          <div class="sum-row total" style="margin-top:auto"><span>Total</span><span class="money">${money(o.total)}</span></div>
        </div>`).join('')}</div>` : `<div class="card">${empty('activity', 'No open orders', 'Running orders from all waiters appear here live.')}</div>`}`;
  };

  on(ctx.el, 'click', '[data-f]', (e, b) => { filter = b.dataset.f; draw(); });
  on(ctx.el, 'click', '[data-open]', (e, c) => ctx.go(c.dataset.open));
  await load();
  ctx.every(load, 5000);
}

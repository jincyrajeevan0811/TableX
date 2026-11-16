import { api } from '../../api.js';
import {
  badge, cap, downloadCsv, empty, esc, fmtDate, fmtDateTime, icon, money,
} from '../../ui.js';

export default async function subscriptions(ctx) {
  ctx.setTitle(`${icon('wallet', 20)}<span>Plan purchases</span>`, `<button class="btn sm" data-csv>${icon('download', 15)} CSV</button>`);
  const list = await api('/api/admin/subscriptions');
  const paid = list.filter((s) => s.status !== 'pending' && !['trial', 'complimentary'].includes(s.source));
  ctx.el.innerHTML = `
    <div class="grid g3" style="margin-bottom:16px">
      <div class="card kpi hero"><div class="kpi-label">Collected</div><div class="kpi-value money">${money(paid.reduce((s, x) => s + x.amount, 0))}</div></div>
      <div class="card kpi"><div class="kpi-label">Paid purchases</div><div class="kpi-value">${paid.length}</div></div>
      <div class="card kpi"><div class="kpi-label">Abandoned checkouts</div><div class="kpi-value">${list.filter((s) => s.status === 'pending').length}</div></div>
    </div>
    <div class="card"><div class="table-wrap">${list.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Restaurant</th><th>Plan</th><th>Cycle</th><th>Period</th><th>Source</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
      ${list.map((s) => `<tr class="clickable" onclick="location.hash='/admin/restaurants/${s.restaurant_id}'"><td class="small">${fmtDateTime(s.created_at)}</td><td class="bold">${esc(s.restaurant_name)}</td><td>${esc(s.plan_name)}</td><td>${cap(s.cycle)}</td>
        <td class="small">${s.starts_at ? `${fmtDate(s.starts_at)} → ${fmtDate(s.ends_at)}` : '—'}</td><td>${cap(s.source)}${s.razorpay_payment_id ? `<div class="tiny muted mono">${esc(s.razorpay_payment_id)}</div>` : ''}</td>
        <td>${badge(s.status === 'pending' ? 'pending' : s.status, s.status === 'pending' ? 'Not paid' : undefined)}</td><td class="r money">${money(s.amount)}</td></tr>`).join('')}</tbody></table>`
    : empty('wallet', 'No purchases yet')}</div></div>`;
  ctx.actionsEl.onclick = (e) => {
    if (!e.target.closest('[data-csv]')) return;
    downloadCsv('tablex-plan-purchases.csv', [['Date', 'Restaurant', 'Plan', 'Cycle', 'Starts', 'Ends', 'Source', 'Status', 'Amount', 'Razorpay payment'],
      ...list.map((s) => [s.created_at, s.restaurant_name, s.plan_name, s.cycle, s.starts_at, s.ends_at, s.source, s.status, s.amount, s.razorpay_payment_id || ''])]);
  };
  ctx.onLeave(() => { ctx.actionsEl.onclick = null; });
}

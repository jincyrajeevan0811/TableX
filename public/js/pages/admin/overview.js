import { api } from '../../api.js';
import { cap, empty, esc, fmtDate, icon, money, num } from '../../ui.js';
import { donut } from '../dashboard.js';

export default async function overview(ctx) {
  ctx.setTitle(`${icon('dashboard', 20)}<span>Platform overview</span>`, `<a class="btn primary sm" href="#/admin/restaurants?new=1">${icon('plus', 15)} Onboard restaurant</a>`);
  const s = await api('/api/admin/stats');
  const r = s.restaurants;
  ctx.el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>TableX platform</h1><div class="sub">Restaurants, subscriptions and revenue at a glance.</div></div></div>
    <div class="grid g4">
      <div class="card kpi hero"><div class="kpi-label">Monthly recurring revenue</div><div class="kpi-value money">${money(Math.round(s.mrr))}</div><div class="small" style="opacity:.85">Lifetime ${money(s.revenue)}</div><div class="kpi-icon">${icon('trending')}</div></div>
      <div class="card kpi"><div class="kpi-label">Restaurants</div><div class="kpi-value">${num(r.total)}</div><div class="small muted">${r.live || 0} live</div><div class="kpi-icon">${icon('store')}</div></div>
      <div class="card kpi"><div class="kpi-label">Needs attention</div><div class="kpi-value">${(r.lapsed || 0) + (r.suspended || 0)}</div><div class="small muted">${r.lapsed || 0} lapsed · ${r.suspended || 0} paused</div><div class="kpi-icon">${icon('alert')}</div></div>
      <div class="card kpi"><div class="kpi-label">Orders (24 h)</div><div class="kpi-value">${num(s.ordersToday)}</div><div class="small muted">across all restaurants</div><div class="kpi-icon">${icon('activity')}</div></div>
    </div>
    <div class="grid g3" style="margin-top:16px;align-items:start">
      <div class="card"><div class="card-head"><h3>Live restaurants by plan</h3></div><div class="card-body">${s.byPlan.some((p) => p.count) ? donut(s.byPlan.map((p) => ({ label: p.name, value: p.count, display: p.count })), 130) : empty('layers', 'No active subscriptions')}</div></div>
      <div class="card"><div class="card-head"><h3>Expiring in 10 days</h3></div>
        ${s.expiring.length ? s.expiring.map((x) => `<a class="row" href="#/admin/restaurants/${x.id}" style="padding:12px 18px;border-bottom:1px solid var(--border);color:inherit"><div style="flex:1"><div class="bold">${esc(x.name)}</div><div class="tiny muted">${esc(x.plan_name || '')}</div></div><span class="badge warning">${fmtDate(x.subscription_ends_at)}</span></a>`).join('') : `<div class="card-body muted small">Nothing expiring soon.</div>`}</div>
      <div class="card"><div class="card-head"><h3>Recent purchases</h3><a href="#/admin/subscriptions" class="small">View all</a></div>
        ${s.payments.length ? s.payments.map((p) => `<div class="row" style="padding:12px 18px;border-bottom:1px solid var(--border)"><div style="flex:1"><div class="bold">${esc(p.restaurant_name)}</div><div class="tiny muted">${esc(p.plan_name)} · ${cap(p.cycle)} · ${cap(p.source)}</div></div><b class="money">${money(p.amount)}</b></div>`).join('') : `<div class="card-body muted small">No purchases yet.</div>`}</div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>Newest restaurants</h3><a href="#/admin/restaurants" class="small">All restaurants</a></div>
      ${s.recent.length ? `<div class="table-wrap"><table class="tbl"><tbody>${s.recent.map((x) => `<tr class="clickable" onclick="location.hash='/admin/restaurants/${x.id}'"><td class="bold">${esc(x.name)}</td><td>${esc(x.city || '')}</td><td><span class="badge primary">${esc(x.plan_name || '—')}</span></td><td class="r muted small">${fmtDate(x.created_at)}</td></tr>`).join('')}</tbody></table></div>` : empty('store', 'No restaurants yet', 'Onboard your first restaurant.', `<a class="btn primary" href="#/admin/restaurants?new=1">${icon('plus')} Onboard restaurant</a>`)}
    </div>`;
}

import { api } from '../api.js';
import {
  badge, busy, cap, esc, fmtDate, icon, money, on, toast, toastError,
} from '../ui.js';
import { razorpayPay } from './shared.js';

export function planCard(p, features, { cycle = 'monthly', current = false, action = '' } = {}) {
  const price = cycle === 'yearly' ? p.price_yearly : p.price_monthly;
  const save = p.price_yearly && p.price_monthly ? Math.round((1 - p.price_yearly / (p.price_monthly * 12)) * 100) : 0;
  return `<div class="card plan ${p.highlight ? 'hl' : ''}">
    ${p.highlight ? '<span class="ribbon">MOST POPULAR</span>' : ''}
    <div class="row"><h2 style="flex:1">${esc(p.name)}</h2>${current ? '<span class="badge success">Current</span>' : ''}</div>
    <p class="muted small">${esc(p.description || '')}</p>
    <div class="price money">${money(price)}<small> / ${cycle === 'yearly' ? 'year' : 'month'}</small></div>
    ${cycle === 'yearly' && save > 0 ? `<span class="badge success" style="align-self:flex-start">Save ${save}% yearly</span>` : ''}
    <ul>
      <li>${icon('check', 16)}<span>Up to <b>${p.max_tables}</b> tables</span></li>
      <li>${icon('check', 16)}<span><b>${p.max_staff}</b> staff logins</span></li>
      <li>${icon('check', 16)}<span><b>${p.max_menu_items}</b> menu items</span></li>
      <li>${icon('check', 16)} POS, KOT, kitchen display & billing</li>
      ${features.map((f) => `<li class="${p.features.includes(f.key) ? '' : 'off'}">${icon(p.features.includes(f.key) ? 'check' : 'x', 16)} ${esc(f.label)}</li>`).join('')}
    </ul>
    <div style="margin-top:auto;padding-top:8px">${action}</div>
  </div>`;
}

export default async function subscriptionPage(ctx) {
  let cycle = 'monthly';
  ctx.setTitle(`${icon('crown', 20)}<span>Subscription</span>`);

  const draw = async () => {
    const d = await api('/api/subscription');
    const cur = d.current;
    const days = cur.ends_at ? Math.ceil((Date.parse(cur.ends_at) - Date.now()) / 86400000) : 0;
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Your TableX plan</h1><div class="sub">Choose a plan that fits your restaurant. Pay securely with Razorpay — UPI, cards or net banking.</div></div></div>
      <div class="card pad" style="margin-bottom:20px;background:var(--grad-soft)">
        <div class="row wrap" style="gap:20px">
          <div class="avatar lg">${icon('crown', 20)}</div>
          <div style="flex:1;min-width:200px"><div class="muted small">Current plan</div><h2>${esc(cur.plan?.name || 'No plan yet')}</h2>
            <div class="small">${cur.active ? `Active until <b>${fmtDate(cur.ends_at)}</b> (${days} day${days === 1 ? '' : 's'} left)` : cur.reason === 'suspended' ? 'Access paused by TableX' : cur.ends_at ? `Ended on ${fmtDate(cur.ends_at)}` : 'Not active'}</div></div>
          ${['tables', 'staff', 'menu_items'].map((k) => `<div><div class="muted small">${cap(k)}</div><div class="bold" style="font-size:18px">${d.usage[k]}${cur.plan ? ` <span class="muted small">/ ${cur.plan[`max_${k}`]}</span>` : ''}</div></div>`).join('')}
        </div>
      </div>
      ${d.demo ? `<div class="notice warning" style="margin-bottom:16px">${icon('info')}<div>Payments are in <b>demo mode</b> because the platform Razorpay keys are not configured yet.</div></div>` : ''}
      <div class="row" style="justify-content:center;margin-bottom:22px"><div class="seg">
        <button data-cycle="monthly" class="${cycle === 'monthly' ? 'active' : ''}">Monthly</button><button data-cycle="yearly" class="${cycle === 'yearly' ? 'active' : ''}">Yearly</button></div></div>
      <div class="plans">${d.plans.map((p) => {
        const isCur = cur.plan?.id === p.id && cur.active;
        const price = cycle === 'yearly' ? p.price_yearly : p.price_monthly;
        return planCard(p, d.features, { cycle, current: isCur, action: price > 0 ? `<button class="btn ${p.highlight ? 'primary' : 'solid'} block lg" data-buy="${p.id}">${isCur ? 'Renew' : cur.plan?.id === p.id ? 'Reactivate' : 'Choose'} ${esc(p.name)}</button>` : '' });
      }).join('')}</div>
      ${d.history.length ? `<div class="card" style="margin-top:24px"><div class="card-head"><h3>Billing history</h3></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Plan</th><th>Period</th><th>Paid via</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
        ${d.history.map((h) => `<tr><td>${fmtDate(h.created_at)}</td><td class="bold">${esc(h.plan_name)}</td><td class="small">${fmtDate(h.starts_at)} → ${fmtDate(h.ends_at)}</td><td>${cap(h.source)}</td><td>${badge(h.source === 'trial' ? 'trial' : h.status)}</td><td class="r money">${money(h.amount)}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  };

  on(ctx.el, 'click', '[data-cycle]', (e, b) => { cycle = b.dataset.cycle; draw().catch(toastError); });
  on(ctx.el, 'click', '[data-buy]', (e, b) => busy(b, async () => {
    try {
      const checkout = await api('/api/subscription/checkout', { method: 'POST', body: { plan_id: Number(b.dataset.buy), cycle } });
      const resp = await razorpayPay(checkout);
      const r = await api('/api/subscription/verify', { method: 'POST', body: resp });
      toast(`Payment successful — plan active until ${fmtDate(r.ends_at)}`);
      await ctx.refreshMe();
      location.reload();
    } catch (err) { toastError(err); }
  }));

  await draw();
}

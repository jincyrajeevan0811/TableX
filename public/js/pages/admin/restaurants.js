import { api } from '../../api.js';
import {
  badge, debounce, empty, esc, fmtDate, formModal, icon, on, toast,
} from '../../ui.js';

export function restaurantState(r) {
  if (r.status === 'suspended') return badge('suspended');
  if (!r.subscription_ends_at) return '<span class="badge warning"><span class="dot"></span>Awaiting payment</span>';
  if (r.subscription_ends_at < new Date().toISOString()) return badge('expired');
  return badge('active');
}

export async function onboardRestaurant(meta, plans) {
  return formModal({
    title: 'Onboard a restaurant', size: 'wide', submitText: 'Create restaurant',
    intro: `<div class="notice">${icon('info')}<div>This creates the restaurant, its <b>Owner login</b> and (optionally) its tables. The owner signs in with the mobile number and password you set here.</div></div>`,
    fields: [
      { name: 'name', label: 'Restaurant name', required: true },
      { name: 'city', label: 'City' },
      { name: 'address', label: 'Address', full: true },
      { name: 'owner_name', label: 'Owner name', required: true },
      { name: 'phone', label: 'Owner mobile (login)', type: 'tel', required: true },
      { name: 'email', label: 'Owner email', type: 'email' },
      { name: 'password', label: 'Owner password', type: 'text', required: true, hint: 'At least 6 characters. Share it with the owner.' },
      { name: 'plan_id', label: 'Subscription plan', type: 'select', options: plans.filter((p) => p.active).map((p) => [p.id, `${p.name} — ₹${p.price_monthly}/mo`]), value: plans.find((p) => p.highlight)?.id },
      { name: 'cycle', label: 'Billing cycle', type: 'select', options: [['monthly', 'Monthly'], ['yearly', 'Yearly']] },
      { name: 'access', label: 'Access', type: 'select', full: true, options: [
        ['trial', `Start a ${meta.trialDays}-day free trial now`],
        ['paid', 'Mark plan as paid (offline payment) and activate now'],
        ['pending', 'Wait — owner buys the plan with Razorpay after signing in'],
      ] },
      { name: 'tables', label: 'Create tables (T1…Tn)', type: 'number', value: 10, min: 0, max: 200 },
    ],
    onSubmit: async (v) => {
      const r = await api('/api/admin/restaurants', { method: 'POST', body: { ...v, plan_id: Number(v.plan_id), tables: Number(v.tables) || 0 } });
      toast(`${r.name} is ready. Owner login: ${v.phone}`);
      return r;
    },
  });
}

export default async function restaurants(ctx) {
  let q = '';
  const [meta, plans] = await Promise.all([api('/api/admin/meta'), api('/api/admin/plans')]);
  ctx.setTitle(`${icon('store', 20)}<span>Restaurants</span>`, `<button class="btn primary sm" data-new>${icon('plus', 15)} Onboard restaurant</button>`);

  ctx.el.innerHTML = `<div class="card"><div class="card-head"><div class="input-icon" style="flex:1">${icon('search', 16)}<input class="input sm" id="rq" placeholder="Search name, owner, phone or city"></div></div>
    <div class="table-wrap" id="rlist"><div class="loader">Loading…</div></div></div>`;

  const load = async () => {
    const list = await api(`/api/admin/restaurants?q=${encodeURIComponent(q)}`);
    ctx.el.querySelector('#rlist').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Restaurant</th><th>Owner</th><th>Plan</th><th>Access</th><th>Valid till</th><th class="r">Staff</th><th class="r">Tables</th><th class="r">Orders</th></tr></thead><tbody>
      ${list.map((r) => `<tr class="clickable" data-id="${r.id}"><td><div class="bold">${esc(r.name)}</div><div class="tiny muted">${esc(r.city || '')}</div></td>
        <td>${esc(r.owner_name)}<div class="tiny muted">${esc(r.phone)}</div></td><td><span class="badge primary">${esc(r.plan_name || '—')}</span></td>
        <td>${restaurantState(r)}</td><td class="small">${fmtDate(r.subscription_ends_at)}</td>
        <td class="r">${r.staff_count}</td><td class="r">${r.table_count}</td><td class="r">${r.order_count}</td></tr>`).join('')}</tbody></table>`
      : empty('store', 'No restaurants found', q ? 'Try another search.' : 'Onboard your first restaurant to get started.');
  };

  const create = async () => {
    const r = await onboardRestaurant(meta, plans);
    if (r && r.id) ctx.go(`/admin/restaurants/${r.id}`); else load();
  };

  ctx.el.querySelector('#rq').addEventListener('input', debounce((e) => { q = e.target.value; load(); }, 250));
  on(ctx.el, 'click', '[data-id]', (e, r) => ctx.go(`/admin/restaurants/${r.dataset.id}`));
  ctx.actionsEl.onclick = (e) => { if (e.target.closest('[data-new]')) create(); };
  ctx.onLeave(() => { ctx.actionsEl.onclick = null; });

  await load();
  if (ctx.query.get('new')) { history.replaceState(null, '', '#/admin/restaurants'); create(); }
}

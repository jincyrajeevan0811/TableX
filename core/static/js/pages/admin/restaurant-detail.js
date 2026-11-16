import { api } from '../../api.js';
import {
  badge, busy, cap, confirmDialog, esc, fmtDate, fmtDateTime, formModal, icon, money, on, timeAgo, toast, toastError,
} from '../../ui.js';
import { permissionMatrix } from '../staff.js';
import { restaurantState } from './restaurants.js';

export default async function restaurantDetail(ctx) {
  const id = ctx.params.id;
  let tab = 'overview';
  const [meta, plans] = await Promise.all([api('/api/admin/meta'), api('/api/admin/plans')]);
  let r;

  const load = async () => { r = await api(`/api/admin/restaurants/${id}`); draw(); };

  const draw = () => {
    ctx.setTitle(`<a class="btn ghost icon" href="#/admin/restaurants">${icon('back')}</a><span>${esc(r.name)}</span>${restaurantState(r)}`);
    ctx.el.innerHTML = `
      <div class="grid g4" style="margin-bottom:16px">
        <div class="card kpi hero"><div class="kpi-label">Plan</div><div class="kpi-value">${esc(r.plan_name || '—')}</div><div class="small" style="opacity:.85">${r.subscription_ends_at ? `Valid till ${fmtDate(r.subscription_ends_at)}` : 'Not activated'}</div></div>
        <div class="card kpi"><div class="kpi-label">Lifetime sales</div><div class="kpi-value money">${money(r.stats.sales)}</div><div class="small muted">${r.stats.orders} orders</div></div>
        <div class="card kpi"><div class="kpi-label">Staff logins</div><div class="kpi-value">${r.staff.length}</div><div class="small muted">${r.staff.filter((s) => s.active).length} active</div></div>
        <div class="card kpi"><div class="kpi-label">System access</div><div class="kpi-value" style="font-size:20px">${r.status === 'active' ? 'Granted' : 'Paused'}</div>
          <label class="row small" style="margin-top:4px"><span class="switch"><input type="checkbox" id="access" ${r.status === 'active' ? 'checked' : ''}><span></span></span> ${r.status === 'active' ? 'Restaurant can use TableX' : 'Restaurant is locked out'}</label></div>
      </div>
      <div class="tabs">${['overview', 'subscription', 'roles', 'staff'].map((t) => `<button data-tab="${t}" class="${tab === t ? 'active' : ''}">${t === 'roles' ? 'Role permissions' : cap(t)}</button>`).join('')}</div>
      <div id="tab"></div>`;
    const el = ctx.el.querySelector('#tab');
    if (tab === 'overview') {
      el.innerHTML = `<div class="grid g2" style="align-items:start">
        <div class="card"><div class="card-head"><h3>Details</h3><button class="btn sm" data-a="edit">${icon('pencil', 14)} Edit</button></div><div class="card-body col" style="gap:8px">
          ${[['Restaurant', r.name], ['Owner', r.owner_name], ['Phone', r.phone], ['Email', r.email], ['City', r.city], ['Address', r.address], ['Created', fmtDate(r.created_at)]]
    .map(([k, v]) => `<div class="row"><span class="muted" style="width:110px">${k}</span><span class="bold">${esc(v || '—')}</span></div>`).join('')}</div></div>
        <div class="card"><div class="card-head"><h3>Owner login</h3></div><div class="card-body col">
          ${r.owner ? `<div class="row"><span class="muted" style="width:110px">Name</span><b>${esc(r.owner.name)}</b></div>
          <div class="row"><span class="muted" style="width:110px">Mobile</span><b>${esc(r.owner.phone)}</b></div>
          <div class="row"><span class="muted" style="width:110px">Last sign-in</span>${r.owner.last_login_at ? timeAgo(r.owner.last_login_at) : 'Never'}</div>
          <button class="btn" data-a="pwd" style="align-self:flex-start">${icon('key')} Reset owner password</button>` : '<p class="muted">No owner login.</p>'}
        </div></div></div>`;
    }
    if (tab === 'subscription') {
      el.innerHTML = `<div class="card"><div class="card-head"><h3>Subscription history</h3><button class="btn primary sm" data-a="assign">${icon('crown', 14)} Assign / extend plan</button></div>
        <div class="table-wrap">${r.subscriptions.length ? `<table class="tbl"><thead><tr><th>Created</th><th>Plan</th><th>Cycle</th><th>Period</th><th>Source</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
        ${r.subscriptions.map((s) => `<tr><td class="small">${fmtDateTime(s.created_at)}</td><td class="bold">${esc(s.plan_name)}</td><td>${cap(s.cycle)}</td><td class="small">${s.starts_at ? `${fmtDate(s.starts_at)} → ${fmtDate(s.ends_at)}` : '—'}</td>
          <td>${cap(s.source)}${s.razorpay_payment_id ? `<div class="tiny muted mono">${esc(s.razorpay_payment_id)}</div>` : ''}</td><td>${badge(s.status)}</td><td class="r money">${money(s.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="card-body muted">No subscriptions yet.</div>'}</div></div>`;
    }
    if (tab === 'roles') {
      el.innerHTML = `<div class="card"><div class="card-head"><h3>Role permissions for ${esc(r.name)}</h3><span class="muted small">Overrides the platform defaults for this restaurant only</span></div>
        ${permissionMatrix({ roles: r.roles, permissions: meta.permissions })}
        <div class="card-body row wrap" style="gap:8px;border-top:1px solid var(--border)"><span class="muted small">Reset to platform default:</span>
        ${r.roles.filter((x) => !x.locked && x.custom).map((x) => `<button class="btn sm ghost" data-reset="${x.key}">${icon('rotate', 13)} ${esc(x.label)}</button>`).join('') || '<span class="small muted">All roles use platform defaults.</span>'}</div></div>`;
    }
    if (tab === 'staff') {
      el.innerHTML = `<div class="card"><div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>Status</th><th>Last sign-in</th></tr></thead><tbody>
        ${r.staff.map((s) => `<tr><td class="bold">${esc(s.name)}</td><td>${esc(s.phone || '')}</td><td>${esc(meta.roles.find((x) => x.key === s.role)?.label || s.role)}</td><td>${s.active ? badge('active') : '<span class="badge">Off</span>'}</td><td class="small muted">${s.last_login_at ? timeAgo(s.last_login_at) : 'Never'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    }
  };

  ctx.el.addEventListener('change', async (e) => {
    if (e.target.id === 'access') {
      const status = e.target.checked ? 'active' : 'suspended';
      if (status === 'suspended' && !await confirmDialog({ title: `Pause ${r.name}?`, message: 'All staff of this restaurant will be locked out until you grant access again. Their data is kept.', confirmText: 'Pause access', danger: true })) { e.target.checked = true; return; }
      try { await api(`/api/admin/restaurants/${id}/status`, { method: 'POST', body: { status } }); toast(status === 'active' ? 'Access granted' : 'Access paused'); load(); } catch (err) { toastError(err); }
    }
    if (e.target.dataset.perm) {
      const c = e.target;
      const role = r.roles.find((x) => x.key === c.dataset.role);
      const perms = new Set(role.permissions);
      if (c.checked) perms.add(c.dataset.perm); else perms.delete(c.dataset.perm);
      try { const res = await api(`/api/admin/restaurants/${id}/roles/${role.key}`, { method: 'PUT', body: { permissions: [...perms] } }); role.permissions = res.permissions; role.custom = true; toast(`${role.label} updated`); } catch (err) { c.checked = !c.checked; toastError(err); }
    }
  });
  on(ctx.el, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; draw(); });
  on(ctx.el, 'click', '[data-reset]', (e, b) => busy(b, async () => { await api(`/api/admin/restaurants/${id}/roles/${b.dataset.reset}`, { method: 'PUT', body: { reset: true } }); toast('Reset to default'); load(); }));
  on(ctx.el, 'click', '[data-a]', async (e, b) => {
    const a = b.dataset.a;
    if (a === 'edit') {
      await formModal({
        title: 'Edit restaurant', size: 'wide',
        fields: [{ name: 'name', label: 'Restaurant name', value: r.name, required: true }, { name: 'owner_name', label: 'Owner name', value: r.owner_name },
          { name: 'phone', label: 'Phone', value: r.phone }, { name: 'email', label: 'Email', value: r.email }, { name: 'city', label: 'City', value: r.city },
          { name: 'address', label: 'Address', value: r.address, full: true }],
        onSubmit: (v) => api(`/api/admin/restaurants/${id}`, { method: 'PUT', body: v }),
      });
      load();
    }
    if (a === 'pwd') {
      await formModal({ title: 'Reset owner password', submitText: 'Reset password', fields: [{ name: 'password', label: 'New password', required: true, full: true, hint: 'The owner will be signed out of all devices.' }],
        onSubmit: async (v) => { await api(`/api/admin/restaurants/${id}/owner-password`, { method: 'POST', body: v }); toast('Password reset'); } });
    }
    if (a === 'assign') {
      await formModal({
        title: 'Assign / extend plan', submitText: 'Activate',
        intro: '<p class="muted small">Use this for offline payments (bank transfer, cheque) or complimentary access. Renewing the same plan adds time to the current end date.</p>',
        fields: [
          { name: 'plan_id', label: 'Plan', type: 'select', value: r.plan_id, options: plans.map((p) => [p.id, `${p.name} — ₹${p.price_monthly}/mo, ₹${p.price_yearly}/yr`]) },
          { name: 'cycle', label: 'Cycle', type: 'select', options: [['monthly', 'Monthly'], ['yearly', 'Yearly']] },
          { name: 'periods', label: 'Number of periods', type: 'number', value: 1, min: 1, max: 36 },
          { name: 'amount', label: 'Amount received (₹)', type: 'number', min: 0, step: '0.01', hint: 'Leave blank to use the plan price. Enter 0 for complimentary.' },
          { name: 'note', label: 'Note', full: true, placeholder: 'e.g. NEFT ref 123456' },
        ],
        onSubmit: async (v) => { const s = await api(`/api/admin/restaurants/${id}/subscription`, { method: 'POST', body: { ...v, plan_id: Number(v.plan_id), amount: v.amount === '' ? undefined : v.amount } }); toast(`Active until ${fmtDate(s.ends_at)}`); },
      });
      load();
    }
  });

  await load();
}

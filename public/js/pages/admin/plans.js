import { api } from '../../api.js';
import { confirmDialog, formModal, icon, on, toast, toastError } from '../../ui.js';
import { planCard } from '../subscription.js';

export default async function plans(ctx) {
  let list = [];
  let meta;
  ctx.setTitle(`${icon('layers', 20)}<span>Subscription plans</span>`, `<button class="btn primary sm" data-new>${icon('plus', 15)} New plan</button>`);

  const load = async () => {
    [list, meta] = await Promise.all([api('/api/admin/plans'), meta || api('/api/admin/meta')]);
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Plans</h1><div class="sub">Restaurants buy these from their Subscription screen (Razorpay), or you assign them manually. Features switch screens on or off for every role.</div></div></div>
      ${meta.razorpayConfigured ? '' : `<div class="notice warning" style="margin-bottom:16px">${icon('alert')}<div>Platform Razorpay keys are not set (<span class="mono">RAZORPAY_KEY_ID</span>, <span class="mono">RAZORPAY_KEY_SECRET</span>). Plan purchases run in demo mode until you add them.</div></div>`}
      <div class="plans">${list.map((p) => planCard(p, meta.features, {
    action: `<div class="row" style="gap:8px">${p.active ? '<span class="badge success">On sale</span>' : '<span class="badge">Hidden</span>'}<span class="small muted">${p.restaurants} restaurants</span><span class="spacer"></span>
      <button class="btn sm" data-edit="${p.id}">${icon('pencil', 14)} Edit</button><button class="btn ghost icon sm danger-ghost" data-del="${p.id}">${icon('trash', 15)}</button></div>`,
  })).join('')}</div>`;
  };

  const fields = (p = {}) => [
    { name: 'name', label: 'Plan name', value: p.name, required: true, placeholder: 'e.g. Medium' },
    { name: 'sort', label: 'Display order', type: 'number', value: p.sort ?? list.length + 1, min: 0 },
    { name: 'description', label: 'Short description', value: p.description, full: true },
    { name: 'price_monthly', label: 'Monthly price (₹)', type: 'number', value: p.price_monthly ?? '', min: 0, required: true },
    { name: 'price_yearly', label: 'Yearly price (₹)', type: 'number', value: p.price_yearly ?? '', min: 0 },
    { name: 'max_tables', label: 'Max tables', type: 'number', value: p.max_tables ?? 15, min: 1, required: true },
    { name: 'max_staff', label: 'Max staff logins', type: 'number', value: p.max_staff ?? 8, min: 1, required: true },
    { name: 'max_menu_items', label: 'Max menu items', type: 'number', value: p.max_menu_items ?? 300, min: 1 },
    { name: 'features', label: 'Included features', type: 'multicheck', value: p.features || [], options: meta.features.map((f) => [f.key, f.label]), full: true },
    { name: 'highlight', label: 'Highlight as "Most popular"', type: 'switch', value: p.highlight },
    { name: 'active', label: 'On sale (visible to restaurants)', type: 'switch', value: p.active ?? true },
  ];

  const create = async () => { await formModal({ title: 'New plan', size: 'wide', fields: fields(), submitText: 'Create plan', onSubmit: (v) => api('/api/admin/plans', { method: 'POST', body: v }) }); load(); };
  ctx.actionsEl.onclick = (e) => { if (e.target.closest('[data-new]')) create(); };
  ctx.onLeave(() => { ctx.actionsEl.onclick = null; });
  on(ctx.el, 'click', '[data-edit]', async (e, b) => {
    const p = list.find((x) => String(x.id) === b.dataset.edit);
    await formModal({ title: `Edit ${p.name}`, size: 'wide', fields: fields(p), onSubmit: async (v) => { await api(`/api/admin/plans/${p.id}`, { method: 'PUT', body: v }); toast('Plan saved'); } });
    load();
  });
  on(ctx.el, 'click', '[data-del]', async (e, b) => {
    const p = list.find((x) => String(x.id) === b.dataset.del);
    if (!await confirmDialog({ title: `Delete ${p.name}?`, message: 'Only plans that were never purchased can be deleted. Otherwise switch "On sale" off.', confirmText: 'Delete', danger: true })) return;
    try { await api(`/api/admin/plans/${p.id}`, { method: 'DELETE' }); toast('Plan deleted'); load(); } catch (err) { toastError(err); }
  });
  await load();
}

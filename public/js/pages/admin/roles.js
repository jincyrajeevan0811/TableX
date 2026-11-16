import { api } from '../../api.js';
import { busy, esc, icon, on, toast, toastError } from '../../ui.js';
import { permissionMatrix } from '../staff.js';

export default async function roles(ctx) {
  ctx.setTitle(`${icon('shield', 20)}<span>Default role permissions</span>`);
  const meta = await api('/api/admin/meta');
  let list = await api('/api/admin/roles');

  const draw = () => {
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Default roles</h1><div class="sub">What each role can do in every restaurant, unless a restaurant (or you, from its page) customises it. Plan features still apply on top.</div></div></div>
      <div class="grid g4" style="margin-bottom:16px">${list.map((r) => `<div class="card pad"><div class="bold">${esc(r.label)}</div><div class="small muted" style="margin-top:4px">${esc(r.description)}</div><div class="tiny" style="margin-top:8px"><span class="badge primary">${r.permissions.length} permissions</span></div></div>`).join('')}</div>
      <div class="card"><div class="card-head"><h3>Permission matrix</h3><span class="muted small">Changes save instantly</span></div>
        ${permissionMatrix({ roles: list, permissions: meta.permissions })}
        <div class="card-body row wrap" style="gap:8px;border-top:1px solid var(--border)"><span class="muted small">Reset to TableX built-in defaults:</span>
          ${list.filter((r) => !r.locked).map((r) => `<button class="btn sm ghost" data-reset="${r.key}">${icon('rotate', 13)} ${esc(r.label)}</button>`).join('')}</div>
      </div>`;
  };

  on(ctx.el, 'change', '[data-perm]', async (e, c) => {
    const role = list.find((r) => r.key === c.dataset.role);
    const perms = new Set(role.permissions);
    if (c.checked) perms.add(c.dataset.perm); else perms.delete(c.dataset.perm);
    try { const res = await api(`/api/admin/roles/${role.key}`, { method: 'PUT', body: { permissions: [...perms] } }); role.permissions = res.permissions; toast(`${role.label} default updated`); } catch (err) { c.checked = !c.checked; toastError(err); }
  });
  on(ctx.el, 'click', '[data-reset]', (e, b) => busy(b, async () => {
    try { await api(`/api/admin/roles/${b.dataset.reset}`, { method: 'PUT', body: { reset: true } }); list = await api('/api/admin/roles'); draw(); toast('Reset'); } catch (err) { toastError(err); }
  }));
  draw();
}

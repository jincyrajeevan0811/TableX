import { api } from '../api.js';
import { can } from '../app.js';
import {
  busy, empty, esc, formModal, icon, initials, on, timeAgo, toast, toastError,
} from '../ui.js';

/** Permission matrix used by both the restaurant and the Super Admin screens. */
export function permissionMatrix({ roles, permissions, planFeatures = null, editable = (r) => !r.locked }) {
  const groups = [...new Set(permissions.map((p) => p.group))];
  const shown = roles;
  return `<div class="table-wrap"><table class="tbl matrix"><thead><tr><th>Permission</th>${shown.map((r) => `<th>${esc(r.label)}</th>`).join('')}</tr></thead><tbody>
    ${groups.map((g) => `<tr class="grp"><td colspan="${shown.length + 1}">${esc(g)}</td></tr>${permissions.filter((p) => p.group === g).map((p) => {
      const offPlan = planFeatures && p.feature && !planFeatures.includes(p.feature);
      return `<tr><td>${esc(p.label)}${offPlan ? ' <span class="badge warning">Not in plan</span>' : ''}</td>${shown.map((r) => `<td><input type="checkbox" class="check" data-role="${r.key}" data-perm="${p.key}"
        ${r.permissions.includes(p.key) ? 'checked' : ''} ${editable(r) ? '' : 'disabled'}></td>`).join('')}</tr>`;
    }).join('')}`).join('')}
  </tbody></table></div>`;
}

export default async function staffPage(ctx) {
  let tab = can('staff') ? 'staff' : 'roles';
  let staff = { staff: [], roles: [], limit: null };
  let roles = null;
  ctx.setTitle(`${icon('users', 20)}<span>Staff & Roles</span>`);

  const load = async () => {
    if (can('staff')) staff = await api('/api/staff');
    roles = await api('/api/roles');
    draw();
  };

  const roleOptions = () => roles.roles.filter((r) => r.key !== 'owner' && (r.key !== 'admin' || ['owner', 'admin'].includes(ctx.me.user.role))).map((r) => [r.key, r.label]);

  const draw = () => {
    const active = staff.staff.filter((s) => s.active).length;
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Staff & roles</h1><div class="sub">Give every person their own login. The role decides what they can see.</div></div>
        ${tab === 'staff' && can('staff') ? `<button class="btn primary" data-a="add">${icon('plus')} Add staff</button>` : ''}</div>
      <div class="tabs">${can('staff') ? `<button data-tab="staff" class="${tab === 'staff' ? 'active' : ''}">Staff (${active}${staff.limit ? ` / ${staff.limit}` : ''})</button>` : ''}
        <button data-tab="roles" class="${tab === 'roles' ? 'active' : ''}">Roles & permissions</button></div>
      ${tab === 'staff' ? `<div class="card"><div class="table-wrap">${staff.staff.length ? `<table class="tbl"><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>PIN</th><th>Last sign-in</th><th>Login</th><th></th></tr></thead><tbody>
        ${staff.staff.map((s) => `<tr style="${s.active ? '' : 'opacity:.55'}"><td><div class="row"><span class="avatar" style="width:32px;height:32px;font-size:12px">${esc(initials(s.name))}</span><div><div class="bold">${esc(s.name)}</div>${s.email ? `<div class="tiny muted">${esc(s.email)}</div>` : ''}</div></div></td>
          <td>${esc(s.phone || '')}</td><td><span class="badge ${s.role === 'owner' || s.role === 'admin' ? 'primary' : ''}">${esc(roles.roles.find((r) => r.key === s.role)?.label || s.role)}</span></td>
          <td>${s.has_pin ? '<span class="badge success">Set</span>' : '<span class="muted small">—</span>'}</td>
          <td class="small muted">${s.last_login_at ? timeAgo(s.last_login_at) : 'Never'}</td>
          <td>${s.role === 'owner' ? '<span class="muted small">Always on</span>' : `<label class="switch"><input type="checkbox" data-active="${s.id}" ${s.active ? 'checked' : ''}><span></span></label>`}</td>
          <td class="r">${s.role !== 'owner' || ctx.me.user.role === 'owner' ? `<button class="btn ghost icon sm" data-edit="${s.id}">${icon('pencil', 15)}</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : empty('users', 'No staff yet')}</div></div>
      <p class="muted small" style="margin-top:12px">${icon('info', 13)} Waiters, cashiers and kitchen logins work on one device at a time — signing in on a new phone signs out the old one. Give each person a 4-digit PIN for quick switching on a shared counter device.</p>`
    : `<div class="card"><div class="card-head"><h3>What each role can do</h3>${can('roles') ? '<span class="muted small">Changes save instantly</span>' : ''}</div>
        ${permissionMatrix({ roles: roles.roles, permissions: roles.permissions, planFeatures: roles.planFeatures, editable: (r) => can('roles') && !r.locked && (r.key !== 'admin' || ctx.me.user.role === 'owner') })}
        ${can('roles') ? `<div class="card-body row wrap" style="gap:8px;border-top:1px solid var(--border)"><span class="muted small">Reset a role to TableX defaults:</span>
          ${roles.roles.filter((r) => !r.locked).map((r) => `<button class="btn sm ghost" data-reset="${r.key}">${icon('rotate', 13)} ${esc(r.label)}</button>`).join('')}</div>` : ''}
      </div>`}`;
  };

  const staffFields = (s = {}) => [
    { name: 'name', label: 'Full name', value: s.name, required: true },
    { name: 'phone', label: 'Mobile number (login)', type: 'tel', value: s.phone, required: true },
    { name: 'role', label: 'Role', type: 'select', value: s.role || 'captain', options: s.role === 'owner' ? [['owner', 'Owner']] : roleOptions() },
    { name: 'email', label: 'Email (optional)', type: 'email', value: s.email },
    { name: 'password', label: s.id ? 'New password (leave blank to keep)' : 'Password', type: 'password', required: !s.id, autocomplete: 'new-password', min: 6 },
    { name: 'pin', label: s.id ? 'New 4-digit PIN (optional)' : '4-digit PIN (optional)', type: 'tel', maxlength: 4, pattern: '\\d{4}' },
  ];

  on(ctx.el, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; draw(); });
  on(ctx.el, 'click', '[data-a=add]', async () => {
    await formModal({ title: 'Add staff', fields: staffFields(), submitText: 'Create login', onSubmit: async (v) => { await api('/api/staff', { method: 'POST', body: v }); toast(`Login created for ${v.name}. Share the mobile number and password with them.`); } });
    load();
  });
  on(ctx.el, 'click', '[data-edit]', async (e, b) => {
    const s = staff.staff.find((x) => String(x.id) === b.dataset.edit);
    await formModal({ title: `Edit ${s.name}`, fields: staffFields(s), onSubmit: async (v) => { await api(`/api/staff/${s.id}`, { method: 'PUT', body: v }); toast('Saved'); } });
    load();
  });
  on(ctx.el, 'change', '[data-active]', async (e, c) => {
    try { await api(`/api/staff/${c.dataset.active}/active`, { method: 'POST', body: { active: c.checked } }); toast(c.checked ? 'Login switched on' : 'Login switched off'); load(); } catch (err) { c.checked = !c.checked; toastError(err); }
  });
  on(ctx.el, 'change', '[data-perm]', async (e, c) => {
    const role = roles.roles.find((r) => r.key === c.dataset.role);
    const perms = new Set(role.permissions);
    if (c.checked) perms.add(c.dataset.perm); else perms.delete(c.dataset.perm);
    try { const r = await api(`/api/roles/${role.key}`, { method: 'PUT', body: { permissions: [...perms] } }); role.permissions = r.permissions; toast(`${role.label} updated`); } catch (err) { c.checked = !c.checked; toastError(err); }
  });
  on(ctx.el, 'click', '[data-reset]', (e, b) => busy(b, async () => {
    try { await api(`/api/roles/${b.dataset.reset}`, { method: 'PUT', body: { reset: true } }); toast('Role reset to defaults'); await load(); } catch (err) { toastError(err); }
  }));

  await load();
}

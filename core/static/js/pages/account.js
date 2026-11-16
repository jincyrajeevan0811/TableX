import { api } from '../api.js';
import { esc, formModal, icon, initials, toast } from '../ui.js';

export default async function account(ctx) {
  const me = ctx.me;
  ctx.setTitle(`${icon('user_cog', 20)}<span>My account</span>`);
  ctx.el.innerHTML = `
    <div style="max-width:640px" class="col">
      <div class="card pad row" style="gap:16px">
        <div class="avatar lg">${esc(initials(me.user.name))}</div>
        <div style="flex:1"><h2>${esc(me.user.name)}</h2><div class="muted">${esc(me.superAdmin ? 'Super Admin' : `${me.roleLabel} · ${me.restaurant.name}`)}</div>
          <div class="small muted">${esc(me.user.phone || '')} ${me.user.email ? `· ${esc(me.user.email)}` : ''}</div></div>
      </div>
      <div class="card">
        <button class="row btn ghost block" style="justify-content:flex-start;height:56px;border-radius:0" data-a="password">${icon('key')} Change password</button>
        ${me.superAdmin ? '' : `<button class="row btn ghost block" style="justify-content:flex-start;height:56px;border-radius:0;border-top:1px solid var(--border)" data-a="pin">${icon('switch_user')} ${me.user.has_pin ? 'Change' : 'Set'} quick-switch PIN</button>`}
      </div>
    </div>`;
  ctx.el.querySelector('[data-a=password]').addEventListener('click', () => formModal({
    title: 'Change password', submitText: 'Change password',
    fields: [
      { name: 'current', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { name: 'next', label: 'New password (min 6 characters)', type: 'password', required: true, full: true, autocomplete: 'new-password' },
    ],
    onSubmit: async (v) => { await api('/api/auth/password', { method: 'POST', body: v }); toast('Password changed. Other devices were signed out.'); },
  }));
  ctx.el.querySelector('[data-a=pin]')?.addEventListener('click', () => formModal({
    title: 'Quick-switch PIN', submitText: 'Save PIN', size: 'narrow',
    fields: [{ name: 'pin', label: '4-digit PIN', type: 'tel', required: true, maxlength: 4, pattern: '\\d{4}', full: true }],
    onSubmit: async (v) => { await api('/api/auth/pin/set', { method: 'POST', body: v }); toast('PIN saved'); },
  }));
}

import { api, cache, on as onEvent, queue, session, syncQueue } from './api.js';
import {
  $, beep, busy, esc, formModal, icon, initials, modal, on, timeAgo, toast, toastError,
} from './ui.js';

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const NAV = [
  { group: 'Overview' },
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard', load: () => import('./pages/dashboard.js') },
  { group: 'Service' },
  { path: '/pos', label: 'POS & Tables', icon: 'pos', perm: 'pos', load: () => import('./pages/pos.js') },
  { path: '/qr-orders', label: 'QR Orders', icon: 'qr', perm: 'qr_orders', badge: 'awaiting', load: () => import('./pages/qr-orders.js') },
  { path: '/kitchen', label: 'Kitchen', icon: 'kitchen', perm: 'kitchen', load: () => import('./pages/kitchen.js'), full: true },
  { path: '/live', label: 'Live Orders', icon: 'activity', perm: 'live_orders', load: () => import('./pages/live.js') },
  { path: '/bills', label: 'Bills', icon: 'receipt', perm: 'bills', load: () => import('./pages/bills.js') },
  { path: '/delivery', label: 'Delivery', icon: 'truck', perm: 'delivery', load: () => import('./pages/delivery.js') },
  { path: '/rider', label: 'Rider', icon: 'bike', perm: 'rider', load: () => import('./pages/rider.js') },
  { group: 'Manage' },
  { path: '/reports', label: 'Reports & Insights', icon: 'chart', perm: 'reports', load: () => import('./pages/reports.js') },
  { path: '/menu', label: 'Menu', icon: 'menu_book', perm: 'menu', load: () => import('./pages/menu.js') },
  { path: '/tables', label: 'Tables & QR', icon: 'grid', perm: 'tables_manage', load: () => import('./pages/tables.js') },
  { path: '/inventory', label: 'Stock', icon: 'package', perm: 'inventory', load: () => import('./pages/inventory.js') },
  { group: 'Administration' },
  { path: '/staff', label: 'Staff & Roles', icon: 'users', perm: ['staff', 'roles'], load: () => import('./pages/staff.js') },
  { path: '/settings', label: 'Settings', icon: 'settings', perm: 'settings', load: () => import('./pages/settings.js') },
  { path: '/subscription', label: 'Subscription', icon: 'crown', perm: 'subscription', load: () => import('./pages/subscription.js') },
];

const SA_NAV = [
  { group: 'Platform' },
  { path: '/admin', label: 'Overview', icon: 'dashboard', load: () => import('./pages/admin/overview.js') },
  { path: '/admin/restaurants', label: 'Restaurants', icon: 'store', load: () => import('./pages/admin/restaurants.js') },
  { path: '/admin/plans', label: 'Subscription Plans', icon: 'layers', load: () => import('./pages/admin/plans.js') },
  { path: '/admin/subscriptions', label: 'Purchases', icon: 'wallet', load: () => import('./pages/admin/subscriptions.js') },
  { path: '/admin/roles', label: 'Default Roles', icon: 'shield', load: () => import('./pages/admin/roles.js') },
];

/** Extra routes that are not in the sidebar. */
const ROUTES = [
  { pattern: '/pos/table/:id', perm: 'pos', nav: '/pos', load: () => import('./pages/pos.js'), view: 'table' },
  { pattern: '/pos/order/:id', perm: 'pos', nav: '/pos', load: () => import('./pages/pos.js'), view: 'order' },
  { pattern: '/pos/new/:type', perm: 'pos', nav: '/pos', load: () => import('./pages/pos.js'), view: 'new' },
  { pattern: '/admin/restaurants/:id', sa: true, nav: '/admin/restaurants', load: () => import('./pages/admin/restaurant-detail.js') },
  { pattern: '/account', load: () => import('./pages/account.js'), any: true },
];

export const can = (perm) => {
  const me = session.me;
  if (!me) return false;
  if (me.superAdmin) return true;
  return (Array.isArray(perm) ? perm : [perm]).some((p) => me.permissions.includes(p));
};

function navItems() { return session.me?.superAdmin ? SA_NAV : NAV; }
function homePath() {
  if (session.me?.superAdmin) return '/admin';
  const first = NAV.find((n) => n.path && can(n.perm));
  return first ? first.path : '/account';
}

function matchRoute(path) {
  for (const n of navItems()) if (n.path === path) return { ...n, params: {}, nav: n.path };
  for (const r of ROUTES) {
    const keys = [];
    const re = new RegExp(`^${r.pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    const m = re.exec(path);
    if (m) {
      if (r.sa && !session.me?.superAdmin) return null;
      if (!r.sa && !r.any && session.me?.superAdmin) return null;
      return { ...r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
  }
  return null;
}

export const go = (path) => { if (location.hash !== `#${path}`) location.hash = path; else render(); };
export const currentPath = () => location.hash.replace(/^#/, '').split('?')[0] || '/';
export const queryParams = () => new URLSearchParams(location.hash.split('?')[1] || '');

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
const state = { timers: [], leave: [], unread: 0, awaiting: 0, lastNotif: 0, notifTimer: null };

function logoMark(size = 36) {
  return `<div class="brand-logo" style="width:${size}px;height:${size}px"><img src="/static/assets/logo.svg" width="${size}" height="${size}" alt=""></div>`;
}

function shellHtml() {
  const me = session.me;
  const items = navItems();
  const nav = items.map((n) => {
    if (n.group) return `<div class="nav-group">${esc(n.group)}</div>`;
    if (!me.superAdmin && !can(n.perm)) return '';
    return `<a href="#${n.path}" data-path="${n.path}">${icon(n.icon, 18)}<span>${esc(n.label)}</span>${n.badge ? `<span class="badge hidden" data-badge="${n.badge}"></span>` : ''}</a>`;
  }).join('').replace(/(<div class="nav-group">[^<]*<\/div>)(?=<div class="nav-group">|$)/g, '');
  const sub = me.superAdmin
    ? `<div class="side-rest"><div class="n">TableX Platform</div><div class="p">${icon('shield', 13)} Super Admin console</div></div>`
    : `<div class="side-rest"><div class="n">${esc(me.restaurant.name)}</div><div class="p">${icon('crown', 13)} ${esc(me.plan?.name || 'No plan')} plan</div></div>`;
  return `
  <div class="app" id="app">
    <aside class="sidebar">
      <div class="brand">${logoMark()}<div class="brand-name">Table<span>X</span></div></div>
      ${sub}
      <nav class="nav">${nav}</nav>
      <div class="side-foot">
        <div class="user-chip">
          <a href="#/account" class="avatar" title="My account">${esc(initials(me.user.name))}</a>
          <div class="meta"><div>${esc(me.user.name)}</div><div>${esc(me.superAdmin ? 'Super Admin' : me.roleLabel)}</div></div>
          ${me.superAdmin ? '' : `<button class="btn ghost icon sm" data-act="switch" title="Switch user (PIN)">${icon('switch_user', 17)}</button>`}
          <button class="btn ghost icon sm" data-act="logout" title="Sign out">${icon('logout', 17)}</button>
        </div>
      </div>
    </aside>
    <div class="scrim" data-act="close-nav"></div>
    <div class="main">
      <div class="offline-bar" id="offline-bar">${icon('wifi_off', 16)}<span id="offline-text">Offline — orders are saved on this device</span><span class="spacer"></span><button class="btn sm" data-act="sync">${icon('refresh', 14)} Sync now</button></div>
      <header class="topbar">
        <button class="btn ghost icon hamb" data-act="open-nav" aria-label="Menu">${icon('hamburger')}</button>
        <div class="title" id="page-title"></div>
        <div class="spacer"></div>
        <div id="page-actions" class="row"></div>
        <button class="btn ghost icon" data-act="theme" title="Toggle dark mode">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
        ${me.superAdmin ? '' : `<div class="bell" style="position:relative"><button class="btn ghost icon" data-act="bell" title="Notifications">${icon('bell')}</button><span class="dot hidden" id="bell-dot"></span></div>`}
      </header>
      <div id="sub-banner"></div>
      <main class="content" id="content"></main>
    </div>
  </div>`;
}

function bindShell() {
  const app = $('#app');
  on(app, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    if (act === 'logout') logout();
    if (act === 'open-nav') app.classList.add('nav-open');
    if (act === 'close-nav') app.classList.remove('nav-open');
    if (act === 'theme') {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('tx_theme', next); } catch { /* ignore */ }
      el.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    }
    if (act === 'sync') busy(el, async () => { const r = await syncQueue(); if (!r.sent && !r.failed.length) toast('Still offline — will retry automatically', 'info'); });
    if (act === 'switch') pinSwitch();
    if (act === 'bell') openNotifications(el);
  });
  on(app, 'click', '.nav a', () => app.classList.remove('nav-open'));
  updateOfflineBar();
}

function setActiveNav(path) {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === path));
}

function subscriptionBanner() {
  const me = session.me;
  const el = $('#sub-banner');
  if (!el || me.superAdmin) return;
  const ends = me.restaurant.subscription_ends_at ? Date.parse(me.restaurant.subscription_ends_at) : 0;
  const days = Math.ceil((ends - Date.now()) / 86400000);
  if (me.subscription?.active && days > 7) { el.innerHTML = ''; return; }
  const renew = can('subscription') ? `<a class="btn sm solid" href="#/subscription">${icon('crown', 14)} ${me.subscription?.active ? 'Renew now' : 'Choose a plan'}</a>` : '';
  const msg = me.subscription?.reason === 'suspended' ? 'Access to this restaurant has been paused by TableX. Please contact support.'
    : !me.subscription?.active ? 'Your TableX subscription is not active. Renew to keep using the app.'
      : `Your ${esc(me.plan?.name || '')} plan ends in ${days} day${days === 1 ? '' : 's'}.`;
  el.innerHTML = `<div style="padding:12px 28px 0"><div class="notice ${me.subscription?.active ? 'warning' : 'danger'}">${icon('alert')}<div style="flex:1">${msg}</div>${renew}</div></div>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
let renderSeq = 0;
async function render() {
  if (!session.token || !session.me) return renderLogin();
  const path = currentPath();
  if (path === '/' || path === '/login') return go(homePath());
  const route = matchRoute(path);
  if (!route || (!route.any && !session.me.superAdmin && !can(route.perm))) return go(homePath());
  if (!$('#app')) { $('#root').innerHTML = shellHtml(); bindShell(); startPolling(); }
  subscriptionBanner();
  cleanupPage();
  setActiveNav(route.nav || route.path);
  const seq = ++renderSeq;
  // Fresh container per screen so event listeners from the previous screen never leak.
  const old = $('#content');
  const el = old.cloneNode(false);
  old.replaceWith(el);
  el.className = `content${route.full ? ' full' : ''}`;
  el.innerHTML = '<div class="loader">Loading…</div>';
  $('#page-actions').innerHTML = '';
  const label = route.label || '';
  $('#page-title').innerHTML = esc(label);
  document.title = `${label ? `${label} · ` : ''}TableX`;

  const locked = !session.me.superAdmin && !session.me.subscription?.active && !['/subscription', '/account'].includes(path);
  if (locked) {
    el.innerHTML = `<div class="card pad" style="max-width:560px;margin:40px auto;text-align:center">
      <div class="empty" style="padding:20px"><div class="em-icon">${icon('lock', 28)}</div><h3>TableX is paused for this restaurant</h3>
      <p>${session.me.subscription?.reason === 'suspended' ? 'Access has been paused by the TableX team. Please contact support.' : 'The subscription has ended. The owner can renew the plan to continue.'}</p>
      ${can('subscription') ? `<a class="btn primary" style="margin-top:18px" href="#/subscription">${icon('crown')} View plans</a>` : ''}</div></div>`;
    return;
  }

  try {
    const mod = await route.load();
    if (seq !== renderSeq) return;
    const ctx = {
      el, params: route.params, view: route.view, me: session.me, query: queryParams(),
      setTitle: (t, actions) => {
        $('#page-title').innerHTML = t;
        if (actions !== undefined) $('#page-actions').innerHTML = actions;
        document.title = `${$('#page-title').textContent} · TableX`;
      },
      setActions: (html) => { $('#page-actions').innerHTML = html; },
      actionsEl: $('#page-actions'),
      every: (fn, ms) => { state.timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); },
      onLeave: (fn) => state.leave.push(fn),
      go,
      refreshMe,
      isCurrent: () => seq === renderSeq,
    };
    await mod.default(ctx);
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    el.innerHTML = `<div class="card pad"><div class="empty"><div class="em-icon">${icon('alert', 28)}</div><h3>Could not open this screen</h3><p>${esc(err.message)}</p><button class="btn" style="margin-top:14px" onclick="location.reload()">${icon('refresh')} Reload</button></div></div>`;
  }
}

function cleanupPage() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.leave.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  state.leave = [];
  document.querySelectorAll('.modal-root').forEach((m) => m.remove());
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export async function refreshMe() {
  session.me = await api('/api/auth/me');
  return session.me;
}

function renderLogin(message) {
  cleanupPage();
  stopPolling();
  document.title = 'Sign in · TableX';
  $('#root').innerHTML = `
  <div class="auth">
    <section class="auth-art">
      <div class="brand" style="padding:0">${logoMark(40)}<div class="brand-name" style="font-size:22px">Table<span>X</span></div></div>
      <h1>Run every table, ticket and rupee from one screen.</h1>
      <p class="lead">Take orders, fire kitchen tickets, settle bills with UPI or cards, dispatch deliveries and read the day's numbers — on any phone or computer.</p>
      <div class="auth-feats">
        <div class="auth-feat">${icon('qr')} QR table ordering</div>
        <div class="auth-feat">${icon('kitchen')} Live kitchen display</div>
        <div class="auth-feat">${icon('card')} Razorpay payments</div>
        <div class="auth-feat">${icon('chart')} Daily sales insights</div>
        <div class="auth-feat">${icon('bike')} Delivery & riders</div>
        <div class="auth-feat">${icon('wifi_off')} Works offline</div>
      </div>
    </section>
    <section class="auth-form">
      <div class="auth-card">
        <div class="brand" style="padding:0 0 28px;color:var(--text)">${logoMark(40)}<div class="brand-name" style="font-size:22px;color:var(--text)">Table<span class="grad-text">X</span></div></div>
        <h2>Welcome back</h2>
        <p class="muted" style="margin:6px 0 26px">Sign in with your own mobile number or email.</p>
        ${message ? `<div class="notice warning" style="margin-bottom:18px">${icon('info')}<div>${esc(message)}</div></div>` : ''}
        <form id="login" class="col" style="gap:16px">
          <div class="field"><label>Mobile number or email</label>
            <div class="input-icon">${icon('smartphone', 17)}<input class="input" name="login" autocomplete="username" required placeholder="98765 43210"></div></div>
          <div class="field"><label>Password</label>
            <div class="input-icon" style="position:relative">${icon('key', 17)}<input class="input" name="password" type="password" autocomplete="current-password" required placeholder="••••••••" style="padding-right:44px">
            <button type="button" class="btn ghost icon sm" data-eye style="position:absolute;right:5px;top:5px">${icon('eye', 16)}</button></div></div>
          <button class="btn primary lg block" type="submit">Sign in ${icon('chevron_right', 18)}</button>
        </form>
        <p class="muted small" style="margin-top:22px;text-align:center">Every person needs their own login. Ask your owner or manager to create one for you.</p>
      </div>
    </section>
  </div>`;
  const form = $('#login');
  form.querySelector('[data-eye]').addEventListener('click', (e) => {
    const inp = form.querySelector('[name=password]');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    e.currentTarget.innerHTML = icon(inp.type === 'password' ? 'eye' : 'eye_off', 16);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    await busy(btn, async () => {
      try {
        const res = await api('/api/auth/login', { method: 'POST', body: { login: form.login.value, password: form.password.value, device: navigator.userAgent } });
        startSession(res);
      } catch (err) { toastError(err); }
    });
  });
}

function startSession(res) {
  session.token = res.token;
  const { token, ...me } = res;
  session.me = me;
  cache.clear();
  cache.set('me', me);
  $('#root').innerHTML = '';
  if (currentPath() === '/' || currentPath() === '/login') go(homePath()); else render();
}

async function logout(message) {
  try { if (session.token && !message) await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  session.token = null;
  session.me = null;
  cache.clear();
  history.replaceState(null, '', '#/login');
  renderLogin(message);
}

function pinSwitch() {
  let pin = '';
  const m = modal({
    title: 'Switch user', size: 'narrow',
    body: `<p class="muted" style="text-align:center;margin-bottom:16px">Enter your 4-digit PIN</p>
      <div class="row" style="justify-content:center;gap:12px;margin-bottom:20px" id="pin-dots">${'<span class="avatar" style="background:var(--surface-3);width:18px;height:18px"></span>'.repeat(4)}</div>
      <div class="grid g3" style="gap:10px">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, '⌫'].map((k) => `<button class="btn xl" data-k="${k}">${k}</button>`).join('')}</div>`,
  });
  const dots = () => { m.el.querySelectorAll('#pin-dots span').forEach((d, i) => { d.style.background = i < pin.length ? 'var(--primary)' : 'var(--surface-3)'; }); };
  const submit = async () => {
    try {
      const res = await api('/api/auth/pin', { method: 'POST', body: { pin } });
      m.close();
      toast(`Switched to ${res.user.name}`);
      $('#root').innerHTML = '';
      session.token = res.token;
      const { token, ...me } = res;
      session.me = me;
      go(homePath());
      render();
    } catch (err) { pin = ''; dots(); toastError(err); }
  };
  on(m.el, 'click', '[data-k]', (e, b) => {
    const k = b.dataset.k;
    if (k === 'C') pin = ''; else if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
    dots();
    if (pin.length === 4) submit();
  });
}

// ---------------------------------------------------------------------------
// Notifications, QR badge and offline status
// ---------------------------------------------------------------------------
async function pollNotifications(first = false) {
  if (!session.me || session.me.superAdmin) return;
  try {
    const res = await api(`/api/notifications?since=${state.lastNotif}`);
    const fresh = res.items.filter((n) => n.id > state.lastNotif);
    if (fresh.length) {
      state.lastNotif = Math.max(...fresh.map((n) => n.id));
      if (!first) {
        beep(2);
        fresh.slice(0, 3).forEach((n) => toast(n.title, 'info', 6000));
      }
    }
    state.unread = res.unread;
    const dot = $('#bell-dot');
    if (dot) { dot.textContent = res.unread > 9 ? '9+' : res.unread; dot.classList.toggle('hidden', !res.unread); }
    if (can('qr_orders')) {
      const qr = await api('/api/qr-orders');
      const b = document.querySelector('[data-badge=awaiting]');
      if (b) { b.textContent = qr.length; b.classList.toggle('hidden', !qr.length); }
    }
  } catch { /* offline — ignore */ }
}

function startPolling() {
  stopPolling();
  pollNotifications(true);
  state.notifTimer = setInterval(() => { if (!document.hidden) pollNotifications(); }, 8000);
}
function stopPolling() { clearInterval(state.notifTimer); state.notifTimer = null; state.lastNotif = 0; }

async function openNotifications(btn) {
  const wrap = btn.parentElement;
  const existing = wrap.querySelector('.popover');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = '<div class="loader">Loading…</div>';
  wrap.appendChild(pop);
  const close = (e) => { if (!wrap.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close));
  try {
    const res = await api('/api/notifications?since=0');
    pop.innerHTML = `<div class="row" style="padding:12px 14px;border-bottom:1px solid var(--border)"><b>Notifications</b><span class="spacer"></span>
      ${res.unread ? '<button class="btn ghost sm" data-read>Mark all read</button>' : ''}</div>
      ${res.items.length ? res.items.map((n) => `<div class="item ${n.read ? '' : 'unread'}">${icon(n.type === 'call_waiter' ? 'hand' : 'qr', 18)}
        <div style="flex:1;min-width:0"><div class="bold">${esc(n.title)}</div>${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}<div class="tiny muted">${timeAgo(n.created_at)}</div></div></div>`).join('')
    : '<div class="empty" style="padding:30px">No notifications yet</div>'}`;
    pop.querySelector('[data-read]')?.addEventListener('click', async () => {
      await api('/api/notifications/read', { method: 'POST', body: {} });
      pop.remove();
      pollNotifications();
    });
  } catch (err) { pop.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
}

function updateOfflineBar(online = navigator.onLine) {
  const bar = $('#offline-bar');
  if (!bar) return;
  const pending = queue.list().length;
  const show = !online || pending > 0;
  bar.classList.toggle('show', show);
  $('#offline-text').textContent = !online
    ? `Offline — orders are saved on this device${pending ? ` (${pending} waiting)` : ''}`
    : `${pending} saved order${pending === 1 ? '' : 's'} waiting to sync`;
}

onEvent('network', (ok) => { updateOfflineBar(ok); if (ok && queue.list().length) syncQueue(); });
onEvent('queue', () => updateOfflineBar());
onEvent('synced', ({ sent, failed }) => {
  if (sent) toast(`${sent} saved order${sent === 1 ? '' : 's'} sent to the kitchen`);
  failed.forEach((f) => toast(`Could not sync an order: ${f.error}`, 'error', 7000));
  updateOfflineBar();
});
onEvent('unauthorized', (err) => logout(err.message));
onEvent('subscription', async () => { try { await refreshMe(); render(); } catch { /* ignore */ } });
window.addEventListener('online', () => { updateOfflineBar(true); syncQueue(); });
window.addEventListener('offline', () => updateOfflineBar(false));
window.addEventListener('hashchange', render);

export { formModal };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!session.token) return renderLogin();
  try {
    await refreshMe();
  } catch (err) {
    if (err.code === 'OFFLINE' && cache.get('me')) session.me = cache.get('me');
    else return renderLogin(err.status === 401 ? err.message : undefined);
  }
  cache.set('me', session.me);
  render();
  if (queue.list().length) syncQueue();
}());

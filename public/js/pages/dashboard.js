import { api } from '../api.js';
import { can } from '../app.js';
import { METHOD, ORDER_TYPE, empty, esc, icon, money, num } from '../ui.js';

const DONUT = ['#6247F5', '#12C2E9', '#9B5CF6', '#10B981', '#F5A524', '#F0446A'];

export function barChart(days, { valueKey = 'total', fmt = money, label = (d) => new Date(d.date).toLocaleDateString('en-IN', { weekday: 'short' }) } = {}) {
  const max = Math.max(1, ...days.map((d) => d[valueKey]));
  return `<div class="bars">${days.map((d) => `<div class="bar"><div class="b" style="height:${Math.max(2, (d[valueKey] / max) * 100)}%" data-v="${esc(fmt(d[valueKey]))}"></div><div class="l">${esc(label(d))}</div></div>`).join('')}</div>`;
}

export function donut(parts, size = 150) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let acc = 0;
  const r = 15.9155;
  const segs = parts.map((p, i) => {
    const pct = (p.value / total) * 100;
    const s = `<circle r="${r}" cx="21" cy="21" fill="none" stroke="${DONUT[i % DONUT.length]}" stroke-width="5.5" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${25 - acc}"></circle>`;
    acc += pct;
    return s;
  }).join('');
  return `<div class="row" style="gap:22px;align-items:center"><svg viewBox="0 0 42 42" width="${size}" height="${size}"><circle r="${r}" cx="21" cy="21" fill="none" stroke="var(--surface-3)" stroke-width="5.5"></circle>${segs}</svg>
    <div class="donut-legend">${parts.map((p, i) => `<div><i style="background:${DONUT[i % DONUT.length]}"></i><span style="flex:1">${esc(p.label)}</span><b class="money">${esc(p.display ?? p.value)}</b></div>`).join('')}</div></div>`;
}

export default async function dashboard(ctx) {
  const me = ctx.me;
  ctx.setTitle(`${icon('dashboard', 20)}<span>Dashboard</span>`);
  const d = await api('/api/dashboard');
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const tables = Object.fromEntries(d.tables.map((t) => [t.status, t.c]));
  const totalTables = d.tables.reduce((s, t) => s + t.c, 0);
  const week = d.days.reduce((s, x) => s + x.total, 0);

  ctx.el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>${greet}, ${esc(me.user.name.split(' ')[0])} 👋</h1>
      <div class="sub">Here is how ${esc(me.restaurant.name)} is doing today.</div></div>
      ${can('pos') ? `<a class="btn primary" href="#/pos">${icon('pos')} Open POS</a>` : ''}
    </div>
    <div class="grid g4">
      <div class="card kpi hero"><div class="kpi-label">Today's sales</div><div class="kpi-value money">${money(d.today.total)}</div>
        <div class="small" style="opacity:.85">${d.today.orders} paid orders · avg ${money(d.today.avg)}</div><div class="kpi-icon">${icon('trending')}</div></div>
      <div class="card kpi"><div class="kpi-label">Running orders</div><div class="kpi-value">${d.running.c}</div><div class="small muted">${money(d.running.v)} on the floor</div><div class="kpi-icon">${icon('activity')}</div></div>
      <div class="card kpi"><div class="kpi-label">Tables occupied</div><div class="kpi-value">${(tables.occupied || 0) + (tables.billed || 0)}<span class="muted" style="font-size:16px"> / ${totalTables}</span></div>
        <div class="small muted">${tables.free || 0} free · ${tables.reserved || 0} reserved</div><div class="kpi-icon">${icon('armchair')}</div></div>
      <div class="card kpi"><div class="kpi-label">Kitchen queue</div><div class="kpi-value">${d.kitchen}</div>
        <div class="small muted">${d.awaiting ? `<a href="#/qr-orders" style="color:var(--danger);font-weight:700">${d.awaiting} QR order(s) waiting</a>` : 'No QR orders waiting'}</div><div class="kpi-icon">${icon('flame')}</div></div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);margin-top:16px" id="dash-row">
      <div class="card"><div class="card-head"><h3>Sales — last 7 days</h3><span class="badge primary">${money(week)}</span></div>
        <div class="card-body">${barChart(d.days)}</div></div>
      <div class="card"><div class="card-head"><h3>Today's payments</h3></div><div class="card-body">
        ${d.methods.length ? donut(d.methods.map((m) => ({ label: METHOD[m.method] || m.method, value: m.v, display: money(m.v) }))) : empty('wallet', 'No payments yet today')}
      </div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h3>Top dishes this week</h3></div><div class="card-body">
        ${d.top.length ? d.top.map((t) => `<div class="hbar"><span class="bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</span><div class="track"><div class="fill" style="width:${(t.qty / d.top[0].qty) * 100}%"></div></div><span class="small muted">${num(t.qty)} sold</span></div>`).join('') : empty('menu_book', 'No sales yet')}
      </div></div>
      <div class="card"><div class="card-head"><h3>Today by order type</h3></div><div class="card-body">
        ${d.byType.length ? d.byType.map((t) => `<div class="row" style="padding:10px 0;border-bottom:1px solid var(--border)"><span class="avatar" style="width:36px;height:36px;border-radius:12px">${icon(t.type === 'delivery' ? 'truck' : t.type === 'takeaway' ? 'bag' : 'armchair', 17)}</span>
          <div style="flex:1"><div class="bold">${ORDER_TYPE[t.type]}</div><div class="small muted">${t.c} orders</div></div><b class="money">${money(t.v)}</b></div>`).join('') : empty('bag', 'No orders settled yet today')}
      </div></div>
    </div>`;
  const row = ctx.el.querySelector('#dash-row');
  const fit = () => { row.style.gridTemplateColumns = window.innerWidth < 1000 ? 'minmax(0,1fr)' : 'minmax(0,2fr) minmax(0,1fr)'; };
  fit();
  window.addEventListener('resize', fit);
  ctx.onLeave(() => window.removeEventListener('resize', fit));
}

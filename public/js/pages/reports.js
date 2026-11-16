import { api } from '../api.js';
import {
  METHOD, ORDER_TYPE, downloadCsv, empty, esc, icon, money, num, printHtml, today, toastError,
} from '../ui.js';
import { barChart, donut } from './dashboard.js';
import { session } from '../api.js';

export default async function reports(ctx) {
  let tab = 'daily';
  let date = today();
  const toDate = today();
  const fromDate = new Date(Date.now() - 29 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  let range = { from: fromDate, to: toDate };
  ctx.setTitle(`${icon('chart', 20)}<span>Reports & Insights</span>`);

  const shell = () => {
    ctx.el.innerHTML = `<div class="tabs"><button data-tab="daily" class="${tab === 'daily' ? 'active' : ''}">Daily item sales</button><button data-tab="trends" class="${tab === 'trends' ? 'active' : ''}">Sales trends</button></div><div id="rep"></div>`;
    ctx.el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; shell(); }));
    (tab === 'daily' ? daily : trends)().catch(toastError);
  };

  const daily = async () => {
    const el = ctx.el.querySelector('#rep');
    el.innerHTML = '<div class="loader">Loading…</div>';
    const r = await api(`/api/reports/daily-items?date=${date}`);
    const t = r.totals;
    el.innerHTML = `
      <div class="row wrap" style="margin-bottom:16px">
        <input type="date" class="input sm" id="rdate" value="${r.date}" style="width:170px">
        <span class="spacer"></span>
        <button class="btn sm" id="rprint">${icon('printer', 15)} Print</button>
        <button class="btn sm" id="rcsv">${icon('download', 15)} CSV (Excel)</button>
      </div>
      ${r.open_orders ? `<div class="notice warning" style="margin-bottom:16px">${icon('alert')}<div>${r.open_orders} order(s) are still open. Settle them so today's report is complete.</div></div>` : ''}
      <div class="grid g4" style="margin-bottom:16px">
        <div class="card kpi hero"><div class="kpi-label">Net sales</div><div class="kpi-value money">${money(t.net)}</div><div class="small" style="opacity:.85">${t.orders} orders</div></div>
        <div class="card kpi"><div class="kpi-label">Items sold</div><div class="kpi-value">${num(t.quantity)}</div><div class="small muted">Gross ${money(t.gross)}</div></div>
        <div class="card kpi"><div class="kpi-label">Discounts</div><div class="kpi-value money">${money(t.discount)}</div><div class="small muted">${r.cancelled.c} cancelled lines (${money(r.cancelled.v)})</div></div>
        <div class="card kpi"><div class="kpi-label">Tax & charges</div><div class="kpi-value money">${money(t.tax + t.service_charge + t.delivery_fee)}</div><div class="small muted">GST ${money(t.tax)} · Service ${money(t.service_charge)}</div></div>
      </div>
      <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr);align-items:start" id="rgrid">
        <div class="card"><div class="card-head"><h3>Items sold on ${new Date(r.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</h3></div>
          <div class="table-wrap">${r.items.length ? `<table class="tbl"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Orders</th><th class="r">Amount</th></tr></thead>
            <tbody>${r.items.map((i) => `<tr><td class="bold">${esc(i.name)}</td><td class="r">${i.qty}</td><td class="r">${i.orders}</td><td class="r money">${money(i.amount)}</td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Total</td><td class="r">${t.quantity}</td><td class="r">${t.orders}</td><td class="r money">${money(t.gross)}</td></tr></tfoot></table>` : empty('chart', 'No sales on this day')}</div></div>
        <div class="col" style="gap:16px">
          <div class="card"><div class="card-head"><h3>Payment split</h3></div><div class="card-body">${r.methods.length ? donut(r.methods.map((m) => ({ label: METHOD[m.method] || m.method, value: m.amount, display: money(m.amount) })), 120) : '<p class="muted">No payments.</p>'}</div></div>
          <div class="card"><div class="card-head"><h3>Summary</h3></div><div class="card-body col" style="gap:4px">
            <div class="sum-row"><span>Gross sales</span><span class="money">${money(t.gross)}</span></div>
            <div class="sum-row"><span>Discounts</span><span class="money">−${money(t.discount)}</span></div>
            <div class="sum-row"><span>Service charge</span><span class="money">${money(t.service_charge)}</span></div>
            <div class="sum-row"><span>GST</span><span class="money">${money(t.tax)}</span></div>
            <div class="sum-row"><span>Delivery fees</span><span class="money">${money(t.delivery_fee)}</span></div>
            <div class="sum-row"><span>Round off</span><span class="money">${money(t.round_off)}</span></div>
            <div class="sum-row total"><span>Net sales</span><span class="money">${money(t.net)}</span></div>
            ${r.byType.map((b) => `<div class="sum-row"><span>${ORDER_TYPE[b.type]} (${b.orders})</span><span class="money">${money(b.amount)}</span></div>`).join('')}
          </div></div>
        </div>
      </div>`;
    const g = el.querySelector('#rgrid');
    if (window.innerWidth < 1000) g.style.gridTemplateColumns = 'minmax(0,1fr)';
    el.querySelector('#rdate').addEventListener('change', (e) => { date = e.target.value; daily().catch(toastError); });
    el.querySelector('#rcsv').addEventListener('click', () => downloadCsv(`tablex-daily-items-${r.date}.csv`, [
      ['Item', 'Quantity', 'Orders', 'Amount'], ...r.items.map((i) => [i.name, i.qty, i.orders, i.amount.toFixed(2)]), [],
      ['Total quantity', t.quantity], ['Gross sales', t.gross], ['Discounts', t.discount], ['Service charge', t.service_charge], ['GST', t.tax],
      ['Delivery fees', t.delivery_fee], ['Round off', t.round_off], ['Net sales', t.net], [], ...r.methods.map((m) => [METHOD[m.method] || m.method, m.amount.toFixed(2)]),
    ]));
    el.querySelector('#rprint').addEventListener('click', () => printHtml(`<div class="receipt"><div class="c"><h3>${esc(session.me.restaurant.name)}</h3><div>Daily item sales — ${r.date}</div></div><hr>
      <table><tr><td><b>Item</b></td><td class="r"><b>Qty</b></td><td class="r"><b>Amt</b></td></tr>${r.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${i.qty}</td><td class="r">${i.amount.toFixed(2)}</td></tr>`).join('')}</table><hr>
      <table><tr><td>Total qty</td><td class="r">${t.quantity}</td></tr><tr><td>Gross</td><td class="r">${t.gross.toFixed(2)}</td></tr><tr><td>Discounts</td><td class="r">-${t.discount.toFixed(2)}</td></tr>
      <tr><td>GST</td><td class="r">${t.tax.toFixed(2)}</td></tr><tr><td>Service</td><td class="r">${t.service_charge.toFixed(2)}</td></tr><tr class="tot"><td>NET</td><td class="r">${t.net.toFixed(2)}</td></tr></table><hr>
      <table>${r.methods.map((m) => `<tr><td>${METHOD[m.method] || m.method}</td><td class="r">${m.amount.toFixed(2)}</td></tr>`).join('')}</table></div>`));
  };

  const trends = async () => {
    const el = ctx.el.querySelector('#rep');
    el.innerHTML = '<div class="loader">Loading…</div>';
    const r = await api(`/api/reports/summary?from=${range.from}&to=${range.to}`);
    const peak = Math.max(1, ...r.hours.map((h) => h.orders));
    el.innerHTML = `
      <div class="row wrap" style="margin-bottom:16px;gap:8px">
        <input type="date" class="input sm" id="rf" value="${r.from}" style="width:160px"><span class="muted">to</span>
        <input type="date" class="input sm" id="rt" value="${r.to}" style="width:160px">
        <span class="spacer"></span>
        <button class="btn sm" id="tcsv">${icon('download', 15)} CSV</button>
      </div>
      <div class="grid g3" style="margin-bottom:16px">
        <div class="card kpi hero"><div class="kpi-label">Sales</div><div class="kpi-value money">${money(r.total)}</div></div>
        <div class="card kpi"><div class="kpi-label">Orders</div><div class="kpi-value">${num(r.orders)}</div></div>
        <div class="card kpi"><div class="kpi-label">Average bill</div><div class="kpi-value money">${money(r.avg)}</div></div>
      </div>
      <div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Daily sales</h3></div><div class="card-body" style="overflow-x:auto">
        <div style="min-width:${Math.max(600, r.series.length * 26)}px">${barChart(r.series, { label: (d) => d.date.slice(8) })}</div></div></div>
      <div class="grid g3">
        <div class="card"><div class="card-head"><h3>By category</h3></div><div class="card-body">${r.categories.length ? r.categories.map((c) => `<div class="hbar"><span>${esc(c.name)}</span><div class="track"><div class="fill" style="width:${(c.amount / r.categories[0].amount) * 100}%"></div></div><span class="small money">${money(c.amount)}</span></div>`).join('') : '<p class="muted">No data.</p>'}</div></div>
        <div class="card"><div class="card-head"><h3>Busiest hours</h3></div><div class="card-body">${r.hours.filter((h) => h.orders).map((h) => `<div class="hbar" style="grid-template-columns:60px minmax(0,1fr) 40px"><span>${String(h.hour).padStart(2, '0')}:00</span><div class="track"><div class="fill" style="width:${(h.orders / peak) * 100}%"></div></div><span class="small">${h.orders}</span></div>`).join('') || '<p class="muted">No data.</p>'}</div></div>
        <div class="card"><div class="card-head"><h3>Staff performance</h3></div><div class="card-body">${r.staff.length ? r.staff.map((s) => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--border)"><span style="flex:1" class="bold">${esc(s.name)}</span><span class="small muted">${s.orders} orders</span><b class="money">${money(s.amount)}</b></div>`).join('') : '<p class="muted">No data.</p>'}</div></div>
      </div>`;
    const set = () => { range = { from: el.querySelector('#rf').value, to: el.querySelector('#rt').value }; trends().catch(toastError); };
    el.querySelector('#rf').addEventListener('change', set);
    el.querySelector('#rt').addEventListener('change', set);
    el.querySelector('#tcsv').addEventListener('click', () => downloadCsv(`tablex-sales-${r.from}-to-${r.to}.csv`, [['Date', 'Orders', 'Sales'], ...r.series.map((d) => [d.date, d.orders, d.total.toFixed(2)])]));
  };

  shell();
}

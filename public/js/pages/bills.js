import { api } from '../api.js';
import { can } from '../app.js';
import {
  METHOD, ORDER_TYPE, badge, debounce, empty, esc, fmtDateTime, fmtTime, icon, modal, money, on, today, toastError,
} from '../ui.js';
import { copyBill, openBillDialog, printBill } from './shared.js';

export default async function bills(ctx) {
  let date = today();
  let q = '';
  ctx.setTitle(`${icon('receipt', 20)}<span>Bills</span>`);

  ctx.el.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Bills</h1><div class="sub">Every bill is kept forever — open, reprint or copy it any time.</div></div></div>
    <div class="card">
      <div class="card-head" style="flex-wrap:wrap">
        <input type="date" class="input sm" id="bdate" value="${date}" style="width:170px">
        <div class="input-icon" style="flex:1;min-width:220px">${icon('search', 16)}<input class="input sm" id="bq" placeholder="Search bill no, table, phone or name (all dates)"></div>
        <div id="bsum" class="bold"></div>
      </div>
      <div class="table-wrap" id="blist"><div class="loader">Loading…</div></div>
    </div>`;

  const load = async () => {
    try {
      const res = await api(`/api/bills?${q ? `q=${encodeURIComponent(q)}` : `date=${date}`}`);
      ctx.el.querySelector('#bsum').innerHTML = `${res.bills.length} bills · <span class="money">${money(res.total)}</span> paid`;
      ctx.el.querySelector('#blist').innerHTML = res.bills.length ? `<table class="tbl"><thead><tr><th>Bill</th><th>Time</th><th>Type</th><th>Table / guest</th><th>Payment</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
        ${res.bills.map((b) => `<tr class="clickable" data-id="${b.id}">
          <td class="bold">${esc(b.bill_no)}<div class="tiny muted">Order #${b.order_no}</div></td>
          <td>${q ? fmtDateTime(b.billed_at) : fmtTime(b.billed_at)}</td>
          <td>${ORDER_TYPE[b.type]}</td>
          <td>${b.table_name ? `Table ${esc(b.table_name)}` : ''}${b.customer_name || b.customer_phone ? `<div class="small muted">${esc(b.customer_name || '')} ${esc(b.customer_phone || '')}</div>` : ''}</td>
          <td>${(b.methods || '').split(',').filter(Boolean).map((m) => `<span class="badge">${METHOD[m] || m}</span>`).join(' ')}</td>
          <td>${badge(b.status)}</td>
          <td class="r money bold">${money(b.total)}</td></tr>`).join('')}</tbody></table>`
        : empty('receipt', 'No bills found', q ? 'Try another search.' : 'No bills on this date.');
    } catch (e) { toastError(e); }
  };

  const open = async (id) => {
    const o = await api(`/api/orders/${id}`);
    const m = modal({
      title: `Bill ${o.bill_no}`, size: 'wide',
      body: `<div class="grid g2" style="align-items:start">
        <div class="col" style="gap:4px">
          <div class="row"><span class="muted">Order</span><span class="spacer"></span>#${o.order_no} · ${ORDER_TYPE[o.type]}</div>
          ${o.table_name ? `<div class="row"><span class="muted">Table</span><span class="spacer"></span>${esc(o.table_name)}</div>` : ''}
          <div class="row"><span class="muted">Billed</span><span class="spacer"></span>${fmtDateTime(o.billed_at)}</div>
          ${o.captain_name ? `<div class="row"><span class="muted">Taken by</span><span class="spacer"></span>${esc(o.captain_name)}</div>` : ''}
          ${o.customer_name || o.customer_phone ? `<div class="row"><span class="muted">Guest</span><span class="spacer"></span>${esc(o.customer_name)} ${esc(o.customer_phone)}</div>` : ''}
          <div style="border-top:1px solid var(--border);margin:10px 0"></div>
          ${o.items.map((i) => `<div class="sum-row" style="${i.status === 'cancelled' ? 'text-decoration:line-through;opacity:.6' : ''}"><span>${i.qty} × ${esc(i.name)}</span><span class="money">${money(i.qty * i.price)}</span></div>`).join('')}
          <div class="sum-row total"><span>Total</span><span class="money">${money(o.total)}</span></div>
        </div>
        <div class="col">
          <h3>Payments</h3>
          ${o.payments.length ? o.payments.map((p) => `<div class="card" style="padding:12px"><div class="row"><b>${METHOD[p.method] || p.method}</b><span class="spacer"></span><span class="money bold">${money(p.amount)}</span></div>
            <div class="tiny muted">${fmtDateTime(p.created_at)}${p.received_by_name ? ` · ${esc(p.received_by_name)}` : ''}${p.reference ? ` · ${esc(p.reference)}` : ''}</div></div>`).join('') : '<p class="muted">No payments yet.</p>'}
          ${o.status !== 'paid' && can('billing') ? `<button class="btn primary" data-x="pay">${icon('wallet')} Take payment (${money(o.total - o.paid)})</button>` : ''}
        </div></div>`,
      foot: `<button class="btn" data-x="copy">${icon('copy')} Copy</button><button class="btn solid" data-x="print">${icon('printer')} Print bill</button>`,
    });
    on(m.el, 'click', '[data-x]', (e, b) => {
      if (b.dataset.x === 'print') printBill(o);
      if (b.dataset.x === 'copy') copyBill(o);
      if (b.dataset.x === 'pay') { m.close(); openBillDialog(o, { startWithPay: true, onDone: () => load() }); }
    });
  };

  ctx.el.querySelector('#bdate').addEventListener('change', (e) => { date = e.target.value; q = ''; ctx.el.querySelector('#bq').value = ''; load(); });
  ctx.el.querySelector('#bq').addEventListener('input', debounce((e) => { q = e.target.value.trim(); load(); }, 300));
  on(ctx.el, 'click', '[data-id]', (e, r) => open(r.dataset.id).catch(toastError));
  await load();
}

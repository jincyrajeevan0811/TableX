import { api, session } from '../api.js';
import {
  METHOD, ORDER_TYPE, busy, copyText, esc, fmtDateTime, icon, modal, money, on, printHtml, toast, toastError,
} from '../ui.js';
import { can } from '../app.js';
import { razorpayPay } from '../pay.js';

export { razorpayPay };

const liveItems = (o) => o.items.filter((i) => !['cancelled', 'pending'].includes(i.status));

/** Group identical lines (same item + price + note) for printing. */
function groupLines(items) {
  const map = new Map();
  for (const i of items) {
    const k = `${i.name}|${i.price}|${i.note || ''}`;
    const g = map.get(k);
    if (g) g.qty += i.qty; else map.set(k, { ...i });
  }
  return [...map.values()];
}

export function receiptHtml(o) {
  const r = session.me.restaurant;
  const s = r.settings;
  const lines = groupLines(liveItems(o));
  const row = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${v}</td></tr>`;
  return `<div class="receipt">
    <div class="c"><h3>${esc(r.name)}</h3>${r.address ? `<div>${esc(r.address)}</div>` : ''}${r.phone ? `<div>Ph: ${esc(r.phone)}</div>` : ''}
    ${s.gst_enabled && s.gstin ? `<div>GSTIN: ${esc(s.gstin)}</div>` : ''}</div><hr>
    <table>${row(`Bill: <b>${esc(o.bill_no || '—')}</b>`, `#${o.order_no}`)}${row(fmtDateTime(o.billed_at || o.created_at), esc(ORDER_TYPE[o.type]))}
    ${o.table_name ? row(`Table: <b>${esc(o.table_name)}</b>`, o.captain_name ? esc(o.captain_name) : '') : ''}
    ${o.customer_name || o.customer_phone ? row(esc(o.customer_name || ''), esc(o.customer_phone || '')) : ''}</table>
    ${o.type === 'delivery' && o.address ? `<div>${esc(o.address)}</div>` : ''}<hr>
    <table><tr><td><b>Item</b></td><td class="r"><b>Qty</b></td><td class="r"><b>Amt</b></td></tr>
    ${lines.map((l) => `<tr><td>${esc(l.name)}${l.note ? `<br><i>${esc(l.note)}</i>` : ''}</td><td class="r">${l.qty}</td><td class="r">${(l.qty * l.price).toFixed(2)}</td></tr>`).join('')}
    </table><hr><table>
    ${row('Subtotal', o.subtotal.toFixed(2))}
    ${o.discount ? row('Discount', `-${o.discount.toFixed(2)}`) : ''}
    ${o.service_charge ? row(`Service charge (${s.service_charge_percent}%)`, o.service_charge.toFixed(2)) : ''}
    ${o.tax ? row(`CGST ${(s.gst_percent / 2)}%`, (o.tax / 2).toFixed(2)) + row(`SGST ${(s.gst_percent / 2)}%`, (o.tax / 2).toFixed(2)) : ''}
    ${o.delivery_fee ? row('Delivery fee', o.delivery_fee.toFixed(2)) : ''}
    ${o.round_off ? row('Round off', o.round_off.toFixed(2)) : ''}
    ${row('TOTAL', `₹${o.total.toFixed(2)}`, 'tot')}
    ${o.payments?.length ? o.payments.map((p) => row(`Paid (${esc(METHOD[p.method] || p.method)})`, p.amount.toFixed(2))).join('') : ''}
    ${o.paid > 0 && o.paid < o.total ? row('Balance', (o.total - o.paid).toFixed(2)) : ''}
    </table><hr><div class="c">${esc(s.bill_footer || 'Thank you!')}</div>
    ${s.gst_enabled ? '' : '<div class="c" style="font-size:10px;margin-top:4px">Prices are inclusive. No GST charged.</div>'}</div>`;
}

export function kotHtml(k, header = {}) {
  return `<div class="receipt"><div class="c"><h3>KOT #${k.kot_no}</h3><div>${esc(k.station)}</div></div><hr>
    <div><b>${header.table_name ? `Table ${esc(header.table_name)}` : esc(ORDER_TYPE[header.type] || '')}</b> · Order #${header.order_no ?? ''}</div>
    <div>${fmtDateTime(k.created_at)}${k.created_by_name ? ` · ${esc(k.created_by_name)}` : ''}</div><hr>
    ${k.items.map((i) => `<div style="font-size:14px"><b>${i.qty} ×</b> ${esc(i.name)}${i.seat ? ` [${esc(i.seat)}]` : ''}${i.note ? `<br>&nbsp;&nbsp;» ${esc(i.note)}` : ''}</div>`).join('')}
    <hr></div>`;
}

export function billText(o) {
  const r = session.me.restaurant;
  const lines = groupLines(liveItems(o)).map((l) => `${l.qty} x ${l.name} — ₹${(l.qty * l.price).toFixed(2)}`);
  return [`*${r.name}*`, `Bill ${o.bill_no || ''} · ${fmtDateTime(o.billed_at || o.created_at)}`, o.table_name ? `Table ${o.table_name}` : ORDER_TYPE[o.type], '',
    ...lines, '', `Subtotal: ₹${o.subtotal.toFixed(2)}`, o.discount ? `Discount: -₹${o.discount.toFixed(2)}` : '',
    o.tax ? `GST: ₹${o.tax.toFixed(2)}` : '', o.service_charge ? `Service charge: ₹${o.service_charge.toFixed(2)}` : '',
    o.delivery_fee ? `Delivery: ₹${o.delivery_fee.toFixed(2)}` : '', `*Total: ₹${o.total.toFixed(2)}*`, '', r.settings.bill_footer || 'Thank you!']
    .filter((x) => x !== '').join('\n');
}

export const printBill = (o) => printHtml(receiptHtml(o));
export const copyBill = (o) => copyText(billText(o));

// ---------------------------------------------------------------------------
// Bill & Pay dialog
// ---------------------------------------------------------------------------
export function openBillDialog(order, { onDone, startWithPay = false } = {}) {
  let o = order;
  const me = session.me;
  const online = (me.plan?.features || []).includes('online_payments');
  const methods = ['cash', 'upi', 'card'];
  let rows = [{ method: 'cash', amount: o.balance ?? o.total - o.paid }];
  let mode = startWithPay ? 'pay' : 'bill';

  const m = modal({ title: `Bill — ${o.table_name ? `Table ${o.table_name}` : `${ORDER_TYPE[o.type]} #${o.order_no}`}`, size: 'wide', body: '', foot: '' });
  const body = m.el.querySelector('.modal-body');

  const summary = () => `
    <div class="col" style="gap:4px">
      ${groupLines(liveItems(o)).map((l) => `<div class="sum-row"><span>${l.qty} × ${esc(l.name)}</span><span class="money">${money(l.qty * l.price)}</span></div>`).join('')}
      <div style="border-top:1px dashed var(--border-strong);margin:8px 0"></div>
      <div class="sum-row"><span>Subtotal</span><span class="money">${money(o.subtotal)}</span></div>
      ${o.discount ? `<div class="sum-row"><span>Discount</span><span class="money">−${money(o.discount)}</span></div>` : ''}
      ${o.service_charge ? `<div class="sum-row"><span>Service charge</span><span class="money">${money(o.service_charge)}</span></div>` : ''}
      ${o.tax ? `<div class="sum-row"><span>GST</span><span class="money">${money(o.tax)}</span></div>` : ''}
      ${o.delivery_fee ? `<div class="sum-row"><span>Delivery fee</span><span class="money">${money(o.delivery_fee)}</span></div>` : ''}
      ${o.round_off ? `<div class="sum-row"><span>Round off</span><span class="money">${money(o.round_off)}</span></div>` : ''}
      <div class="sum-row total"><span>Total</span><span class="money">${money(o.total)}</span></div>
      ${o.paid ? `<div class="sum-row"><span>Paid</span><span class="money">${money(o.paid)}</span></div><div class="sum-row bold"><span>Balance due</span><span class="money">${money(o.total - o.paid)}</span></div>` : ''}
    </div>`;

  const draw = () => {
    const due = Math.round((o.total - o.paid) * 100) / 100;
    const totalEntered = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const cashRow = rows.find((r) => r.method === 'cash');
    body.innerHTML = `<div class="grid g2" style="gap:22px;align-items:start">
      <div class="card pad" style="background:var(--surface-2)">${summary()}
        <div class="row" style="margin-top:14px;gap:8px">
          <button class="btn sm" data-a="print">${icon('printer', 15)} ${o.bill_no ? 'Reprint' : 'Print bill'}</button>
          <button class="btn sm" data-a="copy">${icon('copy', 15)} Copy</button>
          ${o.bill_no ? `<span class="badge info" style="margin-left:auto">${esc(o.bill_no)}</span>` : ''}
        </div></div>
      <div class="col" style="gap:14px">
        <div class="seg"><button data-mode="bill" class="${mode === 'bill' ? 'active' : ''}">${icon('percent', 15)} Discount</button><button data-mode="pay" class="${mode === 'pay' ? 'active' : ''}">${icon('wallet', 15)} Payment</button></div>
        ${mode === 'bill' ? `
          ${can('discounts') ? `<div class="field"><label>Discount</label><div class="row">
            <input class="input" type="number" min="0" step="0.01" id="disc-v" value="${o.discount_value || ''}" placeholder="0">
            <select class="select" id="disc-t" style="width:130px"><option value="amount" ${o.discount_type !== 'percent' ? 'selected' : ''}>₹ amount</option><option value="percent" ${o.discount_type === 'percent' ? 'selected' : ''}>% percent</option></select>
          </div></div>` : '<div class="notice">' + icon('info') + '<div>You are not allowed to give discounts.</div></div>'}
          <button class="btn primary lg" data-a="bill">${icon('printer')} ${o.bill_no ? 'Update & reprint bill' : 'Print bill'}</button>
          <button class="btn lg" data-mode="pay">Take payment ${icon('chevron_right')}</button>`
    : `
          <div class="col" style="gap:10px">${rows.map((r, i) => `
            <div class="card" style="padding:12px">
              <div class="row" style="gap:6px;flex-wrap:wrap">${methods.map((mt) => `<button class="chip ${r.method === mt ? 'active' : ''}" data-method="${mt}" data-i="${i}">${icon(mt === 'cash' ? 'banknote' : mt === 'upi' ? 'smartphone' : 'card', 15)} ${METHOD[mt]}</button>`).join('')}
                ${rows.length > 1 ? `<button class="btn ghost icon sm" data-rm="${i}" style="margin-left:auto">${icon('x', 15)}</button>` : ''}</div>
              <div class="row" style="margin-top:10px"><div class="field" style="flex:1"><label>Amount</label><input class="input" type="number" min="0" step="0.01" data-amt="${i}" value="${r.amount}"></div>
              ${r.method !== 'cash' ? `<div class="field" style="flex:1"><label>Reference (optional)</label><input class="input" data-ref="${i}" value="${esc(r.reference || '')}" placeholder="UPI / card ref"></div>` : ''}</div>
            </div>`).join('')}</div>
          ${rows.length < 3 ? `<button class="btn ghost sm" data-a="split" style="align-self:flex-start">${icon('split', 15)} Split across another method</button>` : ''}
          ${cashRow ? `<div class="field"><label>Cash given by guest</label><input class="input" type="number" min="0" step="1" id="tendered" placeholder="${cashRow.amount}">
            <div class="hint" id="change"></div></div>` : ''}
          <div class="sum-row bold"><span>Entered</span><span class="money" style="color:${Math.abs(totalEntered - due) < 0.01 ? 'var(--success)' : 'var(--danger)'}">${money(totalEntered)} / ${money(due)}</span></div>
          <button class="btn primary lg" data-a="pay" ${totalEntered <= 0 ? 'disabled' : ''}>${icon('check_circle')} Confirm payment</button>
          ${online ? `<button class="btn soft lg" data-a="online">${icon('card')} Collect ${money(due)} online (Razorpay)</button>` : ''}`}
      </div></div>`;
    const tendered = body.querySelector('#tendered');
    tendered?.addEventListener('input', () => {
      const change = Number(tendered.value) - Number(cashRow.amount);
      body.querySelector('#change').innerHTML = tendered.value ? (change >= 0 ? `Change to return: <b style="color:var(--success)">${money(change)}</b>` : `Short by <b style="color:var(--danger)">${money(-change)}</b>`) : '';
    });
  };

  const refresh = async () => { o = await api(`/api/orders/${o.id}`); };
  on(body, 'click', '[data-mode]', (e, b) => { mode = b.dataset.mode; if (mode === 'pay') rows = [{ method: 'cash', amount: Math.round((o.total - o.paid) * 100) / 100 }]; draw(); });
  on(body, 'click', '[data-method]', (e, b) => { rows[b.dataset.i].method = b.dataset.method; draw(); });
  on(body, 'click', '[data-rm]', (e, b) => { rows.splice(Number(b.dataset.rm), 1); draw(); });
  on(body, 'input', '[data-amt]', (e, inp) => { rows[inp.dataset.amt].amount = inp.value; });
  on(body, 'change', '[data-amt]', () => draw());
  on(body, 'input', '[data-ref]', (e, inp) => { rows[inp.dataset.ref].reference = inp.value; });
  on(body, 'click', '[data-a]', async (e, b) => {
    const a = b.dataset.a;
    try {
      if (a === 'print') { if (!o.bill_no) { o = await api(`/api/orders/${o.id}/bill`, { method: 'POST', body: {} }); onDone?.(o, false); } printBill(o); draw(); }
      if (a === 'copy') copyBill(o);
      if (a === 'bill') {
        await busy(b, async () => {
          const payload = {};
          const dv = body.querySelector('#disc-v');
          if (dv) { payload.discount_value = Number(dv.value) || 0; payload.discount_type = body.querySelector('#disc-t').value; }
          o = await api(`/api/orders/${o.id}/bill`, { method: 'POST', body: payload });
        });
        printBill(o);
        toast(`Bill ${o.bill_no} printed`);
        onDone?.(o, false);
        draw();
      }
      if (a === 'split') {
        const due = Math.round((o.total - o.paid) * 100) / 100;
        const used = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const next = methods.find((mt) => !rows.some((r) => r.method === mt)) || 'upi';
        rows.push({ method: next, amount: Math.max(0, Math.round((due - used) * 100) / 100) });
        draw();
      }
      if (a === 'pay') {
        await busy(b, async () => {
          o = await api(`/api/orders/${o.id}/pay`, { method: 'POST', body: { payments: rows.map((r) => ({ ...r, amount: Number(r.amount) })) } });
        });
        if (o.status === 'paid') {
          toast(`Paid ${money(o.total)} — ${o.table_name ? `table ${o.table_name} is free now` : 'order closed'}`);
          m.close();
          onDone?.(o, true);
        } else { toast(`Received. Balance ${money(o.total - o.paid)}`, 'info'); rows = [{ method: 'upi', amount: Math.round((o.total - o.paid) * 100) / 100 }]; draw(); onDone?.(o, false); }
      }
      if (a === 'online') {
        const checkout = await busy(b, () => api(`/api/orders/${o.id}/razorpay`, { method: 'POST', body: {} }));
        const resp = await razorpayPay({ ...checkout, description: `Bill ${o.bill_no || ''}` });
        o = await api(`/api/orders/${o.id}/razorpay/verify`, { method: 'POST', body: resp });
        if (o.status === 'paid') { toast('Online payment received'); m.close(); onDone?.(o, true); } else { await refresh(); draw(); }
      }
    } catch (err) { toastError(err); }
  });
  draw();
  return m;
}

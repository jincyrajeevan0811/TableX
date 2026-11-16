import { api } from '../api.js';
import { qrSvg } from '../qr.js';
import {
  badge, confirmDialog, empty, esc, formModal, icon, modal, on, printHtml, toast, toastError,
} from '../ui.js';

export default async function tablesPage(ctx) {
  let tables = [];
  ctx.setTitle(`${icon('grid', 20)}<span>Tables & QR</span>`);

  const load = async () => { tables = await api('/api/tables'); draw(); };
  const areas = () => [...new Set(tables.map((t) => t.area))];

  const draw = () => {
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Tables & rooms</h1><div class="sub">${tables.length} tables across ${areas().length || 0} areas. Each table has its own QR code for guest ordering.</div></div>
        <button class="btn" data-a="qr">${icon('qr')} Print QR codes</button>
        <button class="btn" data-a="bulk">${icon('layers')} Add many</button>
        <button class="btn primary" data-a="add">${icon('plus')} Add table</button></div>
      <div class="card"><div class="table-wrap">${tables.length ? `<table class="tbl"><thead><tr><th>Table</th><th>Area</th><th>Seats</th><th>Status</th><th></th></tr></thead><tbody>
        ${tables.map((t) => `<tr><td class="bold">${esc(t.name)}</td><td>${esc(t.area)}</td><td>${t.seats}</td><td>${badge(t.status)}</td>
          <td class="r" style="white-space:nowrap"><button class="btn ghost sm" data-qr1="${t.id}">${icon('qr', 15)} QR</button>
          <button class="btn ghost icon sm" data-edit="${t.id}">${icon('pencil', 15)}</button>
          <button class="btn ghost icon sm danger-ghost" data-del="${t.id}">${icon('trash', 15)}</button></td></tr>`).join('')}
      </tbody></table>` : empty('grid', 'No tables yet', 'Add your tables — e.g. T1 to T12 in "Main Hall".')}</div></div>`;
  };

  const fields = (t = {}) => [
    { name: 'name', label: 'Table name', value: t.name, required: true, placeholder: 'T1' },
    { name: 'seats', label: 'Seats', type: 'number', value: t.seats ?? 4, min: 1, max: 50 },
    { name: 'area', label: 'Area / room', value: t.area ?? (areas()[0] || 'Main Hall'), full: true, placeholder: 'Main Hall, Rooftop, AC Room…' },
  ];

  const qrCard = (t, restaurant) => `<div class="qr-card"><div class="qrr">${esc(restaurant)}</div>${qrSvg(t.url, { size: 180 })}
    <div class="qrn">${esc(t.name)}</div><div class="qrs">Scan to see the menu & order</div></div>`;

  const showQr = async (onlyId) => {
    const data = await api('/api/tables/qr');
    const list = onlyId ? data.tables.filter((t) => String(t.id) === String(onlyId)) : data.tables;
    const m = modal({
      title: onlyId ? `QR code — ${list[0]?.name}` : 'Table QR codes', size: onlyId ? 'narrow' : 'xwide',
      body: `<div class="notice" style="margin-bottom:16px">${icon('info')}<div>Print and keep one on each table. Guests scan with their phone camera, see the menu and order — the order appears in <b>QR Orders</b> for you to accept.</div></div>
        <div class="qr-preview">${list.map((t) => qrCard(t, data.restaurant)).join('')}</div>
        ${onlyId ? `<div class="small muted" style="margin-top:12px;word-break:break-all">${esc(list[0]?.url)}</div>` : ''}`,
      foot: `${onlyId ? `<button class="btn" data-x="regen">${icon('rotate')} New code</button><a class="btn" href="${esc(list[0]?.url)}" target="_blank" rel="noopener">${icon('external')} Open</a>` : ''}<button class="btn solid" data-x="print">${icon('printer')} Print</button>`,
    });
    on(m.el, 'click', '[data-x]', async (e, b) => {
      if (b.dataset.x === 'print') printHtml(`<div class="qr-sheet">${list.map((t) => qrCard(t, data.restaurant)).join('')}</div>`);
      if (b.dataset.x === 'regen') {
        if (!await confirmDialog({ title: 'Create a new QR code?', message: 'The old printed code for this table will stop working.', confirmText: 'Create new code' })) return;
        await api(`/api/tables/${onlyId}/regenerate-qr`, { method: 'POST' });
        m.close(); showQr(onlyId);
      }
    });
  };

  on(ctx.el, 'click', '[data-a]', async (e, b) => {
    const a = b.dataset.a;
    try {
      if (a === 'add') { await formModal({ title: 'Add table', fields: fields(), submitText: 'Add', onSubmit: (v) => api('/api/tables', { method: 'POST', body: v }) }); load(); }
      if (a === 'bulk') {
        await formModal({
          title: 'Add many tables', submitText: 'Add tables',
          fields: [{ name: 'count', label: 'How many', type: 'number', value: 10, min: 1, max: 100, required: true }, { name: 'prefix', label: 'Name prefix', value: 'T' },
            { name: 'seats', label: 'Seats each', type: 'number', value: 4, min: 1 }, { name: 'area', label: 'Area', value: areas()[0] || 'Main Hall' }],
          onSubmit: async (v) => { const r = await api('/api/tables', { method: 'POST', body: v }); toast(`${r.created.length} tables added`); },
        });
        load();
      }
      if (a === 'qr') await showQr();
    } catch (err) { toastError(err); }
  });
  on(ctx.el, 'click', '[data-qr1]', (e, b) => showQr(b.dataset.qr1).catch(toastError));
  on(ctx.el, 'click', '[data-edit]', async (e, b) => {
    const t = tables.find((x) => String(x.id) === b.dataset.edit);
    await formModal({ title: `Edit ${t.name}`, fields: fields(t), onSubmit: (v) => api(`/api/tables/${t.id}`, { method: 'PUT', body: v }) });
    load();
  });
  on(ctx.el, 'click', '[data-del]', async (e, b) => {
    const t = tables.find((x) => String(x.id) === b.dataset.del);
    if (!await confirmDialog({ title: `Delete table ${t.name}?`, message: 'Its QR code will stop working. Old bills are kept.', confirmText: 'Delete', danger: true })) return;
    try { await api(`/api/tables/${t.id}`, { method: 'DELETE' }); load(); } catch (err) { toastError(err); }
  });

  await load();
}

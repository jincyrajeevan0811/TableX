import { api } from '../api.js';
import {
  cap, confirmDialog, empty, esc, fmtDateTime, formModal, icon, money, on, toast, toastError,
} from '../ui.js';

export default async function inventory(ctx) {
  let data = { items: [], moves: [] };
  let tab = 'stock';
  ctx.setTitle(`${icon('package', 20)}<span>Stock & Purchases</span>`);

  const load = async () => { data = await api('/api/inventory'); draw(); };

  const draw = () => {
    const low = data.items.filter((i) => i.qty <= i.reorder_level);
    const value = data.items.reduce((s, i) => s + i.qty * i.cost, 0);
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Stock & purchases</h1><div class="sub">Track raw materials, record purchases and usage.</div></div>
        <button class="btn" data-a="move">${icon('refresh')} Record stock movement</button>
        <button class="btn primary" data-a="add">${icon('plus')} Add stock item</button></div>
      <div class="grid g3" style="margin-bottom:16px">
        <div class="card kpi"><div class="kpi-label">Stock items</div><div class="kpi-value">${data.items.length}</div></div>
        <div class="card kpi"><div class="kpi-label">Low stock</div><div class="kpi-value" style="color:${low.length ? 'var(--danger)' : 'inherit'}">${low.length}</div><div class="small muted">${low.map((i) => esc(i.name)).slice(0, 3).join(', ')}</div></div>
        <div class="card kpi"><div class="kpi-label">Stock value</div><div class="kpi-value money">${money(value)}</div></div>
      </div>
      <div class="tabs"><button data-tab="stock" class="${tab === 'stock' ? 'active' : ''}">Stock</button><button data-tab="moves" class="${tab === 'moves' ? 'active' : ''}">History</button></div>
      <div class="card"><div class="table-wrap">${tab === 'stock' ? (data.items.length ? `<table class="tbl"><thead><tr><th>Item</th><th class="r">In stock</th><th class="r">Reorder at</th><th class="r">Unit cost</th><th></th></tr></thead><tbody>
        ${data.items.map((i) => `<tr><td class="bold">${esc(i.name)} ${i.qty <= i.reorder_level ? '<span class="badge danger">Low</span>' : ''}</td>
          <td class="r bold">${i.qty} ${esc(i.unit)}</td><td class="r muted">${i.reorder_level} ${esc(i.unit)}</td><td class="r money">${money(i.cost)}</td>
          <td class="r" style="white-space:nowrap"><button class="btn sm soft" data-buy="${i.id}">${icon('plus', 14)} Purchase</button>
          <button class="btn ghost icon sm" data-use="${i.id}" title="Use / wastage">${icon('minus', 15)}</button>
          <button class="btn ghost icon sm" data-edit="${i.id}">${icon('pencil', 15)}</button>
          <button class="btn ghost icon sm danger-ghost" data-del="${i.id}">${icon('trash', 15)}</button></td></tr>`).join('')}</tbody></table>`
    : empty('package', 'No stock items yet', 'Add rice, chicken, oil… and record purchases as they come in.'))
    : (data.moves.length ? `<table class="tbl"><thead><tr><th>When</th><th>Item</th><th>Type</th><th class="r">Qty</th><th class="r">Cost</th><th>Supplier / note</th><th>By</th></tr></thead><tbody>
        ${data.moves.map((m) => `<tr><td class="small">${fmtDateTime(m.created_at)}</td><td class="bold">${esc(m.item_name)}</td><td><span class="badge ${m.type === 'purchase' ? 'success' : m.type === 'adjust' ? 'info' : 'warning'}">${cap(m.type)}</span></td>
          <td class="r">${m.type === 'purchase' ? '+' : m.type === 'adjust' ? '=' : '−'}${m.qty} ${esc(m.unit)}</td><td class="r money">${m.cost ? money(m.cost) : ''}</td><td class="small">${esc([m.supplier, m.note].filter(Boolean).join(' · '))}</td><td class="small muted">${esc(m.by_name || '')}</td></tr>`).join('')}</tbody></table>`
      : empty('refresh', 'No movements yet'))}</div></div>`;
  };

  const moveForm = async (itemId, type = 'purchase') => {
    await formModal({
      title: 'Stock movement', submitText: 'Save',
      fields: [
        { name: 'item_id', label: 'Item', type: 'select', value: itemId, options: data.items.map((i) => [i.id, `${i.name} (${i.qty} ${i.unit})`]), full: true },
        { name: 'type', label: 'Type', type: 'select', value: type, options: [['purchase', 'Purchase (stock in)'], ['usage', 'Used in kitchen'], ['wastage', 'Wastage'], ['adjust', 'Set exact count']] },
        { name: 'qty', label: 'Quantity', type: 'number', min: 0, step: 'any', required: true },
        { name: 'cost', label: 'Total cost (₹, purchases)', type: 'number', min: 0, step: '0.01' },
        { name: 'supplier', label: 'Supplier' },
        { name: 'note', label: 'Note', full: true },
      ],
      onSubmit: async (v) => { await api('/api/inventory/moves', { method: 'POST', body: { ...v, item_id: Number(v.item_id) } }); toast('Stock updated'); },
    });
    load();
  };

  const itemFields = (i = {}) => [
    { name: 'name', label: 'Item name', value: i.name, required: true, full: true },
    { name: 'unit', label: 'Unit', value: i.unit || 'kg', placeholder: 'kg, L, pcs' },
    ...(i.id ? [] : [{ name: 'qty', label: 'Opening stock', type: 'number', value: 0, min: 0, step: 'any' }]),
    { name: 'reorder_level', label: 'Reorder level', type: 'number', value: i.reorder_level ?? 0, min: 0, step: 'any' },
    { name: 'cost', label: 'Unit cost (₹)', type: 'number', value: i.cost ?? 0, min: 0, step: '0.01' },
  ];

  on(ctx.el, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; draw(); });
  on(ctx.el, 'click', '[data-a]', async (e, b) => {
    if (b.dataset.a === 'add') { await formModal({ title: 'Add stock item', fields: itemFields(), onSubmit: (v) => api('/api/inventory/items', { method: 'POST', body: v }) }); load(); }
    if (b.dataset.a === 'move') { if (!data.items.length) return toast('Add a stock item first', 'info'); moveForm(data.items[0].id); }
  });
  on(ctx.el, 'click', '[data-buy]', (e, b) => moveForm(Number(b.dataset.buy), 'purchase'));
  on(ctx.el, 'click', '[data-use]', (e, b) => moveForm(Number(b.dataset.use), 'usage'));
  on(ctx.el, 'click', '[data-edit]', async (e, b) => {
    const i = data.items.find((x) => String(x.id) === b.dataset.edit);
    await formModal({ title: `Edit ${i.name}`, fields: itemFields(i), onSubmit: (v) => api(`/api/inventory/items/${i.id}`, { method: 'PUT', body: v }) });
    load();
  });
  on(ctx.el, 'click', '[data-del]', async (e, b) => {
    const i = data.items.find((x) => String(x.id) === b.dataset.del);
    if (!await confirmDialog({ title: `Delete ${i.name}?`, message: 'Its history is deleted too.', confirmText: 'Delete', danger: true })) return;
    try { await api(`/api/inventory/items/${i.id}`, { method: 'DELETE' }); load(); } catch (err) { toastError(err); }
  });

  await load();
}

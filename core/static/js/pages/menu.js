import { api, cache } from '../api.js';
import {
  busy, confirmDialog, debounce, empty, esc, formModal, icon, money, on, toast, toastError, vegDot,
} from '../ui.js';

export default async function menuPage(ctx) {
  let data = { categories: [], items: [], stations: [] };
  let tab = 'items';
  let q = '';
  let cat = '';
  const selected = new Set();
  ctx.setTitle(`${icon('menu_book', 20)}<span>Menu</span>`);

  const load = async () => { data = await api('/api/menu'); cache.set('menu', data); draw(); };

  const itemFields = (it = {}) => [
    { name: 'name', label: 'Item name', value: it.name, required: true, full: true },
    { name: 'category_id', label: 'Category', type: 'select', value: it.category_id ?? '', options: [['', '— None —'], ...data.categories.map((c) => [c.id, c.name])] },
    { name: 'price', label: 'Price (₹)', type: 'number', value: it.price, min: 0, step: '0.01', required: true },
    { name: 'veg', label: 'Type', type: 'select', value: it.veg === 0 ? 'non_veg' : 'veg', options: [['veg', 'Veg'], ['non_veg', 'Non-veg']] },
    { name: 'station', label: 'Kitchen station', type: 'select', value: it.station, options: data.stations },
    { name: 'description', label: 'Description (shown on the QR menu)', type: 'textarea', value: it.description, full: true },
    { name: 'available', label: 'Available', type: 'switch', value: it.available !== 0, full: true },
  ];

  const draw = () => {
    const items = data.items.filter((i) => (!q || i.name.toLowerCase().includes(q.toLowerCase())) && (!cat || String(i.category_id) === cat));
    const catName = (id) => data.categories.find((c) => c.id === id)?.name || '—';
    ctx.el.innerHTML = `
      <div class="page-head"><div class="grow"><h1>Menu & prices</h1><div class="sub">${data.items.length} items in ${data.categories.length} categories. Price changes apply from the next order.</div></div>
        <button class="btn" data-a="import">${icon('upload')} Import CSV</button>
        <button class="btn primary" data-a="${tab === 'items' ? 'add' : 'addcat'}">${icon('plus')} ${tab === 'items' ? 'Add item' : 'Add category'}</button></div>
      <div class="tabs"><button data-tab="items" class="${tab === 'items' ? 'active' : ''}">Items</button><button data-tab="cats" class="${tab === 'cats' ? 'active' : ''}">Categories</button></div>
      ${tab === 'items' ? `
      <div class="card">
        <div class="card-head" style="flex-wrap:wrap">
          <div class="input-icon" style="flex:1;min-width:200px">${icon('search', 16)}<input class="input sm" id="mq" placeholder="Search items…" value="${esc(q)}"></div>
          <select class="select sm" id="mcat" style="width:auto"><option value="">All categories</option>${data.categories.map((c) => `<option value="${c.id}" ${String(c.id) === cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          ${selected.size ? `<button class="btn sm danger" data-a="bulkdel">${icon('trash', 15)} Delete selected (${selected.size})</button>` : ''}
        </div>
        <div class="table-wrap">${items.length ? `<table class="tbl"><thead><tr>
          <th style="width:36px"><input type="checkbox" class="check" id="selall" ${items.length && items.every((i) => selected.has(i.id)) ? 'checked' : ''}></th>
          <th>Item</th><th>Category</th><th>Station</th><th class="r">Price</th><th>Available</th><th></th></tr></thead><tbody>
          ${items.map((i) => `<tr>
            <td><input type="checkbox" data-sel="${i.id}" ${selected.has(i.id) ? 'checked' : ''}></td>
            <td><div class="row" style="gap:8px">${vegDot(i.veg)}<span class="bold">${esc(i.name)}</span></div>${i.description ? `<div class="tiny muted">${esc(i.description)}</div>` : ''}</td>
            <td>${esc(catName(i.category_id))}</td><td class="small muted">${esc(i.station)}</td>
            <td class="r money bold">${money(i.price)}</td>
            <td><label class="switch"><input type="checkbox" data-av="${i.id}" ${i.available ? 'checked' : ''}><span></span></label></td>
            <td class="r" style="white-space:nowrap"><button class="btn ghost icon sm" data-edit="${i.id}" title="Edit">${icon('pencil', 15)}</button><button class="btn ghost icon sm danger-ghost" data-del="${i.id}" title="Delete">${icon('trash', 15)}</button></td>
          </tr>`).join('')}</tbody></table>` : empty('menu_book', data.items.length ? 'No items match' : 'Your menu is empty', data.items.length ? '' : 'Add items one by one or import a CSV.')}</div>
      </div>` : `
      <div class="card"><div class="table-wrap">${data.categories.length ? `<table class="tbl"><thead><tr><th>Category</th><th class="r">Items</th><th class="r">Order</th><th></th></tr></thead><tbody>
        ${data.categories.map((c) => `<tr><td class="bold">${esc(c.name)}</td><td class="r">${c.item_count}</td><td class="r">${c.sort}</td>
          <td class="r"><button class="btn ghost icon sm" data-ecat="${c.id}">${icon('pencil', 15)}</button><button class="btn ghost icon sm danger-ghost" data-dcat="${c.id}">${icon('trash', 15)}</button></td></tr>`).join('')}
        </tbody></table>` : empty('layers', 'No categories yet', 'Add sections like "Biriyani" or "Hot Drinks".')}</div></div>`}`;
    const mq = ctx.el.querySelector('#mq');
    mq?.addEventListener('input', debounce(() => { q = mq.value; draw(); const n = ctx.el.querySelector('#mq'); n.focus(); n.setSelectionRange(q.length, q.length); }, 200));
    ctx.el.querySelector('#mcat')?.addEventListener('change', (e) => { cat = e.target.value; draw(); });
    ctx.el.querySelector('#selall')?.addEventListener('change', (e) => { items.forEach((i) => (e.target.checked ? selected.add(i.id) : selected.delete(i.id))); draw(); });
  };

  on(ctx.el, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; draw(); });
  on(ctx.el, 'change', '[data-sel]', (e, c) => { const id = Number(c.dataset.sel); if (c.checked) selected.add(id); else selected.delete(id); draw(); });
  on(ctx.el, 'change', '[data-av]', async (e, c) => {
    try { await api(`/api/menu/items/${c.dataset.av}/availability`, { method: 'POST', body: { available: c.checked } }); data.items.find((i) => String(i.id) === c.dataset.av).available = c.checked ? 1 : 0; toast(c.checked ? 'Back on the menu' : 'Hidden until you switch it on again'); } catch (err) { c.checked = !c.checked; toastError(err); }
  });
  on(ctx.el, 'click', '[data-edit]', async (e, b) => {
    const it = data.items.find((i) => String(i.id) === b.dataset.edit);
    await formModal({ title: 'Edit item', fields: itemFields(it), onSubmit: async (v) => { await api(`/api/menu/items/${it.id}`, { method: 'PUT', body: { ...v, category_id: v.category_id || null } }); toast('Saved'); } });
    load();
  });
  on(ctx.el, 'click', '[data-del]', async (e, b) => {
    const it = data.items.find((i) => String(i.id) === b.dataset.del);
    if (!await confirmDialog({ title: `Delete ${it.name}?`, message: 'This cannot be undone. Old bills keep the item name. If it is only out of stock, switch off "Available" instead.', confirmText: 'Delete', danger: true })) return;
    try { await api(`/api/menu/items/${it.id}`, { method: 'DELETE' }); selected.delete(it.id); toast('Item deleted'); load(); } catch (err) { toastError(err); }
  });
  on(ctx.el, 'click', '[data-ecat]', async (e, b) => {
    const c = data.categories.find((x) => String(x.id) === b.dataset.ecat);
    await formModal({ title: 'Edit category', fields: [{ name: 'name', label: 'Name', value: c.name, required: true }, { name: 'sort', label: 'Display order', type: 'number', value: c.sort, min: 0 }],
      onSubmit: async (v) => { await api(`/api/menu/categories/${c.id}`, { method: 'PUT', body: v }); } });
    load();
  });
  on(ctx.el, 'click', '[data-dcat]', async (e, b) => {
    const c = data.categories.find((x) => String(x.id) === b.dataset.dcat);
    if (!await confirmDialog({ title: `Delete ${c.name}?`, message: 'Items in this category are kept and become uncategorised.', confirmText: 'Delete', danger: true })) return;
    try { await api(`/api/menu/categories/${c.id}`, { method: 'DELETE' }); load(); } catch (err) { toastError(err); }
  });
  on(ctx.el, 'click', '[data-a]', async (e, b) => {
    const a = b.dataset.a;
    if (a === 'add') { await formModal({ title: 'Add item', fields: itemFields({ station: data.stations[0] }), submitText: 'Add item', onSubmit: async (v) => { await api('/api/menu/items', { method: 'POST', body: { ...v, category_id: v.category_id || null } }); toast(`${v.name} added`); } }); load(); }
    if (a === 'addcat') { await formModal({ title: 'Add category', fields: [{ name: 'name', label: 'Category name', required: true, placeholder: 'e.g. Beef Specials', full: true }], submitText: 'Add', onSubmit: (v) => api('/api/menu/categories', { method: 'POST', body: v }) }); load(); }
    if (a === 'bulkdel') {
      if (!await confirmDialog({ title: `Delete ${selected.size} items?`, message: 'This cannot be undone.', confirmText: 'Delete selected', danger: true })) return;
      busy(b, async () => { const r = await api('/api/menu/items/bulk-delete', { method: 'POST', body: { ids: [...selected] } }); selected.clear(); toast(`${r.deleted} items deleted`); load(); });
    }
    if (a === 'import') {
      await formModal({
        title: 'Import items from CSV', size: 'wide', submitText: 'Import',
        intro: `<div class="notice">${icon('info')}<div>Paste one item per line: <b>name, category, price, veg/non_veg</b> (optional 5th column: station). New categories are created automatically.<br><span class="mono small">Chicken 65, Starters, 220, non_veg<br>Masala Chai, Hot Drinks, 30, veg</span></div></div>`,
        fields: [{ name: 'csv', label: 'CSV lines', type: 'textarea', required: true, full: true }],
        onSubmit: async (v) => { const r = await api('/api/menu/import', { method: 'POST', body: v }); toast(`${r.imported} items imported${r.errors.length ? ` · ${r.errors.length} lines skipped` : ''}`); },
      });
      load();
    }
  });

  await load();
}

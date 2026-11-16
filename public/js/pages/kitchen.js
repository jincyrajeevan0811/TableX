import { api } from '../api.js';
import { can } from '../app.js';
import {
  ORDER_TYPE, beep, clock, empty, esc, formModal, icon, minutesSince, modal, on, printHtml, toast, toastError,
} from '../ui.js';
import { kotHtml } from './shared.js';

const NEXT_LABEL = { new: 'Start cooking', preparing: 'Mark ready', ready: 'Picked up', served: '' };

export default async function kitchen(ctx) {
  let data = { kots: [], stations: [] };
  let filter = 'active';
  let station = localStorage.getItem('tx_station') || '';
  let known = null;

  ctx.setTitle(`${icon('kitchen', 20)}<span>Kitchen</span>`);

  const load = async () => {
    try {
      data = await api(`/api/kitchen${station ? `?station=${encodeURIComponent(station)}` : ''}`);
      const ids = new Set(data.kots.filter((k) => k.status === 'new').map((k) => k.id));
      if (known && [...ids].some((id) => !known.has(id))) { beep(3); toast('New kitchen ticket', 'info'); }
      known = ids;
      if (ctx.isCurrent()) draw();
    } catch (e) { if (e.code !== 'OFFLINE') toastError(e); }
  };

  const draw = () => {
    const counts = { new: 0, preparing: 0, ready: 0 };
    data.kots.forEach((k) => { if (counts[k.status] !== undefined) counts[k.status]++; });
    const list = data.kots.filter((k) => (filter === 'active' ? k.status !== 'served' : k.status === filter));
    ctx.el.innerHTML = `
      <div class="row wrap" style="margin-bottom:18px;gap:12px">
        <div class="seg">
          <button data-f="active" class="${filter === 'active' ? 'active' : ''}">All open</button>
          <button data-f="new" class="${filter === 'new' ? 'active' : ''}">New <span class="badge primary">${counts.new}</span></button>
          <button data-f="preparing" class="${filter === 'preparing' ? 'active' : ''}">Preparing <span class="badge warning">${counts.preparing}</span></button>
          <button data-f="ready" class="${filter === 'ready' ? 'active' : ''}">Ready <span class="badge success">${counts.ready}</span></button>
          <button data-f="served" class="${filter === 'served' ? 'active' : ''}">Picked up</button>
        </div>
        <span class="spacer"></span>
        ${data.stations.length > 1 ? `<select class="select sm" id="station" style="width:auto"><option value="">All stations</option>${data.stations.map((s) => `<option ${s === station ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
        ${can('menu') || can('kitchen') ? `<button class="btn sm" data-avail>${icon('menu_book', 15)} Item availability</button>` : ''}
      </div>
      <div class="muted small" style="margin:-8px 0 14px">Tap a ticket to move it along. Long-press (or right-click) to reprint or cancel. Timer turns amber after ${data.amber} min and red after ${data.red} min.</div>
      ${list.length ? `<div class="kds">${list.map(card).join('')}</div>` : `<div class="card">${empty('kitchen', 'All caught up', 'New tickets appear here with a sound.')}</div>`}`;
  };

  const card = (k) => {
    const mins = minutesSince(k.created_at);
    const heat = k.status === 'served' || k.status === 'ready' ? '' : mins >= data.red ? 'red' : mins >= data.amber ? 'amber' : '';
    return `<div class="kot ${k.status} ${heat}" data-kot="${k.id}">
      <div class="kot-head"><div><div class="kt">${k.table_name ? `Table ${esc(k.table_name)}` : `${ORDER_TYPE[k.type]} #${k.order_no}`}</div>
        <div class="tiny muted">KOT #${k.kot_no} · ${esc(k.station)}${k.source === 'qr' ? ' · QR' : ''}</div></div>
        <div class="timer" data-since="${k.created_at}">${icon('timer', 14)} <span>${clock(k.created_at)}</span></div></div>
      <div class="kot-items">${k.items.map((i) => `<div><b>${i.qty}×</b><span>${esc(i.name)}${i.seat ? ` <span class="muted small">[S${esc(i.seat)}]</span>` : ''}${i.note ? `<span class="kn">» ${esc(i.note)}</span>` : ''}</span></div>`).join('')}</div>
      <div class="kot-foot">${esc(k.created_by_name || '')}${k.customer_name ? ` · ${esc(k.customer_name)}` : ''}
        ${NEXT_LABEL[k.status] ? `<span class="kot-next">${NEXT_LABEL[k.status]} ${icon('chevron_right', 14)}</span>` : ''}</div>
    </div>`;
  };

  const advance = async (id) => {
    const k = data.kots.find((x) => String(x.id) === String(id));
    if (!k || k.status === 'served') return;
    try {
      await api(`/api/kitchen/kots/${id}/advance`, { method: 'POST', body: {} });
      load();
    } catch (e) { toastError(e); }
  };

  const menuFor = (id) => {
    const k = data.kots.find((x) => String(x.id) === String(id));
    if (!k) return;
    const m = modal({
      title: `KOT #${k.kot_no}`, size: 'narrow',
      body: `<div class="col"><button class="btn lg" data-x="print">${icon('printer')} Reprint ticket</button>
        ${can('cancel_items') && k.status !== 'served' ? `<button class="btn lg danger-ghost" data-x="cancel">${icon('trash')} Cancel ticket</button>` : ''}</div>`,
    });
    on(m.el, 'click', '[data-x]', async (e, b) => {
      m.close();
      if (b.dataset.x === 'print') printHtml(kotHtml(k, k));
      if (b.dataset.x === 'cancel') {
        await formModal({
          title: 'Cancel ticket', submitText: 'Cancel ticket', danger: true,
          fields: [{ name: 'reason', label: 'Reason', required: true, full: true }],
          onSubmit: async (v) => { await api(`/api/kitchen/kots/${k.id}/cancel`, { method: 'POST', body: v }); toast('Ticket cancelled'); load(); },
        });
      }
    });
  };

  const availability = async () => {
    const menu = await api('/api/menu');
    const m = modal({
      title: 'Item availability', size: 'wide',
      body: `<p class="muted small" style="margin-bottom:12px">Switch off items that are finished for today. They disappear from the POS and the QR menu until switched on again.</p>
        <div class="input-icon" style="margin-bottom:12px">${icon('search', 17)}<input class="input" id="avs" placeholder="Search…"></div>
        <div class="col" id="avlist" style="gap:0"></div>`,
    });
    const drawList = (q = '') => {
      m.el.querySelector('#avlist').innerHTML = menu.items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())).map((i) => `
        <label class="row" style="padding:10px 4px;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(i.name)}</span>
        <span class="switch"><input type="checkbox" data-av="${i.id}" ${i.available ? 'checked' : ''}><span></span></span></label>`).join('');
    };
    drawList();
    m.el.querySelector('#avs').addEventListener('input', (e) => drawList(e.target.value));
    on(m.el, 'change', '[data-av]', async (e, inp) => {
      try {
        await api(`/api/menu/items/${inp.dataset.av}/availability`, { method: 'POST', body: { available: inp.checked } });
        menu.items.find((i) => String(i.id) === inp.dataset.av).available = inp.checked ? 1 : 0;
        toast(inp.checked ? 'Item is available again' : 'Marked as finished for today');
      } catch (err) { inp.checked = !inp.checked; toastError(err); }
    });
  };

  // tap vs long-press
  let timer = null; let long = false;
  ctx.el.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('[data-kot]');
    if (!c) return;
    long = false;
    timer = setTimeout(() => { long = true; menuFor(c.dataset.kot); }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => ctx.el.addEventListener(ev, () => clearTimeout(timer)));
  ctx.el.addEventListener('contextmenu', (e) => { const c = e.target.closest('[data-kot]'); if (c) { e.preventDefault(); menuFor(c.dataset.kot); } });
  on(ctx.el, 'click', '[data-kot]', (e, c) => { if (!long) advance(c.dataset.kot); });
  on(ctx.el, 'click', '[data-f]', (e, b) => { filter = b.dataset.f; draw(); });
  on(ctx.el, 'click', '[data-avail]', () => availability().catch(toastError));
  ctx.el.addEventListener('change', (e) => {
    if (e.target.id === 'station') { station = e.target.value; localStorage.setItem('tx_station', station); load(); }
  });

  await load();
  ctx.every(load, 5000);
  ctx.every(() => {
    ctx.el.querySelectorAll('.timer[data-since]').forEach((t) => {
      t.querySelector('span').textContent = clock(t.dataset.since);
      const mins = minutesSince(t.dataset.since);
      const card = t.closest('.kot');
      if (card.classList.contains('new') || card.classList.contains('preparing')) {
        card.classList.toggle('red', mins >= data.red);
        card.classList.toggle('amber', mins >= data.amber && mins < data.red);
      }
    });
  }, 1000);
}

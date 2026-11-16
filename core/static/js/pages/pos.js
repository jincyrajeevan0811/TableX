import { api, cache, newKey, sendKot } from '../api.js';
import { can } from '../app.js';
import {
  $, ORDER_TYPE, badge, busy, confirmDialog, empty, esc, formModal, icon, minutesSince, modal, money, on, timeAgo, toast,
  toastError, vegDot,
} from '../ui.js';
import { openBillDialog } from './shared.js';

const STATUS_LABEL = { free: 'Free', occupied: 'Occupied', billed: 'Billed', reserved: 'Reserved', cleaning: 'Cleaning' };

export default async function pos(ctx) {
  if (ctx.view === 'table' || ctx.view === 'order' || ctx.view === 'new') return orderScreen(ctx);
  return floor(ctx);
}

// ---------------------------------------------------------------------------
// Floor: tables, takeaway & delivery
// ---------------------------------------------------------------------------
async function floor(ctx) {
  const me = ctx.me;
  const hasDelivery = (me.plan?.features || []).includes('delivery') && me.restaurant.settings.delivery_enabled;
  let area = 'all';
  let tables = cache.get('tables') || [];
  let running = [];
  ctx.setTitle(`${icon('pos', 20)}<span>POS & Tables</span>`);

  const load = async () => {
    try {
      [tables, running] = await Promise.all([api('/api/tables'), api('/api/orders')]);
      cache.set('tables', tables);
    } catch (e) { if (e.code !== 'OFFLINE') toastError(e); }
    if (ctx.isCurrent()) draw();
  };

  const draw = () => {
    const areas = [...new Set(tables.map((t) => t.area))];
    const counts = tables.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {});
    const shown = tables.filter((t) => area === 'all' || t.area === area);
    const offTable = running.filter((o) => o.type !== 'dine_in');
    const byArea = {};
    shown.forEach((t) => { (byArea[t.area] ||= []).push(t); });
    ctx.el.innerHTML = `
      <div class="quick-tiles">
        <button class="qtile" data-new="takeaway"><div class="qi cyan">${icon('bag', 22)}</div><div><div class="qt">Takeaway</div><div class="qs">Counter / parcel order</div></div></button>
        ${hasDelivery ? `<button class="qtile" data-new="delivery"><div class="qi pink">${icon('truck', 22)}</div><div><div class="qt">Delivery</div><div class="qs">Home delivery order</div></div></button>` : ''}
        ${can('qr_orders') ? `<a class="qtile" href="#/qr-orders"><div class="qi">${icon('qr', 22)}</div><div><div class="qt">QR orders</div><div class="qs">Awaiting acceptance</div></div></a>` : ''}
      </div>
      <div class="row wrap" style="margin-top:18px;gap:12px">
        <div class="chips">
          <button class="chip ${area === 'all' ? 'active' : ''}" data-area="all">All tables <span class="count">${tables.length}</span></button>
          ${areas.map((a) => `<button class="chip ${area === a ? 'active' : ''}" data-area="${esc(a)}">${esc(a)}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <div class="legend">${Object.entries(STATUS_LABEL).map(([k, v]) => `<span><i style="background:var(--st-${k})"></i>${v} ${counts[k] ? `(${counts[k]})` : ''}</span>`).join('')}</div>
      </div>
      ${tables.length ? Object.entries(byArea).map(([a, list]) => `
        <div class="area-title">${esc(a)}</div>
        <div class="tables-grid">${list.map(tableCard).join('')}</div>`).join('')
    : `<div class="card" style="margin-top:18px">${empty('grid', 'No tables yet', 'Add tables from Tables & QR to start taking dine-in orders.', can('tables_manage') ? '<a class="btn primary" href="#/tables">Add tables</a>' : '')}</div>`}
      ${offTable.length ? `<div class="area-title">Takeaway & delivery</div>
        <div class="tables-grid">${offTable.map((o) => `
          <button class="tcard ${o.status === 'billed' ? 'billed' : 'occupied'}" data-order="${o.id}">
            <div class="tname">${icon(o.type === 'delivery' ? 'truck' : 'bag', 18)} #${o.order_no}</div>
            <div class="tstate">${ORDER_TYPE[o.type]} · ${o.status === 'billed' ? 'Billed' : 'Running'}</div>
            <div class="tmeta">${esc(o.customer_name || o.customer_phone || '')}</div>
            <div class="tamt money">${money(o.total)}</div>
            <div class="tmeta">${icon('clock', 13)} ${timeAgo(o.created_at)}</div>
          </button>`).join('')}</div>` : ''}`;
  };

  const tableCard = (t) => {
    const o = t.order;
    const lock = t.lock_name && !t.locked_by_me ? `<div class="lock">${icon('lock', 11)}<span>${esc(t.lock_name)}</span></div>` : '';
    return `<button class="tcard ${t.status}" data-table="${t.id}" data-status="${t.status}">
      ${o?.pending_items ? `<span class="qr-flag">QR ${o.pending_items}</span>` : ''}
      <span class="seats">${icon('armchair', 13)} ${t.seats}</span>
      <div class="tname">${esc(t.name)}</div>
      <div class="tstate">${STATUS_LABEL[t.status] || t.status}</div>
      ${o ? `<div class="tamt money">${money(o.total)}</div><div class="tmeta">${icon('clock', 13)} ${minutesSince(o.created_at)} min · ${o.item_count} items</div>` : '<div class="tamt"></div>'}
      ${lock}
    </button>`;
  };

  // Long-press (or right-click) a table for Free / Reserve / Cleaning.
  let pressTimer = null;
  let longPressed = false;
  const tableMenu = (id) => {
    const t = tables.find((x) => String(x.id) === String(id));
    if (!t) return;
    const m = modal({
      title: `Table ${t.name}`, size: 'narrow',
      body: `<div class="col">${t.order ? `<div class="notice">${icon('info')}<div>This table has a running order of ${money(t.order.total)}.</div></div>` : `
        <button class="btn lg" data-st="free">${icon('check_circle')} Mark free</button>
        <button class="btn lg" data-st="reserved">${icon('calendar')} Mark reserved</button>
        <button class="btn lg" data-st="cleaning">${icon('sparkles')} Mark cleaning</button>`}
        <button class="btn primary lg" data-open>${icon('pos')} Open table</button></div>`,
    });
    on(m.el, 'click', '[data-st]', async (e, b) => {
      try { await api(`/api/tables/${t.id}/status`, { method: 'POST', body: { status: b.dataset.st } }); m.close(); load(); } catch (err) { toastError(err); }
    });
    m.el.querySelector('[data-open]').addEventListener('click', () => { m.close(); ctx.go(`/pos/table/${t.id}`); });
  };
  ctx.el.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('[data-table]');
    if (!card) return;
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; tableMenu(card.dataset.table); }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => ctx.el.addEventListener(ev, () => clearTimeout(pressTimer)));
  ctx.el.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-table]');
    if (card) { e.preventDefault(); tableMenu(card.dataset.table); }
  });

  on(ctx.el, 'click', '[data-table]', (e, b) => {
    if (longPressed) return;
    const st = b.dataset.status;
    if (st === 'cleaning' || st === 'reserved') return tableMenu(b.dataset.table);
    ctx.go(`/pos/table/${b.dataset.table}`);
  });
  on(ctx.el, 'click', '[data-area]', (e, b) => { area = b.dataset.area; draw(); });
  on(ctx.el, 'click', '[data-new]', (e, b) => ctx.go(`/pos/new/${b.dataset.new}`));
  on(ctx.el, 'click', '[data-order]', (e, b) => ctx.go(`/pos/order/${b.dataset.order}`));

  draw();
  await load();
  ctx.every(load, 6000);
}

// ---------------------------------------------------------------------------
// Order screen
// ---------------------------------------------------------------------------
async function orderScreen(ctx) {
  const me = ctx.me;
  let menu = cache.get('menu');
  let order = null;
  let table = null;
  let type = ctx.view === 'new' ? ctx.params.type : 'dine_in';
  let customer = {};
  let cat = 'all';
  let search = '';
  let cart = []; // { key, menu_item_id, name, price, veg, qty, note, seat }
  let opened = false;

  const back = async () => {
    if (table && opened) { try { await api(`/api/tables/${table.id}/close`, { method: 'POST' }); } catch { /* ignore */ } }
    ctx.go('/pos');
  };

  // ---- load ----
  try {
    const menuP = api('/api/menu').then((m) => { menu = m; cache.set('menu', m); }).catch((e) => { if (!menu) throw e; });
    if (ctx.view === 'table') {
      const res = await api(`/api/tables/${ctx.params.id}/open`, { method: 'POST' });
      opened = true;
      table = res.table;
      order = res.order;
      if (res.openedAsOwner) toast(res.message, 'info', 5000);
    } else if (ctx.view === 'order') {
      order = await api(`/api/orders/${ctx.params.id}`);
      type = order.type;
      if (order.table_id) { ctx.go(`/pos/table/${order.table_id}`); return; }
    }
    await menuP;
  } catch (err) {
    if (err.code === 'OFFLINE' && menu && ctx.view === 'table') {
      table = (cache.get('tables') || []).find((t) => String(t.id) === ctx.params.id) || { id: Number(ctx.params.id), name: `#${ctx.params.id}` };
      toast('Offline — orders will be saved on this device', 'info');
    } else {
      toastError(err);
      ctx.go('/pos');
      return;
    }
  }
  if (order) { type = order.type; customer = { name: order.customer_name, phone: order.customer_phone, address: order.address }; }
  if (!['dine_in', 'takeaway', 'delivery'].includes(type)) { ctx.go('/pos'); return; }

  const title = () => {
    const t = table ? `Table ${esc(table.name)}` : `${ORDER_TYPE[type]}${order ? ` #${order.order_no}` : ' — new'}`;
    ctx.setTitle(`<button class="btn ghost icon" data-back title="Close table">${icon('back')}</button><span>${t}</span>${order ? badge(order.status) : ''}`,
      order && can('pos') ? `<button class="btn sm" data-more>${icon('settings', 15)} Options</button>` : '');
  };
  ctx.actionsEl.parentElement.querySelector('#page-title').onclick = (e) => { if (e.target.closest('[data-back]')) back(); };
  ctx.onLeave(() => { const t = document.querySelector('#page-title'); if (t) t.onclick = null; });

  const items = () => (menu?.items || []).filter((i) => (cat === 'all' || i.category_id === Number(cat))
    && (!search || i.name.toLowerCase().includes(search.toLowerCase())));
  const cartQty = (id) => cart.filter((c) => c.menu_item_id === id).reduce((s, c) => s + c.qty, 0);
  const cartTotal = () => cart.reduce((s, c) => s + c.qty * c.price, 0);

  ctx.el.classList.add('has-fab');
  ctx.onLeave(() => ctx.el.classList.remove('has-fab'));

  const drawMenu = () => {
    const list = items();
    $('#menu-pane', ctx.el).innerHTML = `
      <div class="menu-tools">
        <div class="input-icon">${icon('search', 17)}<input class="input" id="msearch" placeholder="Search dishes…" value="${esc(search)}" autocomplete="off"></div>
      </div>
      <div class="chips">
        <button class="chip ${cat === 'all' ? 'active' : ''}" data-cat="all">All</button>
        ${(menu?.categories || []).map((c) => `<button class="chip ${String(cat) === String(c.id) ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
      </div>
      <div class="items-grid">${list.map((i) => {
        const q = cartQty(i.id);
        return `<button class="mitem ${i.available ? '' : 'off'}" data-add="${i.id}">${q ? `<span class="qbadge">${q}</span>` : ''}
          <div class="row" style="gap:6px">${vegDot(i.veg)}${i.available ? '' : '<span class="badge danger">Finished</span>'}</div>
          <div class="mn">${esc(i.name)}</div><div class="mp money">${money(i.price)}</div></button>`;
      }).join('') || `<div style="grid-column:1/-1">${empty('search', 'No dishes found', 'Try another name or category.')}</div>`}</div>`;
    const inp = $('#msearch', ctx.el);
    inp.addEventListener('input', () => { search = inp.value; const pos = inp.selectionStart; drawMenu(); const n = $('#msearch', ctx.el); n.focus(); n.setSelectionRange(pos, pos); });
  };

  const drawCart = () => {
    const sent = order ? order.items.filter((i) => i.status !== 'pending') : [];
    const pendingQr = order ? order.items.filter((i) => i.status === 'pending') : [];
    const total = (order?.total || 0) + cartTotal();
    const canBill = can('billing') && order && order.subtotal > 0;
    $('#cart', ctx.el).innerHTML = `
      <div class="cart-head row">
        <div style="flex:1;min-width:0"><div class="bold">${table ? `Table ${esc(table.name)}` : ORDER_TYPE[type]}${order ? ` · #${order.order_no}` : ''}</div>
        <div class="small muted">${order?.captain_name ? `${icon('users', 12)} ${esc(order.captain_name)} · ` : ''}${order ? timeAgo(order.created_at) : 'New order'}
        ${customer.name || customer.phone ? ` · ${esc(customer.name || customer.phone)}` : ''}</div></div>
        <button class="btn ghost icon sm cart-close" data-cart-close>${icon('x')}</button>
      </div>
      <div class="cart-body">
        ${cart.length ? `<div class="cart-sec">${icon('sparkles', 13)} New items — not sent yet</div>${cart.map((c) => `
          <div class="cline"><div class="cn">${vegDot(c.veg)}<span>${esc(c.name)}</span></div>
            <div class="stepper"><button data-dec="${c.key}">${icon('minus', 14)}</button><span>${c.qty}</span><button data-inc="${c.key}">${icon('plus', 14)}</button></div>
            <div class="cm"><span class="money">${money(c.qty * c.price)}</span>
              <button class="btn ghost sm" data-note="${c.key}" style="--h:24px;padding:0 6px">${icon('note', 13)} ${c.note ? esc(c.note) : 'Note'}</button>
              <button class="btn ghost sm" data-seat="${c.key}" style="--h:24px;padding:0 6px">${icon('armchair', 13)} ${c.seat ? `Seat ${esc(c.seat)}` : 'Seat'}</button></div>
          </div>`).join('')}` : ''}
        ${pendingQr.length ? `<div class="cart-sec" style="color:var(--danger)">${icon('qr', 13)} From QR — awaiting acceptance</div>${pendingQr.map(lineSent).join('')}
          ${can('qr_orders') ? `<div style="padding:4px 18px 8px"><button class="btn sm success" data-accept>${icon('check')} Accept & send to kitchen</button></div>` : ''}` : ''}
        ${sent.length ? `<div class="cart-sec">${icon('kitchen', 13)} Sent to kitchen</div>${sent.map(lineSent).join('')}` : ''}
        ${!cart.length && !sent.length && !pendingQr.length ? empty('cart', 'No items yet', 'Tap dishes on the left to add them.') : ''}
      </div>
      <div class="cart-foot">
        ${order ? `<div class="sum-row"><span>Sent items</span><span class="money">${money(order.subtotal)}</span></div>` : ''}
        ${order?.discount ? `<div class="sum-row"><span>Discount</span><span class="money">−${money(order.discount)}</span></div>` : ''}
        ${cart.length ? `<div class="sum-row"><span>New items</span><span class="money">${money(cartTotal())}</span></div>` : ''}
        <div class="sum-row total"><span>Total</span><span class="money">${money(total)}</span></div>
        <div class="cart-actions">
          <button class="btn primary lg wide" data-kot ${cart.length ? '' : 'disabled'}>${icon('send')} Send KOT${cart.length ? ` (${cart.reduce((s, c) => s + c.qty, 0)})` : ''}</button>
          ${can('billing') ? `<button class="btn lg" data-bill ${canBill ? '' : 'disabled'}>${icon('printer')} Bill</button>
          <button class="btn solid lg" data-pay ${canBill ? '' : 'disabled'}>${icon('wallet')} Pay</button>` : ''}
        </div>
      </div>`;
    const fab = $('#cart-fab', ctx.el);
    fab.innerHTML = `<button class="btn primary xl block" data-cart-open>${icon('cart')} View order · ${cart.length ? `${cart.reduce((s, c) => s + c.qty, 0)} new · ` : ''}${money(total)}</button>`;
  };

  const lineSent = (i) => `<div class="cline sent ${i.status === 'cancelled' ? 'cancelled' : ''}">
    <div class="cn"><span class="st-dot ${i.status}"></span><span>${i.qty} × ${esc(i.name)}</span></div>
    <div class="row" style="gap:4px"><span class="money small">${money(i.qty * i.price)}</span>
      ${can('cancel_items') && !['cancelled', 'served'].includes(i.status) && order?.status !== 'paid' ? `<button class="btn ghost icon sm danger-ghost" data-cancel="${i.id}" title="Cancel item" style="--h:26px">${icon('x', 14)}</button>` : ''}</div>
    <div class="cm">${badge(i.status)}${i.kot_no ? `<span>KOT #${i.kot_no}</span>` : ''}${i.note ? `<span>“${esc(i.note)}”</span>` : ''}${i.seat ? `<span>Seat ${esc(i.seat)}</span>` : ''}${i.cancel_reason ? `<span>${esc(i.cancel_reason)}</span>` : ''}</div>
  </div>`;

  ctx.el.innerHTML = `<div class="order-screen"><section class="menu-pane" id="menu-pane"></section><aside class="card cart" id="cart"></aside></div><div class="cart-fab" id="cart-fab"></div>`;
  title();
  drawMenu();
  drawCart();

  const addItem = (id) => {
    const mi = menu.items.find((i) => i.id === Number(id));
    if (!mi || !mi.available) return;
    const line = cart.find((c) => c.menu_item_id === mi.id && !c.note && !c.seat);
    if (line) line.qty++;
    else cart.push({ key: newKey(), menu_item_id: mi.id, name: mi.name, price: mi.price, veg: mi.veg, qty: 1, note: '', seat: '' });
    drawMenu(); drawCart();
  };

  const refreshOrder = async () => {
    if (!order) return;
    try {
      order = await api(`/api/orders/${order.id}`);
      if (order.status === 'paid' || order.status === 'cancelled') { toast(`Order ${order.status === 'paid' ? 'settled' : 'cancelled'}`); back(); return; }
      if (ctx.isCurrent()) { title(); drawCart(); }
    } catch { /* offline */ }
  };

  const doSendKot = async (force = false) => {
    if (!cart.length) return;
    if (!order && type === 'delivery' && !(customer.phone && customer.address)) {
      const ok = await askCustomer(true);
      if (!ok) return;
    }
    const payload = {
      type, table_id: table?.id, order_id: order?.id, customer, force, client_key: newKey(),
      items: cart.map((c) => ({ menu_item_id: c.menu_item_id, qty: c.qty, note: c.note, seat: c.seat })),
    };
    try {
      const res = await sendKot(payload);
      if (res.offline) {
        toast('Offline — order saved on this device and will be sent automatically', 'info', 5000);
        cart = []; drawMenu(); drawCart();
        return;
      }
      order = res.order;
      cart = [];
      toast(res.replayed ? 'Already sent earlier' : 'KOT sent to the kitchen');
      if (!table && ctx.view === 'new') history.replaceState(null, '', `#/pos/order/${order.id}`);
      title(); drawMenu(); drawCart();
      if (table) back();
    } catch (err) {
      if (err.code === 'DUPLICATE_ITEMS') {
        const again = await confirmDialog({
          title: 'Already added', confirmText: 'Add again',
          message: `${err.message} (${(err.details?.items || []).join(', ')}). Tap "Add again" only if the guest really ordered them again.`,
        });
        if (again) doSendKot(true);
        return;
      }
      toastError(err);
    }
  };

  const askCustomer = async (required = false) => {
    const isDel = type === 'delivery';
    const res = await formModal({
      title: isDel ? 'Delivery details' : 'Customer details',
      fields: [
        { name: 'phone', label: 'Mobile number', type: 'tel', value: customer.phone || '', required: isDel && required },
        { name: 'name', label: 'Name', value: customer.name || '' },
        ...(isDel ? [{ name: 'address', label: 'Delivery address', type: 'textarea', value: customer.address || '', required: true, full: true },
          { name: 'cod', label: 'Cash on delivery', type: 'switch', value: customer.cod !== false, full: true }] : []),
      ],
      submitText: 'Save',
      onSubmit: async (v) => {
        customer = { ...customer, ...v };
        if (order) order = await api(`/api/orders/${order.id}`, { method: 'PATCH', body: { customer_name: v.name, customer_phone: v.phone, address: v.address } });
        return true;
      },
    });
    drawCart();
    return Boolean(res);
  };

  const options = () => {
    const m = modal({
      title: 'Order options', size: 'narrow',
      body: `<div class="col">
        <button class="btn lg" data-o="customer">${icon('users')} Customer details</button>
        ${table ? `<button class="btn lg" data-o="move">${icon('move')} Move to another table</button>` : ''}
        ${can('cancel_items') ? `<button class="btn lg danger-ghost" data-o="cancel">${icon('trash')} Cancel whole order</button>` : ''}
      </div>`,
    });
    on(m.el, 'click', '[data-o]', async (e, b) => {
      m.close();
      const o = b.dataset.o;
      if (o === 'customer') askCustomer();
      if (o === 'move') {
        const list = (await api('/api/tables')).filter((t) => !t.order && t.id !== table.id && t.status !== 'cleaning');
        if (!list.length) return toast('No free table to move to', 'info');
        await formModal({
          title: 'Move order', submitText: 'Move',
          fields: [{ name: 'table_id', label: 'Move to table', type: 'select', options: list.map((t) => [t.id, `${t.name} — ${t.area}`]), full: true }],
          onSubmit: async (v) => { order = await api(`/api/orders/${order.id}/move`, { method: 'POST', body: { table_id: Number(v.table_id) } }); toast(`Moved to ${order.table_name}`); ctx.go(`/pos/table/${order.table_id}`); },
        });
      }
      if (o === 'cancel') {
        await formModal({
          title: 'Cancel order', submitText: 'Cancel order', danger: true,
          fields: [{ name: 'reason', label: 'Reason', required: true, full: true, placeholder: 'e.g. Guest left' }],
          onSubmit: async (v) => { await api(`/api/orders/${order.id}/cancel`, { method: 'POST', body: v }); toast('Order cancelled'); back(); },
        });
      }
    });
  };

  // ---- events ----
  on(ctx.el, 'click', '[data-cat]', (e, b) => { cat = b.dataset.cat; drawMenu(); });
  on(ctx.el, 'click', '[data-add]', (e, b) => addItem(b.dataset.add));
  on(ctx.el, 'click', '[data-inc]', (e, b) => { cart.find((c) => c.key === b.dataset.inc).qty++; drawMenu(); drawCart(); });
  on(ctx.el, 'click', '[data-dec]', (e, b) => {
    const c = cart.find((x) => x.key === b.dataset.dec);
    c.qty--; if (c.qty <= 0) cart = cart.filter((x) => x !== c);
    drawMenu(); drawCart();
  });
  on(ctx.el, 'click', '[data-note],[data-seat]', async (e, b) => {
    const isNote = 'note' in b.dataset;
    const c = cart.find((x) => x.key === (b.dataset.note || b.dataset.seat));
    await formModal({
      title: isNote ? `Note for ${c.name}` : `Seat for ${c.name}`, submitText: 'Save',
      fields: [{ name: 'v', label: isNote ? 'Kitchen note' : 'Seat', value: isNote ? c.note : c.seat, placeholder: isNote ? 'less spicy, no onion…' : 'e.g. 2', full: true, maxlength: isNote ? 200 : 10 }],
      onSubmit: (v) => { if (isNote) c.note = v.v; else c.seat = v.v; },
    });
    drawCart();
  });
  on(ctx.el, 'click', '[data-kot]', (e, b) => busy(b, () => doSendKot()));
  on(ctx.el, 'click', '[data-bill]', () => openBillDialog(order, { onDone: (o, paid) => { order = o; if (paid) back(); else { title(); drawCart(); } } }));
  on(ctx.el, 'click', '[data-pay]', () => openBillDialog(order, { startWithPay: true, onDone: (o, paid) => { order = o; if (paid) back(); else { title(); drawCart(); } } }));
  on(ctx.el, 'click', '[data-cancel]', async (e, b) => {
    const item = order.items.find((i) => String(i.id) === b.dataset.cancel);
    await formModal({
      title: `Cancel ${item.name}`, submitText: 'Cancel item', danger: true,
      fields: [
        ...(item.qty > 1 ? [{ name: 'qty', label: 'How many to cancel', type: 'number', value: item.qty, min: 1, max: item.qty, required: true }] : []),
        { name: 'reason', label: 'Reason', placeholder: 'e.g. Guest changed mind', full: true },
      ],
      onSubmit: async (v) => { order = await api(`/api/order-items/${item.id}/cancel`, { method: 'POST', body: v }); toast('Item cancelled'); },
    });
    title(); drawCart();
  });
  on(ctx.el, 'click', '[data-accept]', (e, b) => busy(b, async () => {
    try { order = await api(`/api/orders/${order.id}/accept`, { method: 'POST' }); toast('Accepted — sent to the kitchen'); title(); drawCart(); } catch (err) { toastError(err); }
  }));
  on(ctx.el, 'click', '[data-cart-open]', () => $('#cart', ctx.el).classList.add('open'));
  on(ctx.el, 'click', '[data-cart-close]', () => $('#cart', ctx.el).classList.remove('open'));
  ctx.actionsEl.onclick = (e) => { if (e.target.closest('[data-more]')) options(); };
  ctx.onLeave(() => { ctx.actionsEl.onclick = null; });

  ctx.every(refreshOrder, 8000);
  if (type === 'delivery' && !order) askCustomer(true);
}

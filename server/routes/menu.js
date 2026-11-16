import { can } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { now, num, str } from '../lib/util.js';

function itemInput(db, ctx, b) {
  const categoryId = num(b.category_id, 'Category', { int: true });
  if (categoryId && !db.get('SELECT id FROM categories WHERE id = ? AND restaurant_id = ?', categoryId, ctx.rid)) throw badRequest('Choose a valid category.');
  const station = str(b.station, 'Station', { max: 40 }) || ctx.settings.stations[0] || 'Main Kitchen';
  return {
    name: str(b.name, 'Item name', { required: true, max: 100 }),
    description: str(b.description, 'Description', { max: 300 }),
    category_id: categoryId ?? null,
    price: num(b.price, 'Price', { required: true, min: 0, max: 1e6 }),
    veg: b.veg === false || b.veg === 0 || b.veg === 'non_veg' ? 0 : 1,
    available: b.available === false || b.available === 0 ? 0 : 1,
    station,
  };
}

function checkItemLimit(db, ctx, adding = 1) {
  const plan = db.get('SELECT max_menu_items FROM plans WHERE id = ?', ctx.restaurant.plan_id);
  const count = db.get('SELECT COUNT(*) AS c FROM menu_items WHERE restaurant_id = ?', ctx.rid).c;
  if (plan && count + adding > plan.max_menu_items) {
    throw forbidden(`Your plan allows ${plan.max_menu_items} menu items. Upgrade your plan to add more.`, 'PLAN_LIMIT');
  }
}

/** Parse one CSV line, honouring double-quoted fields. */
function csvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export default function register(r, db) {
  /** Full menu for POS & management. */
  r.get('/api/menu', can('pos', 'menu', 'kitchen'), (ctx) => ({
    categories: db.all(`SELECT c.*, (SELECT COUNT(*) FROM menu_items m WHERE m.category_id = c.id) AS item_count
      FROM categories c WHERE c.restaurant_id = ? ORDER BY c.sort, c.name`, ctx.rid),
    items: db.all('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY name', ctx.rid),
    stations: ctx.settings.stations,
  }));

  r.post('/api/menu/categories', can('menu'), (ctx) => {
    const name = str(ctx.body.name, 'Category name', { required: true, max: 60 });
    const sort = db.get('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE restaurant_id = ?', ctx.rid).s;
    const { id } = db.run('INSERT INTO categories (restaurant_id, name, sort, created_at) VALUES (?, ?, ?, ?)', ctx.rid, name, sort, now());
    return db.get('SELECT * FROM categories WHERE id = ?', id);
  });

  r.put('/api/menu/categories/:id', can('menu'), (ctx) => {
    const { changes } = db.run('UPDATE categories SET name = ?, sort = COALESCE(?, sort) WHERE id = ? AND restaurant_id = ?',
      str(ctx.body.name, 'Category name', { required: true, max: 60 }), num(ctx.body.sort, 'Sort', { int: true }) ?? null, ctx.params.id, ctx.rid);
    if (!changes) throw notFound('Category not found.');
    return { ok: true };
  });

  r.delete('/api/menu/categories/:id', can('menu'), (ctx) => {
    const { changes } = db.run('DELETE FROM categories WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!changes) throw notFound('Category not found.');
    return { ok: true };
  });

  r.post('/api/menu/items', can('menu'), (ctx) => {
    checkItemLimit(db, ctx);
    const it = itemInput(db, ctx, ctx.body);
    const { id } = db.run(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, veg, available, station, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.rid, it.category_id, it.name, it.description, it.price, it.veg, it.available, it.station, now(),
    );
    return db.get('SELECT * FROM menu_items WHERE id = ?', id);
  });

  r.put('/api/menu/items/:id', can('menu'), (ctx) => {
    const it = itemInput(db, ctx, ctx.body);
    const { changes } = db.run(
      `UPDATE menu_items SET category_id = ?, name = ?, description = ?, price = ?, veg = ?, available = ?, station = ?
       WHERE id = ? AND restaurant_id = ?`,
      it.category_id, it.name, it.description, it.price, it.veg, it.available, it.station, ctx.params.id, ctx.rid,
    );
    if (!changes) throw notFound('Item not found.');
    return db.get('SELECT * FROM menu_items WHERE id = ?', ctx.params.id);
  });

  /** "Item finished for today" — managers and kitchen can toggle availability. */
  r.post('/api/menu/items/:id/availability', can('menu', 'kitchen'), (ctx) => {
    const { changes } = db.run('UPDATE menu_items SET available = ? WHERE id = ? AND restaurant_id = ?',
      ctx.body.available ? 1 : 0, ctx.params.id, ctx.rid);
    if (!changes) throw notFound('Item not found.');
    return { ok: true };
  });

  r.delete('/api/menu/items/:id', can('menu'), (ctx) => {
    const { changes } = db.run('DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!changes) throw notFound('Item not found.');
    return { ok: true };
  });

  r.post('/api/menu/items/bulk-delete', can('menu'), (ctx) => {
    const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(Number).filter(Number.isInteger);
    if (!ids.length) throw badRequest('Select at least one item.');
    let deleted = 0;
    db.tx(() => { for (const id of ids) deleted += db.run('DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?', id, ctx.rid).changes; });
    return { deleted };
  });

  /** Import CSV: one item per line — name, category, price, veg/non_veg[, station]. */
  r.post('/api/menu/import', can('menu'), (ctx) => {
    const text = str(ctx.body.csv, 'CSV', { required: true, max: 200000 });
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    const errors = [];
    lines.forEach((line, i) => {
      const [name, category, price, vegRaw, station] = csvLine(line);
      if (i === 0 && /^name$/i.test(name) && /price/i.test(price || '')) return; // header row
      const p = Number(price);
      if (!name || !Number.isFinite(p) || p < 0) { errors.push(`Line ${i + 1}: needs name, category, price`); return; }
      const veg = !/^(non[_\s-]?veg|nv|n|0|false)$/i.test(vegRaw || 'veg');
      rows.push({ name: name.slice(0, 100), category: (category || 'General').slice(0, 60), price: p, veg, station });
    });
    if (!rows.length) throw badRequest(errors[0] || 'No valid lines found.', 'IMPORT_EMPTY', { errors });
    checkItemLimit(db, ctx, rows.length);
    const ts = now();
    db.tx(() => {
      const cats = new Map(db.all('SELECT id, name FROM categories WHERE restaurant_id = ?', ctx.rid).map((c) => [c.name.toLowerCase(), c.id]));
      for (const row of rows) {
        let cid = cats.get(row.category.toLowerCase());
        if (!cid) {
          const sort = db.get('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE restaurant_id = ?', ctx.rid).s;
          cid = db.run('INSERT INTO categories (restaurant_id, name, sort, created_at) VALUES (?, ?, ?, ?)', ctx.rid, row.category, sort, ts).id;
          cats.set(row.category.toLowerCase(), cid);
        }
        db.run(`INSERT INTO menu_items (restaurant_id, category_id, name, price, veg, available, station, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, ctx.rid, cid, row.name, row.price, row.veg ? 1 : 0,
        row.station || ctx.settings.stations[0] || 'Main Kitchen', ts);
      }
    });
    return { imported: rows.length, errors };
  });
}

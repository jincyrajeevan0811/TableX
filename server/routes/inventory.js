import { can } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/http.js';
import { now, num, oneOf, round2, str } from '../lib/util.js';

export default function register(r, db) {
  r.get('/api/inventory', can('inventory'), (ctx) => ({
    items: db.all('SELECT * FROM inventory_items WHERE restaurant_id = ? ORDER BY name', ctx.rid),
    moves: db.all(`SELECT m.*, i.name AS item_name, i.unit, u.name AS by_name FROM stock_moves m JOIN inventory_items i ON i.id = m.item_id
      LEFT JOIN users u ON u.id = m.created_by WHERE m.restaurant_id = ? ORDER BY m.id DESC LIMIT 100`, ctx.rid),
  }));

  r.post('/api/inventory/items', can('inventory'), (ctx) => {
    const b = ctx.body;
    const { id } = db.run(
      'INSERT INTO inventory_items (restaurant_id, name, unit, qty, reorder_level, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ctx.rid, str(b.name, 'Item name', { required: true, max: 80 }), str(b.unit, 'Unit', { max: 12 }) || 'kg',
      num(b.qty, 'Opening stock', { min: 0, max: 1e7 }) ?? 0, num(b.reorder_level, 'Reorder level', { min: 0, max: 1e7 }) ?? 0,
      num(b.cost, 'Unit cost', { min: 0, max: 1e7 }) ?? 0, now(),
    );
    return db.get('SELECT * FROM inventory_items WHERE id = ?', id);
  });

  r.put('/api/inventory/items/:id', can('inventory'), (ctx) => {
    const b = ctx.body;
    const { changes } = db.run('UPDATE inventory_items SET name = ?, unit = ?, reorder_level = ?, cost = ? WHERE id = ? AND restaurant_id = ?',
      str(b.name, 'Item name', { required: true, max: 80 }), str(b.unit, 'Unit', { max: 12 }) || 'kg',
      num(b.reorder_level, 'Reorder level', { min: 0, max: 1e7 }) ?? 0, num(b.cost, 'Unit cost', { min: 0, max: 1e7 }) ?? 0, ctx.params.id, ctx.rid);
    if (!changes) throw notFound('Stock item not found.');
    return { ok: true };
  });

  r.delete('/api/inventory/items/:id', can('inventory'), (ctx) => {
    const { changes } = db.run('DELETE FROM inventory_items WHERE id = ? AND restaurant_id = ?', ctx.params.id, ctx.rid);
    if (!changes) throw notFound('Stock item not found.');
    return { ok: true };
  });

  /** Purchase (stock in), usage / wastage (stock out) or a count adjustment. */
  r.post('/api/inventory/moves', can('inventory'), (ctx) => {
    const b = ctx.body;
    const item = db.get('SELECT * FROM inventory_items WHERE id = ? AND restaurant_id = ?', b.item_id, ctx.rid);
    if (!item) throw notFound('Stock item not found.');
    const type = oneOf(b.type, 'Type', ['purchase', 'usage', 'wastage', 'adjust']);
    const qty = num(b.qty, 'Quantity', { required: true, min: 0, max: 1e7 });
    let next = item.qty;
    if (type === 'purchase') next += qty;
    else if (type === 'adjust') next = qty;
    else {
      if (qty > item.qty) throw badRequest(`Only ${item.qty} ${item.unit} of ${item.name} in stock.`);
      next -= qty;
    }
    const cost = num(b.cost, 'Cost', { min: 0, max: 1e8 }) ?? 0;
    db.tx(() => {
      db.run(`INSERT INTO stock_moves (restaurant_id, item_id, type, qty, cost, supplier, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.rid, item.id, type, qty, cost, str(b.supplier, 'Supplier', { max: 80 }),
      str(b.note, 'Note', { max: 200 }), ctx.user.id, now());
      db.run('UPDATE inventory_items SET qty = ?, cost = CASE WHEN ? > 0 AND ? > 0 THEN ? ELSE cost END WHERE id = ?',
        round2(next), type === 'purchase' ? cost : 0, qty, qty > 0 ? round2(cost / qty) : 0, item.id);
    });
    return db.get('SELECT * FROM inventory_items WHERE id = ?', item.id);
  });
}

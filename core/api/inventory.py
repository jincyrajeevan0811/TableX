from ..lib.auth import can
from ..lib.http import bad, dump, endpoint, not_found
from ..lib.util import n, now, one_of, round2, s
from ..models import InventoryItem, StockMove


@endpoint(can('inventory'))
def inventory(ctx):
    moves = StockMove.objects.select_related('item', 'created_by').filter(restaurant_id=ctx.rid).order_by('-id')[:100]
    return {'items': [dump(i) for i in InventoryItem.objects.filter(restaurant_id=ctx.rid).order_by('name')],
            'moves': [dump(m, item_name=m.item.name, unit=m.item.unit, by_name=m.created_by.name if m.created_by else None) for m in moves]}


@endpoint(can('inventory'))
def item_create(ctx):
    b = ctx.body
    i = InventoryItem.objects.create(
        restaurant_id=ctx.rid, name=s(b.get('name'), 'Item name', required=True, max_len=80), unit=s(b.get('unit'), 'Unit', max_len=12) or 'kg',
        qty=n(b.get('qty'), 'Opening stock', min_v=0, max_v=1e7) or 0, reorder_level=n(b.get('reorder_level'), 'Reorder level', min_v=0, max_v=1e7) or 0,
        cost=n(b.get('cost'), 'Unit cost', min_v=0, max_v=1e7) or 0, created_at=now())
    return dump(i)


@endpoint(can('inventory'))
def item_update(ctx):
    b = ctx.body
    updated = InventoryItem.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).update(
        name=s(b.get('name'), 'Item name', required=True, max_len=80), unit=s(b.get('unit'), 'Unit', max_len=12) or 'kg',
        reorder_level=n(b.get('reorder_level'), 'Reorder level', min_v=0, max_v=1e7) or 0, cost=n(b.get('cost'), 'Unit cost', min_v=0, max_v=1e7) or 0)
    if not updated:
        raise not_found('Stock item not found.')
    return {'ok': True}


@endpoint(can('inventory'))
def item_delete(ctx):
    if not InventoryItem.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).delete()[0]:
        raise not_found('Stock item not found.')
    return {'ok': True}


@endpoint(can('inventory'))
def move(ctx):
    """Purchase (stock in), usage / wastage (stock out) or a count adjustment."""
    b = ctx.body
    item = InventoryItem.objects.filter(id=b.get('item_id'), restaurant_id=ctx.rid).first()
    if item is None:
        raise not_found('Stock item not found.')
    type_ = one_of(b.get('type'), 'Type', ['purchase', 'usage', 'wastage', 'adjust'])
    qty = n(b.get('qty'), 'Quantity', required=True, min_v=0, max_v=1e7)
    nxt = item.qty
    if type_ == 'purchase':
        nxt += qty
    elif type_ == 'adjust':
        nxt = qty
    else:
        if qty > item.qty:
            raise bad(f'Only {item.qty:g} {item.unit} of {item.name} in stock.')
        nxt -= qty
    cost = n(b.get('cost'), 'Cost', min_v=0, max_v=1e8) or 0
    StockMove.objects.create(restaurant_id=ctx.rid, item=item, type=type_, qty=qty, cost=cost, supplier=s(b.get('supplier'), 'Supplier', max_len=80),
                             note=s(b.get('note'), 'Note', max_len=200), created_by=ctx.user, created_at=now())
    item.qty = round2(nxt)
    if type_ == 'purchase' and cost > 0 and qty > 0:
        item.cost = round2(cost / qty)
    item.save()
    return dump(item)

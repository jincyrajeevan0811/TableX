import csv
import io

from django.db.models import Count, Max

from ..lib.auth import can
from ..lib.http import bad, dump, endpoint, forbidden, not_found
from ..lib.util import n, now, s
from ..models import Category, MenuItem, Plan


def item_input(ctx, b):
    cid = n(b.get('category_id'), 'Category', integer=True)
    if cid and not Category.objects.filter(id=cid, restaurant_id=ctx.rid).exists():
        raise bad('Choose a valid category.')
    station = s(b.get('station'), 'Station', max_len=40) or (ctx.settings['stations'] or ['Main Kitchen'])[0]
    veg_raw = b.get('veg')
    return {
        'name': s(b.get('name'), 'Item name', required=True, max_len=100),
        'description': s(b.get('description'), 'Description', max_len=300),
        'category_id': cid or None,
        'price': n(b.get('price'), 'Price', required=True, min_v=0, max_v=1e6),
        'veg': not (veg_raw is False or veg_raw == 0 or veg_raw == 'non_veg'),
        'available': not (b.get('available') is False or b.get('available') == 0),
        'station': station,
    }


def check_item_limit(ctx, adding=1):
    plan = Plan.objects.filter(id=ctx.restaurant.plan_id).first()
    count = MenuItem.objects.filter(restaurant_id=ctx.rid).count()
    if plan and count + adding > plan.max_menu_items:
        raise forbidden(f'Your plan allows {plan.max_menu_items} menu items. Upgrade your plan to add more.', 'PLAN_LIMIT')


def _next_sort(rid):
    return (Category.objects.filter(restaurant_id=rid).aggregate(m=Max('sort'))['m'] or 0) + 1


@endpoint(can('pos', 'menu', 'kitchen'))
def menu_get(ctx):
    cats = Category.objects.filter(restaurant_id=ctx.rid).annotate(item_count=Count('items')).order_by('sort', 'name')
    return {
        'categories': [dump(c, item_count=c.item_count) for c in cats],
        'items': [dump(i) for i in MenuItem.objects.filter(restaurant_id=ctx.rid).order_by('name')],
        'stations': ctx.settings['stations'],
    }


@endpoint(can('menu'))
def category_create(ctx):
    c = Category.objects.create(restaurant_id=ctx.rid, name=s(ctx.body.get('name'), 'Category name', required=True, max_len=60),
                                sort=_next_sort(ctx.rid), created_at=now())
    return dump(c)


@endpoint(can('menu'))
def category_update(ctx):
    c = Category.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).first()
    if c is None:
        raise not_found('Category not found.')
    c.name = s(ctx.body.get('name'), 'Category name', required=True, max_len=60)
    sort = n(ctx.body.get('sort'), 'Sort', integer=True)
    if sort is not None:
        c.sort = max(0, sort)
    c.save()
    return {'ok': True}


@endpoint(can('menu'))
def category_delete(ctx):
    if not Category.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).delete()[0]:
        raise not_found('Category not found.')
    return {'ok': True}


@endpoint(can('menu'))
def item_create(ctx):
    check_item_limit(ctx)
    return dump(MenuItem.objects.create(restaurant_id=ctx.rid, created_at=now(), **item_input(ctx, ctx.body)))


@endpoint(can('menu'))
def item_update(ctx):
    it = MenuItem.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).first()
    if it is None:
        raise not_found('Item not found.')
    for k, v in item_input(ctx, ctx.body).items():
        setattr(it, k, v)
    it.save()
    return dump(it)


@endpoint(can('menu'))
def item_delete(ctx):
    if not MenuItem.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).delete()[0]:
        raise not_found('Item not found.')
    return {'ok': True}


@endpoint(can('menu', 'kitchen'))
def item_availability(ctx):
    """'Item finished for today' — managers and kitchen can toggle availability."""
    if not MenuItem.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).update(available=bool(ctx.body.get('available'))):
        raise not_found('Item not found.')
    return {'ok': True}


@endpoint(can('menu'))
def items_bulk_delete(ctx):
    ids = [int(x) for x in (ctx.body.get('ids') or []) if str(x).lstrip('-').isdigit()]
    if not ids:
        raise bad('Select at least one item.')
    deleted, _ = MenuItem.objects.filter(restaurant_id=ctx.rid, id__in=ids).delete()
    return {'deleted': deleted}


@endpoint(can('menu'))
def menu_import(ctx):
    """CSV: one item per line — name, category, price, veg/non_veg[, station]."""
    text = s(ctx.body.get('csv'), 'CSV', required=True, max_len=200000)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    rows, errors = [], []
    for i, line in enumerate(lines):
        cols = [c.strip() for c in next(csv.reader(io.StringIO(line), skipinitialspace=True))] + ['', '', '', '', '']
        name, category, price, veg_raw, station = cols[:5]
        if i == 0 and name.lower() == 'name' and 'price' in price.lower():
            continue
        try:
            p = float(price)
        except ValueError:
            p = -1
        if not name or p < 0:
            errors.append(f'Line {i + 1}: needs name, category, price')
            continue
        veg = (veg_raw or 'veg').lower().replace(' ', '_').replace('-', '_') not in ('non_veg', 'nonveg', 'nv', 'n', '0', 'false')
        rows.append({'name': name[:100], 'category': (category or 'General')[:60], 'price': p, 'veg': veg, 'station': station})
    if not rows:
        raise bad(errors[0] if errors else 'No valid lines found.', 'IMPORT_EMPTY', {'errors': errors})
    check_item_limit(ctx, len(rows))
    ts = now()
    cats = {c.name.lower(): c.id for c in Category.objects.filter(restaurant_id=ctx.rid)}
    default_station = (ctx.settings['stations'] or ['Main Kitchen'])[0]
    for row in rows:
        cid = cats.get(row['category'].lower())
        if not cid:
            cid = Category.objects.create(restaurant_id=ctx.rid, name=row['category'], sort=_next_sort(ctx.rid), created_at=ts).id
            cats[row['category'].lower()] = cid
        MenuItem.objects.create(restaurant_id=ctx.rid, category_id=cid, name=row['name'], price=row['price'], veg=row['veg'],
                                available=True, station=row['station'] or default_station, created_at=ts)
    return {'imported': len(rows), 'errors': errors}

import datetime as dt

from django.db.models import Q

from ..lib.auth import can, has
from ..lib.http import bad, dump, endpoint, forbidden, not_found
from ..lib.orders import recalc_order
from ..lib.util import iso, now
from ..models import Kot, OrderItem

NEXT = {'new': 'preparing', 'preparing': 'ready', 'ready': 'served'}
STAMP = {'preparing': 'started_at', 'ready': 'ready_at', 'served': 'served_at'}


@endpoint(can('kitchen', 'pos'))
def kitchen(ctx):
    since = now() - dt.timedelta(minutes=15)
    qs = (Kot.objects.select_related('order', 'order__table', 'created_by')
          .filter(Q(status__in=('new', 'preparing', 'ready')) | Q(status='served', served_at__gte=since), restaurant_id=ctx.rid))
    if ctx.query.get('station'):
        qs = qs.filter(station=ctx.query['station'])
    kots = []
    for k in qs.order_by('created_at'):
        items = [{'id': i.id, 'name': i.name, 'qty': i.qty, 'note': i.note, 'seat': i.seat, 'veg': int(i.veg), 'status': i.status}
                 for i in k.items.exclude(status='cancelled').order_by('id')]
        if not items:
            continue
        o = k.order
        kots.append(dump(k, order_no=o.order_no, type=o.type, customer_name=o.customer_name, source=o.source,
                         table_name=o.table.name if o.table else None, created_by_name=k.created_by.name if k.created_by else None, items=items))
    return {'kots': kots, 'stations': ctx.settings['stations'], 'amber': ctx.settings['kitchen_amber_minutes'],
            'red': ctx.settings['kitchen_red_minutes'], 'server_time': iso(now())}


@endpoint(can('kitchen', 'pos'))
def kot_advance(ctx):
    """Tap to move a ticket along: New → Preparing → Ready → Picked up."""
    k = Kot.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).first()
    if k is None:
        raise not_found('Ticket not found.')
    to = ctx.body.get('to') or NEXT.get(k.status)
    if not to or to not in NEXT.values():
        raise bad('This ticket is already complete.')
    if not has(ctx, 'kitchen') and to != 'served':
        raise forbidden('Only the kitchen can change cooking status.')
    Kot.objects.filter(id=k.id).update(status=to, **{STAMP[to]: now()})
    OrderItem.objects.filter(kot_id=k.id).exclude(status='cancelled').update(status=to)
    k.refresh_from_db()
    return dump(k)


@endpoint(can('cancel_items'))
def kot_cancel(ctx):
    k = Kot.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).first()
    if k is None:
        raise not_found('Ticket not found.')
    Kot.objects.filter(id=k.id).update(status='cancelled')
    OrderItem.objects.filter(kot_id=k.id).update(status='cancelled', cancel_reason=str(ctx.body.get('reason') or 'KOT cancelled')[:200])
    recalc_order(k.order_id, ctx.settings)
    return {'ok': True}

from django.db.models import Count, Q, Sum

from ..lib.auth import can
from ..lib.http import bad, conflict, dump, endpoint, not_found
from ..lib.orders import get_order, order_detail, record_payments
from ..lib.util import day_bounds, now, round2, s
from ..models import Order, OrderItem, Payment, RiderStatus, User

ON_THE_WAY = ('assigned', 'accepted', 'picked_up')


def riders(rid):
    online = dict(RiderStatus.objects.filter(user__restaurant_id=rid).values_list('user_id', 'online'))
    active = dict(Order.objects.filter(restaurant_id=rid, delivery_status__in=ON_THE_WAY, rider__isnull=False)
                  .values('rider_id').annotate(c=Count('id')).values_list('rider_id', 'c'))
    out = [{'id': u.id, 'name': u.name, 'phone': u.phone, 'online': int(bool(online.get(u.id))), 'active': active.get(u.id, 0)}
           for u in User.objects.filter(restaurant_id=rid, role='rider', is_active=True)]
    return sorted(out, key=lambda r: (-r['online'], r['active'], r['name']))


def _items(o):
    return [{'name': i.name, 'qty': i.qty, 'status': i.status} for i in o.items.exclude(status='cancelled')]


def rider_order(ctx):
    o = get_order(ctx.rid, ctx.params['id'])
    if o.rider_id != ctx.user.id:
        raise not_found('This delivery is not assigned to you.')
    return o


@endpoint(can('delivery'))
def delivery(ctx):
    d_from, _, _ = day_bounds(None, ctx.settings['tz_offset_minutes'])
    qs = (Order.objects.select_related('rider').filter(restaurant_id=ctx.rid, type='delivery').exclude(status='cancelled')
          .filter(~Q(delivery_status='delivered') | Q(updated_at__gte=d_from)).order_by('-id'))
    orders = [dump(o, rider_name=o.rider.name if o.rider else None, rider_phone=o.rider.phone if o.rider else None, items=_items(o)) for o in qs]
    return {'orders': orders, 'riders': riders(ctx.rid)}


@endpoint(can('delivery'))
def assign(ctx):
    """Assign a rider — or auto-assign the free online rider with the fewest active deliveries."""
    o = get_order(ctx.rid, ctx.params['id'])
    if o.type != 'delivery':
        raise bad('This is not a delivery order.')
    if o.delivery_status in ('picked_up', 'delivered'):
        raise conflict('This order is already on its way.')
    try:
        rider_id = int(ctx.body.get('rider_id') or 0)
    except (TypeError, ValueError):
        rider_id = 0
    if ctx.body.get('auto') or not rider_id:
        pick = next((r for r in riders(ctx.rid) if r['online']), None)
        if pick is None:
            raise conflict('No rider is online right now.', 'NO_RIDER')
        rider_id = pick['id']
    elif not User.objects.filter(id=rider_id, restaurant_id=ctx.rid, role='rider', is_active=True).exists():
        raise not_found('Rider not found.')
    Order.objects.filter(id=o.id).update(rider_id=rider_id, delivery_status='assigned', updated_at=now())
    return order_detail(ctx.rid, o.id)


@endpoint(can('rider'))
def rider_home(ctx):
    d_from, _, _ = day_bounds(None, ctx.settings['tz_offset_minutes'])
    status = RiderStatus.objects.filter(user=ctx.user).first()
    qs = (Order.objects.filter(restaurant_id=ctx.rid, rider=ctx.user).exclude(status='cancelled')
          .filter(~Q(delivery_status='delivered') | Q(updated_at__gte=d_from)))
    orders = sorted(qs, key=lambda o: (o.delivery_status == 'delivered', -o.id))
    cash = Payment.objects.filter(received_by=ctx.user, method='cash', created_at__gte=d_from).aggregate(v=Sum('amount'))['v'] or 0
    return {'online': bool(status and status.online),
            'orders': [dump(o, exclude=('delivery_otp',), items=[{'name': i['name'], 'qty': i['qty']} for i in _items(o)]) for o in orders],
            'cash_collected': round2(cash)}


@endpoint(can('rider'))
def rider_online(ctx):
    online = bool(ctx.body.get('online'))
    RiderStatus.objects.update_or_create(user=ctx.user, defaults={'online': online, 'updated_at': now()})
    return {'online': online}


@endpoint(can('rider'))
def rider_accept(ctx):
    o = rider_order(ctx)
    if o.delivery_status != 'assigned':
        raise conflict('This delivery was already accepted.')
    Order.objects.filter(id=o.id).update(delivery_status='accepted', updated_at=now())
    return {'ok': True}


@endpoint(can('rider'))
def rider_pickup(ctx):
    o = rider_order(ctx)
    if o.delivery_status not in ('assigned', 'accepted'):
        raise conflict('This delivery is already picked up.')
    ts = now()
    Order.objects.filter(id=o.id).update(delivery_status='picked_up', updated_at=ts)
    o.kots.filter(status__in=('new', 'preparing', 'ready')).update(status='served', served_at=ts)
    OrderItem.objects.filter(order=o, status__in=('new', 'preparing', 'ready')).update(status='served')
    return {'ok': True}


@endpoint(can('rider'))
def rider_deliver(ctx):
    """At the door: verify the customer's 4-digit code, then mark delivered (and collect COD)."""
    o = rider_order(ctx)
    if o.delivery_status != 'picked_up':
        raise conflict('Tap "Picked up" before delivering.')
    otp = s(ctx.body.get('otp'), 'Delivery code', required=True, max_len=6)
    if otp != o.delivery_otp:
        raise bad('That code is not right. Ask the customer to check the 4-digit code.', 'BAD_OTP')
    due = round2(o.total - o.paid)
    if due > 0 and o.cod:
        record_payments(ctx, o.id, [{'method': 'cash', 'amount': due, 'reference': 'Cash on delivery'}], received_by=ctx.user.id)
    Order.objects.filter(id=o.id).update(delivery_status='delivered', updated_at=now())
    return order_detail(ctx.rid, o.id)

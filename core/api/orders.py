from django.db.models import Q

from ..lib.auth import can, has
from ..lib.gateway import restaurant_keys, start_checkout, verify_checkout
from ..lib.http import HttpError, bad, conflict, dump, endpoint, forbidden, not_found
from ..lib.orders import (ACTIVE_STATUSES, generate_bill, get_order, kitchen_state, next_counter, order_detail, recalc_order,
                          record_payments, send_kot)
from ..lib.permissions import plan_features
from .tables import lock_live
from ..lib.util import day_bounds, n, now, one_of, round2, s
from ..models import DiningTable, Kot, Order, OrderItem, Payment, User


@endpoint(can('pos'))
def kot(ctx):
    """Send KOT — creates the order if needed. Only the new items go to the kitchen."""
    b = ctx.body
    type_ = one_of(b.get('type'), 'Order type', ['dine_in', 'takeaway', 'delivery'], 'dine_in')
    if type_ == 'delivery' and 'delivery' not in plan_features(ctx.restaurant.plan_id):
        raise forbidden('Home delivery is not part of your plan. Upgrade to enable it.', 'PLAN_FEATURE')
    table_id = n(b.get('table_id'), 'Table', integer=True)
    if type_ == 'dine_in' and table_id and not b.get('order_id'):
        t = DiningTable.objects.filter(id=table_id, restaurant_id=ctx.rid).first()
        if t and lock_live(t) and t.lock_user_id != ctx.user.id and not has(ctx, 'open_any_table'):
            holder = User.objects.filter(id=t.lock_user_id).values_list('name', flat=True).first()
            raise HttpError(423, f"Table {t.name} is being served by {holder or 'another waiter'} right now.", 'TABLE_LOCKED')
    c = b.get('customer') or {}
    order, replayed = send_kot(
        ctx, order_id=n(b.get('order_id'), 'Order', integer=True), table_id=table_id, type=type_,
        customer={'name': s(c.get('name'), 'Customer name', max_len=80), 'phone': s(c.get('phone'), 'Customer phone', max_len=20),
                  'address': s(c.get('address'), 'Address', max_len=400), 'notes': s(c.get('notes'), 'Notes', max_len=300),
                  'cod': c.get('cod') is not False},
        items=b.get('items'), client_key=s(b.get('client_key'), 'client key', max_len=80) or None, force=bool(b.get('force')),
    )
    return {'order': order_detail(ctx.rid, order.id), 'replayed': bool(replayed)}


def _order_row(o):
    return dump(o, table_name=o.table.name if o.table else None, captain_name=o.captain.name if o.captain else None,
                rider_name=o.rider.name if o.rider else None)


@endpoint(can('pos', 'billing', 'live_orders', 'delivery'))
def orders_list(ctx):
    qs = Order.objects.select_related('table', 'captain', 'rider').filter(restaurant_id=ctx.rid, status__in=ACTIVE_STATUSES)
    if ctx.query.get('type'):
        qs = qs.filter(type=ctx.query['type'])
    return [_order_row(o) for o in qs.order_by('-id')[:200]]


@endpoint(can('pos', 'billing', 'bills', 'live_orders', 'delivery', 'qr_orders'))
def order_get(ctx):
    return order_detail(ctx.rid, ctx.params['id'])


@endpoint(can('pos', 'billing', 'delivery'))
def order_patch(ctx):
    o = get_order(ctx.rid, ctx.params['id'])
    b = ctx.body
    o.customer_name = s(b.get('customer_name', o.customer_name), 'Customer name', max_len=80)
    o.customer_phone = s(b.get('customer_phone', o.customer_phone), 'Phone', max_len=20)
    o.address = s(b.get('address', o.address), 'Address', max_len=400)
    o.notes = s(b.get('notes', o.notes), 'Notes', max_len=300)
    o.updated_at = now()
    o.save()
    return order_detail(ctx.rid, o.id)


@endpoint(can('pos'))
def order_move(ctx):
    """Move a running dine-in order to another (free) table."""
    o = get_order(ctx.rid, ctx.params['id'])
    if o.status not in ACTIVE_STATUSES or o.type != 'dine_in':
        raise bad('Only running dine-in orders can be moved.')
    to = DiningTable.objects.filter(id=ctx.body.get('table_id'), restaurant_id=ctx.rid).first()
    if to is None:
        raise not_found('Table not found.')
    if Order.objects.filter(table=to, status__in=ACTIVE_STATUSES).exists():
        raise conflict(f'Table {to.name} already has an order.')
    old_table = o.table_id
    Order.objects.filter(id=o.id).update(table=to, updated_at=now())
    DiningTable.objects.filter(id=to.id).update(status='billed' if o.status == 'billed' else 'occupied', lock_user=ctx.user, lock_at=now())
    DiningTable.objects.filter(id=old_table).update(status='cleaning', lock_user=None, lock_at=None)
    return order_detail(ctx.rid, o.id)


@endpoint(can('cancel_items'))
def item_cancel(ctx):
    item = OrderItem.objects.filter(id=ctx.params['id'], order__restaurant_id=ctx.rid).first()
    if item is None:
        raise not_found('Item not found.')
    o = get_order(ctx.rid, item.order_id)
    if o.status not in ACTIVE_STATUSES:
        raise conflict('This order is already closed.')
    qty = n(ctx.body.get('qty'), 'Quantity', min_v=1, max_v=item.qty, integer=True) or item.qty
    reason = s(ctx.body.get('reason'), 'Reason', max_len=200)
    if qty < item.qty:
        OrderItem.objects.filter(id=item.id).update(qty=item.qty - qty)
        OrderItem.objects.create(order_id=item.order_id, menu_item_id=item.menu_item_id, kot_id=item.kot_id, name=item.name, price=item.price,
                                 qty=qty, veg=item.veg, station=item.station, note=item.note, seat=item.seat, status='cancelled',
                                 cancel_reason=reason, added_by=ctx.user, created_at=now())
    else:
        OrderItem.objects.filter(id=item.id).update(status='cancelled', cancel_reason=reason)
    if item.kot_id and not OrderItem.objects.filter(kot_id=item.kot_id).exclude(status='cancelled').exists():
        Kot.objects.filter(id=item.kot_id).update(status='cancelled')
    recalc_order(o.id, ctx.settings)
    if o.status == 'billed':
        Order.objects.filter(id=o.id).update(status='open')
    return order_detail(ctx.rid, o.id)


@endpoint(can('cancel_items'))
def order_cancel(ctx):
    o = get_order(ctx.rid, ctx.params['id'])
    if o.status not in ACTIVE_STATUSES:
        raise conflict('This order is already closed.')
    if o.paid > 0:
        raise conflict('This order has payments. Refund them before cancelling.')
    reason = s(ctx.body.get('reason'), 'Reason', max_len=200)
    OrderItem.objects.filter(order=o).exclude(status='cancelled').update(status='cancelled', cancel_reason=reason)
    Kot.objects.filter(order=o).exclude(status='served').update(status='cancelled')
    o.status = 'cancelled'
    o.notes = f'{o.notes} Cancelled: {reason}'.strip() if reason else o.notes
    o.updated_at = now()
    o.save()
    if o.table_id:
        DiningTable.objects.filter(id=o.table_id).update(status='free', lock_user=None, lock_at=None)
    return {'ok': True}


@endpoint(can('billing'))
def order_bill(ctx):
    """Print bill (optionally with a discount)."""
    b = ctx.body
    kwargs = {}
    if b.get('discount_value') is not None:
        value = n(b.get('discount_value'), 'Discount', min_v=0, max_v=1e6) or 0
        type_ = one_of(b.get('discount_type'), 'Discount type', ['amount', 'percent'], 'amount')
        if type_ == 'percent' and value > 100:
            raise bad('Discount cannot be more than 100%.')
        o = get_order(ctx.rid, ctx.params['id'])
        if (value != o.discount_value or type_ != o.discount_type) and not has(ctx, 'discounts'):
            raise forbidden('You are not allowed to give discounts.')
        kwargs = {'discount_type': type_, 'discount_value': value}
    generate_bill(ctx, ctx.params['id'], **kwargs)
    return order_detail(ctx.rid, ctx.params['id'])


@endpoint(can('billing'))
def order_pay(ctx):
    """Take payment — one or several methods (split)."""
    payments = ctx.body.get('payments') if isinstance(ctx.body.get('payments'), list) else []
    if not payments:
        raise bad('Choose a payment method.')
    record_payments(ctx, ctx.params['id'], [{'method': str((p or {}).get('method') or ''), 'amount': (p or {}).get('amount'),
                                             'reference': s((p or {}).get('reference'), 'Reference', max_len=120)} for p in payments])
    return order_detail(ctx.rid, ctx.params['id'])


@endpoint(can('billing'), atomic=False)
def order_razorpay(ctx):
    """Collect the balance online with Razorpay (restaurant's own account)."""
    if 'online_payments' not in plan_features(ctx.restaurant.plan_id):
        raise forbidden('Online payments are not part of your plan.', 'PLAN_FEATURE')
    o = get_order(ctx.rid, ctx.params['id'])
    if o.status == 'open':
        o = generate_bill(ctx, o.id)
    if o.status != 'billed':
        raise conflict('This bill cannot take payments.')
    return start_checkout(purpose='order', ref_id=o.id, restaurant_id=ctx.rid, amount=round2(o.total - o.paid), receipt=o.bill_no,
                          keys=restaurant_keys(ctx.settings), notes={'bill_no': o.bill_no, 'restaurant': ctx.restaurant.name})


@endpoint(can('billing'))
def order_razorpay_verify(ctx):
    verify_checkout(gateway_order_id=ctx.body.get('razorpay_order_id'), payment_id=ctx.body.get('razorpay_payment_id'),
                    signature=ctx.body.get('razorpay_signature'), keys=restaurant_keys(ctx.settings), expect_purpose='order',
                    restaurant_id=ctx.rid)
    return order_detail(ctx.rid, ctx.params['id'])


# ---- QR orders awaiting acceptance ----
@endpoint(can('qr_orders'))
def qr_orders(ctx):
    orders = (Order.objects.select_related('table').filter(restaurant_id=ctx.rid, status__in=ACTIVE_STATUSES, items__status='pending')
              .distinct().order_by('updated_at'))
    return [dump(o, table_name=o.table.name if o.table else None,
                 items=[dump(i) for i in o.items.filter(status='pending').order_by('id')]) for o in orders]


@endpoint(can('qr_orders'))
def order_accept(ctx):
    o = get_order(ctx.rid, ctx.params['id'])
    pending = list(o.items.filter(status='pending'))
    if not pending:
        raise conflict('Nothing is waiting for acceptance.')
    ts = now()
    by_station = {}
    for it in pending:
        by_station.setdefault(it.station, []).append(it)
    for station, items in by_station.items():
        k = Kot.objects.create(restaurant_id=ctx.rid, order=o, kot_no=next_counter(ctx.rid, 'kot'), station=station, status='new',
                               created_by=ctx.user, created_at=ts)
        OrderItem.objects.filter(id__in=[i.id for i in items]).update(status='new', kot=k, created_at=ts)
    Order.objects.filter(id=o.id).update(status='open', updated_at=ts)
    Order.objects.filter(id=o.id, captain__isnull=True).update(captain=ctx.user)
    if o.table_id:
        DiningTable.objects.filter(id=o.table_id).update(status='occupied')
    recalc_order(o.id, ctx.settings)
    return order_detail(ctx.rid, o.id)


@endpoint(can('qr_orders'))
def order_reject(ctx):
    o = get_order(ctx.rid, ctx.params['id'])
    o.items.filter(status='pending').update(status='cancelled', cancel_reason=s(ctx.body.get('reason'), 'Reason', max_len=200) or 'Rejected')
    if not o.items.exclude(status='cancelled').exists():
        Order.objects.filter(id=o.id).update(status='cancelled', updated_at=now())
        if o.table_id and not Order.objects.filter(table_id=o.table_id, status__in=ACTIVE_STATUSES).exclude(id=o.id).exists():
            DiningTable.objects.filter(id=o.table_id, status='occupied').update(status='free')
    return {'ok': True}


# ---- Live orders ----
@endpoint(can('live_orders'))
def live_orders(ctx):
    out = []
    for o in Order.objects.select_related('table', 'captain').filter(restaurant_id=ctx.rid, status__in=ACTIVE_STATUSES).order_by('created_at'):
        items = [{'id': i.id, 'name': i.name, 'qty': i.qty, 'price': i.price, 'status': i.status, 'note': i.note} for i in o.items.order_by('id')]
        out.append(dump(o, table_name=o.table.name if o.table else None, captain_name=o.captain.name if o.captain else None,
                        items=items, kitchen_state=kitchen_state(items)))
    return out


# ---- Bills ----
@endpoint(can('bills', 'billing'))
def bills(ctx):
    q = str(ctx.query.get('q') or '').strip()
    qs = Order.objects.select_related('table').filter(restaurant_id=ctx.rid, bill_no__isnull=False)
    if q:
        cond = Q(bill_no__icontains=q) | Q(table__name=q) | Q(customer_phone__icontains=q) | Q(customer_name__icontains=q)
        if q.isdigit():
            cond |= Q(order_no=int(q))
        qs = qs.filter(cond)
    else:
        d_from, d_to, _ = day_bounds(ctx.query.get('date'), ctx.settings['tz_offset_minutes'])
        qs = qs.filter(billed_at__gte=d_from, billed_at__lt=d_to)
    rows = list(qs.order_by('-billed_at')[:300])
    methods = {}
    for oid, m in Payment.objects.filter(order_id__in=[o.id for o in rows]).values_list('order_id', 'method'):
        methods.setdefault(oid, [])
        if m not in methods[oid]:
            methods[oid].append(m)
    out = [{'id': o.id, 'bill_no': o.bill_no, 'order_no': o.order_no, 'type': o.type, 'status': o.status, 'total': o.total, 'paid': o.paid,
            'customer_name': o.customer_name, 'customer_phone': o.customer_phone, 'billed_at': dump(o)['billed_at'],
            'paid_at': dump(o)['paid_at'], 'table_name': o.table.name if o.table else None, 'methods': ','.join(methods.get(o.id, []))}
           for o in rows]
    return {'bills': out, 'total': round2(sum(b['total'] for b in out if b['status'] == 'paid'))}

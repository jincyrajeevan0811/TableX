"""Order engine: KOTs, bill totals, payments and settlement."""
import datetime as dt
import math

from django.db import transaction
from django.db.models import F, FloatField, Sum

from ..models import Counter, DiningTable, Kot, MenuItem, Order, OrderItem, Payment, User
from .http import bad, conflict, dump, not_found
from .util import now, random_digits, round2

ACTIVE_STATUSES = ('awaiting', 'open', 'billed')
PAYMENT_METHODS = ('cash', 'upi', 'card', 'razorpay', 'wallet', 'other')


def next_counter(restaurant_id, key):
    with transaction.atomic():
        row, _ = Counter.objects.select_for_update().get_or_create(restaurant_id_ref=restaurant_id, key=key, defaults={'value': 0})
        Counter.objects.filter(pk=row.pk).update(value=F('value') + 1)
        row.refresh_from_db()
        return row.value


def get_order(rid, order_id):
    o = Order.objects.filter(id=order_id, restaurant_id=rid).first()
    if o is None:
        raise not_found('Order not found.')
    return o


def active_order_for_table(rid, table_id):
    return Order.objects.filter(restaurant_id=rid, table_id=table_id, status__in=ACTIVE_STATUSES).order_by('-id').first()


def recalc_order(order_id, settings):
    o = Order.objects.get(id=order_id)
    s = (OrderItem.objects.filter(order_id=order_id).exclude(status__in=('cancelled', 'pending'))
         .aggregate(v=Sum(F('price') * F('qty'), output_field=FloatField()))['v']) or 0
    subtotal = round2(s)
    discount = subtotal * (o.discount_value or 0) / 100 if o.discount_type == 'percent' else (o.discount_value or 0)
    discount = round2(min(max(discount, 0), subtotal))
    taxable = subtotal - discount
    svc_pct = float(settings.get('service_charge_percent') or 0)
    service = round2(taxable * svc_pct / 100) if o.type == 'dine_in' and svc_pct > 0 else 0
    tax = round2((taxable + service) * float(settings.get('gst_percent') or 0) / 100) if settings.get('gst_enabled') else 0
    delivery_fee = round2(o.delivery_fee or 0) if o.type == 'delivery' and subtotal > 0 else 0
    gross = round2(taxable + service + tax + delivery_fee)
    total = math.floor(gross + 0.5) if settings.get('round_off') else gross
    o.subtotal, o.discount, o.service_charge, o.tax = subtotal, discount, service, tax
    o.round_off, o.total, o.updated_at = round2(total - gross), float(total), now()
    o.save(update_fields=['subtotal', 'discount', 'service_charge', 'tax', 'round_off', 'total', 'updated_at'])
    return o


def create_order(ctx, *, type, table_id=None, source='pos', status='open', customer=None, settings=None):
    customer = customer or {}
    settings = settings or ctx.settings
    is_delivery = type == 'delivery'
    ts = now()
    return Order.objects.create(
        restaurant_id=ctx.rid, order_no=next_counter(ctx.rid, 'order'), type=type, source=source, table_id=table_id,
        status=status, customer_name=customer.get('name') or '', customer_phone=customer.get('phone') or '',
        address=customer.get('address') or '', notes=customer.get('notes') or '',
        captain_id=ctx.user.id if ctx.user else None,
        delivery_status='pending' if is_delivery else None, delivery_otp=random_digits(4) if is_delivery else None,
        delivery_fee=float(settings.get('delivery_fee') or 0) if is_delivery else 0,
        cod=customer.get('cod') is not False, created_at=ts, updated_at=ts,
    )


def _load_lines(rid, items):
    if not isinstance(items, list) or not items:
        raise bad('Add at least one item.')
    if len(items) > 200:
        raise bad('Too many items in one ticket.')
    lines = []
    for it in items:
        it = it if isinstance(it, dict) else {}
        try:
            mid = int(it.get('menu_item_id'))
        except (TypeError, ValueError):
            mid = None
        mi = MenuItem.objects.filter(id=mid, restaurant_id=rid).first() if mid else None
        if mi is None:
            raise bad('One of the items is no longer on the menu. Please refresh.')
        try:
            qty = math.floor(float(it.get('qty')))
        except (TypeError, ValueError):
            qty = 0
        if qty < 1 or qty > 999:
            raise bad(f'Quantity for {mi.name} is not valid.')
        lines.append({'mi': mi, 'qty': qty, 'note': str(it.get('note') or '')[:200], 'seat': str(it.get('seat') or '')[:20]})
    return lines


def send_kot(ctx, *, order_id=None, table_id=None, type='dine_in', customer=None, items=None, client_key=None, force=False):
    """Add items to an order (creating it when needed), one ticket per kitchen station.
    `client_key` makes the call idempotent so offline re-syncs never double-enter."""
    rid = ctx.rid
    customer = customer or {}
    with transaction.atomic():
        if client_key:
            prior = Kot.objects.filter(restaurant_id=rid, client_key=client_key).first()
            if prior:
                return Order.objects.get(id=prior.order_id), True
        lines = _load_lines(rid, items)
        order = None
        if order_id:
            order = get_order(rid, order_id)
            if order.status not in ACTIVE_STATUSES:
                raise conflict('This order is already closed.', 'ORDER_CLOSED')
        elif type == 'dine_in':
            if not table_id:
                raise bad('Choose a table.')
            table = DiningTable.objects.filter(id=table_id, restaurant_id=rid).first()
            if table is None:
                raise not_found('Table not found.')
            order = active_order_for_table(rid, table.id)

        if order and not force:
            since = now() - dt.timedelta(seconds=120)
            recent = list(OrderItem.objects.filter(order=order, created_at__gte=since).exclude(status__in=('cancelled', 'pending'))
                          .values('menu_item_id', 'qty', 'added_by_id'))
            dupes = [ln for ln in lines if any(r['menu_item_id'] == ln['mi'].id and r['qty'] == ln['qty'] for r in recent)]
            if recent and len(dupes) == len(lines):
                hit = next((r for r in recent if r['menu_item_id'] == dupes[0]['mi'].id), None)
                by = User.objects.filter(id=hit['added_by_id']).values_list('name', flat=True).first() if hit else None
                by = by or 'someone'
                raise conflict(f'Already added — these items were already added to this order by {by} a moment ago.',
                               'DUPLICATE_ITEMS', {'items': [f"{d['qty']} × {d['mi'].name}" for d in dupes], 'by': by})

        if order is None:
            if type == 'delivery' and not str(customer.get('phone') or '').strip():
                raise bad('Customer mobile number is required for delivery.')
            if type == 'delivery' and not str(customer.get('address') or '').strip():
                raise bad('Delivery address is required.')
            order = create_order(ctx, type=type, table_id=table_id if type == 'dine_in' else None, customer=customer)

        ts = now()
        by_station = {}
        for ln in lines:
            by_station.setdefault(ln['mi'].station or 'Main Kitchen', []).append(ln)
        for station, group in by_station.items():
            kot = Kot.objects.create(restaurant_id=rid, order=order, kot_no=next_counter(rid, 'kot'), station=station,
                                     status='new', client_key=client_key or None, created_by=ctx.user, created_at=ts)
            OrderItem.objects.bulk_create([OrderItem(
                order=order, menu_item_id=ln['mi'].id, kot=kot, name=ln['mi'].name, price=ln['mi'].price, qty=ln['qty'],
                veg=ln['mi'].veg, station=station, note=ln['note'], seat=ln['seat'], status='new', added_by=ctx.user, created_at=ts,
            ) for ln in group])
        # Adding items to a printed bill re-opens it so the bill is regenerated with the new items.
        Order.objects.filter(id=order.id).update(status='open', updated_at=ts)
        Order.objects.filter(id=order.id, captain__isnull=True).update(captain=ctx.user)
        if order.table_id:
            DiningTable.objects.filter(id=order.table_id).update(status='occupied')
        return recalc_order(order.id, ctx.settings), False


def generate_bill(ctx, order_id, discount_type=None, discount_value=None):
    with transaction.atomic():
        order = get_order(ctx.rid, order_id)
        if order.status not in ('open', 'billed'):
            raise conflict('Only running orders can be billed.', 'ORDER_CLOSED')
        if discount_type is not None:
            Order.objects.filter(id=order.id).update(discount_type=discount_type, discount_value=discount_value or 0)
        o = recalc_order(order.id, ctx.settings)
        if o.subtotal <= 0:
            raise bad('There is nothing to bill yet.')
        ts = now()
        o.bill_no = o.bill_no or f"TX{next_counter(ctx.rid, 'bill'):05d}"
        o.status = 'billed'
        o.billed_at = o.billed_at or ts
        o.updated_at = ts
        o.save(update_fields=['bill_no', 'status', 'billed_at', 'updated_at'])
        if o.table_id:
            DiningTable.objects.filter(id=o.table_id).update(status='billed')
        return o


def record_payments(ctx, order_id, payments, received_by=None):
    """Record one or more payments (split supported). Settles the order when fully paid."""
    with transaction.atomic():
        order = get_order(ctx.rid, order_id)
        if order.status == 'paid':
            raise conflict('This bill is already paid.', 'ALREADY_PAID')
        if order.status not in ('open', 'billed'):
            raise conflict('This order cannot take payments.', 'ORDER_CLOSED')
        if order.status == 'open':
            order = generate_bill(ctx, order.id)
        ts = now()
        added = 0.0
        receiver_id = received_by if received_by is not None else (ctx.user.id if ctx.user else None)
        for p in payments:
            try:
                amount = round2(float(p.get('amount')))
            except (TypeError, ValueError):
                amount = 0
            if not amount > 0:
                continue
            if p.get('method') not in PAYMENT_METHODS:
                raise bad('Choose a valid payment method.')
            Payment.objects.create(restaurant_id=ctx.rid, order=order, method=p['method'], amount=amount,
                                   reference=str(p.get('reference') or '')[:120], received_by_id=receiver_id, created_at=ts)
            added += amount
        if added <= 0:
            raise bad('Enter the amount received.')
        paid = round2((order.paid or 0) + added)
        if paid > order.total + 0.005:
            raise bad(f'Payment is more than the bill. Balance due is ₹{round2(order.total - order.paid):g}.')
        Order.objects.filter(id=order.id).update(paid=paid, updated_at=ts)
        if paid >= order.total - 0.005:
            settle_order(order.id)
        return Order.objects.get(id=order.id)


def settle_order(order_id):
    ts = now()
    o = Order.objects.get(id=order_id)
    Order.objects.filter(id=order_id).update(status='paid', paid_at=ts, updated_at=ts)
    if o.table_id:
        other = Order.objects.filter(table_id=o.table_id, status__in=ACTIVE_STATUSES).exclude(id=order_id).exists()
        if not other:
            DiningTable.objects.filter(id=o.table_id).update(status='free', lock_user=None, lock_at=None)


def _names(ids):
    ids = {i for i in ids if i}
    return dict(User.objects.filter(id__in=ids).values_list('id', 'name')) if ids else {}


def order_detail(rid, order_id):
    o = Order.objects.select_related('table', 'captain', 'rider').filter(id=order_id, restaurant_id=rid).first()
    if o is None:
        raise not_found('Order not found.')
    items = list(OrderItem.objects.filter(order=o).select_related('kot').order_by('id'))
    pays = list(Payment.objects.filter(order=o).order_by('id'))
    names = _names([i.added_by_id for i in items] + [p.received_by_id for p in pays])
    return dump(
        o,
        table_name=o.table.name if o.table else None,
        captain_name=o.captain.name if o.captain else None,
        rider_name=o.rider.name if o.rider else None,
        rider_phone=o.rider.phone if o.rider else None,
        items=[dump(i, kot_no=i.kot.kot_no if i.kot else None, added_by_name=names.get(i.added_by_id)) for i in items],
        payments=[dump(p, received_by_name=names.get(p.received_by_id)) for p in pays],
        kots=[dump(k) for k in Kot.objects.filter(order=o).order_by('id')],
        balance=round2(o.total - o.paid),
    )


def kitchen_state(items):
    live = [i for i in items if i['status'] != 'cancelled']
    if not live:
        return 'empty'
    if any(i['status'] == 'pending' for i in live):
        return 'awaiting'
    if any(i['status'] in ('new', 'preparing') for i in live):
        return 'in_kitchen'
    if any(i['status'] == 'ready' for i in live):
        return 'ready'
    return 'served'

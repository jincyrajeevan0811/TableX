"""Guest QR ordering API (no login): /api/public/t/<table token>/…"""
import datetime as dt
import math
from types import SimpleNamespace

from django.conf import settings as dj

from ..lib.auth import rate_limit, restaurant_settings, subscription_state
from ..lib.gateway import restaurant_keys, start_checkout, verify_checkout
from ..lib.http import HttpError, bad, conflict, dump, endpoint, not_found
from ..lib.orders import active_order_for_table, create_order, generate_bill, recalc_order
from ..lib.permissions import plan_features
from ..lib.razorpay import is_configured
from ..lib.util import now, round2, s
from ..models import Category, DiningTable, MenuItem, Notification, Order, OrderItem


def guest(token):
    table = DiningTable.objects.select_related('restaurant').filter(qr_token=str(token)).first()
    if table is None:
        raise not_found('This QR code is not valid any more. Please ask the staff for help.')
    restaurant = table.restaurant
    settings = restaurant_settings(restaurant)
    features = plan_features(restaurant.plan_id)
    sub = subscription_state(restaurant)
    ordering, reason = True, None
    if not sub['active']:
        ordering, reason = False, 'Online ordering is not available right now. Please order with the staff.'
    elif 'qr_ordering' not in features:
        ordering, reason = False, 'Please order with the staff.'
    elif not settings.get('online_ordering'):
        ordering, reason = False, 'Online ordering is switched off right now. Please order with the staff.'
    pay_online = sub['active'] and 'online_payments' in features and (is_configured(restaurant_keys(settings)) or dj.TABLEX['ALLOW_DEMO_PAYMENTS'])
    return SimpleNamespace(table=table, restaurant=restaurant, settings=settings, ordering=ordering, reason=reason, pay_online=pay_online,
                           ctx=SimpleNamespace(rid=restaurant.id, restaurant=restaurant, settings=settings, user=None))


def table_status(g):
    order = active_order_for_table(g.restaurant.id, g.table.id)
    if order is None:
        return {'order': None}
    items = [{'id': i.id, 'name': i.name, 'qty': i.qty, 'price': i.price, 'veg': int(i.veg), 'status': i.status}
             for i in order.items.exclude(status='cancelled').order_by('id')]
    return {'order': {'id': order.id, 'order_no': order.order_no, 'status': order.status, 'bill_no': order.bill_no, 'subtotal': order.subtotal,
                      'discount': order.discount, 'service_charge': order.service_charge, 'tax': order.tax, 'round_off': order.round_off,
                      'total': order.total, 'paid': order.paid, 'balance': round2(order.total - order.paid), 'items': items}}


@endpoint()
def menu(ctx):
    g = guest(ctx.params['token'])
    st = g.settings
    return {
        'restaurant': {'name': g.restaurant.name, 'address': g.restaurant.address, 'phone': g.restaurant.phone, 'city': g.restaurant.city},
        'table': {'name': g.table.name, 'area': g.table.area},
        'ordering': g.ordering, 'reason': g.reason, 'pay_online': g.pay_online,
        'charges': {'service_charge_percent': st['service_charge_percent'], 'gst_enabled': st['gst_enabled'], 'gst_percent': st['gst_percent']},
        'categories': [{'id': c.id, 'name': c.name} for c in Category.objects.filter(restaurant=g.restaurant).order_by('sort', 'name')],
        'items': [{'id': i.id, 'category_id': i.category_id, 'name': i.name, 'description': i.description, 'price': i.price, 'veg': int(i.veg)}
                  for i in MenuItem.objects.filter(restaurant=g.restaurant, available=True).order_by('name')],
        **table_status(g),
    }


@endpoint()
def status(ctx):
    return table_status(guest(ctx.params['token']))


@endpoint()
def place_order(ctx):
    """Guest places an order — it waits in 'Awaiting acceptance' until staff accept it."""
    g = guest(ctx.params['token'])
    if not g.ordering:
        raise HttpError(403, g.reason, 'ORDERING_OFF')
    rate_limit(f'qr:{ctx.ip}:{g.table.id}', 12, 600)
    items = ctx.body.get('items') if isinstance(ctx.body.get('items'), list) else []
    if not items or len(items) > 50:
        raise bad('Add items to your order.')
    lines = []
    for it in items:
        it = it if isinstance(it, dict) else {}
        try:
            mid = int(it.get('menu_item_id'))
            qty = math.floor(float(it.get('qty')))
        except (TypeError, ValueError):
            raise bad('Please check the quantities.')
        mi = MenuItem.objects.filter(id=mid, restaurant=g.restaurant, available=True).first()
        if mi is None:
            raise bad('Some items are not available any more. Please refresh the menu.', 'ITEM_UNAVAILABLE')
        if not 1 <= qty <= 30:
            raise bad('Please check the quantities.')
        lines.append((mi, qty, str(it.get('note') or '')[:120]))
    name = s(ctx.body.get('name'), 'Name', max_len=60)
    phone = s(ctx.body.get('phone'), 'Phone', max_len=15)
    order = active_order_for_table(g.restaurant.id, g.table.id)
    if order and order.status == 'billed':
        raise conflict('Your bill is already printed. Please ask the staff to add more items.', 'BILLED')
    if order is None:
        order = create_order(g.ctx, type='dine_in', table_id=g.table.id, source='qr', status='awaiting', customer={'name': name, 'phone': phone})
        DiningTable.objects.filter(id=g.table.id).update(status='occupied')
    elif name or phone:
        order.customer_name = order.customer_name or name
        order.customer_phone = order.customer_phone or phone
        order.save(update_fields=['customer_name', 'customer_phone'])
    ts = now()
    OrderItem.objects.bulk_create([OrderItem(order=order, menu_item_id=mi.id, name=mi.name, price=mi.price, qty=qty, veg=mi.veg,
                                             station=mi.station, note=note, status='pending', created_at=ts) for mi, qty, note in lines])
    Order.objects.filter(id=order.id).update(updated_at=ts)
    Notification.objects.create(restaurant=g.restaurant, type='qr_order', title=f'New QR order — {g.table.name}',
                                body=', '.join(f'{q} × {mi.name}' for mi, q, _ in lines), table=g.table, order=order, created_at=ts)
    recalc_order(order.id, g.settings)
    return {'ok': True, 'order_id': order.id, **table_status(g)}


@endpoint()
def call_waiter(ctx):
    g = guest(ctx.params['token'])
    reason = ctx.body.get('reason') if ctx.body.get('reason') in ('waiter', 'bill', 'water') else 'waiter'
    if Notification.objects.filter(table=g.table, type='call_waiter', created_at__gt=now() - dt.timedelta(seconds=30)).exists():
        return {'ok': True, 'throttled': True}
    label = {'waiter': 'is calling a waiter', 'bill': 'is asking for the bill', 'water': 'needs water'}[reason]
    Notification.objects.create(restaurant=g.restaurant, type='call_waiter', title=f'Table {g.table.name} {label}', table=g.table, created_at=now())
    return {'ok': True}


@endpoint(atomic=False)
def pay(ctx):
    """Guest pays the table's balance online with Razorpay (restaurant's own account)."""
    g = guest(ctx.params['token'])
    if not g.pay_online:
        raise HttpError(403, 'Online payment is not available. Please pay at the counter.', 'PAY_OFF')
    order = active_order_for_table(g.restaurant.id, g.table.id)
    if order and order.items.filter(status='pending').exists():
        raise conflict('Some items are still waiting for the staff to accept. Please try again in a moment.')
    if order is None or order.subtotal <= 0:
        raise bad('There is no bill to pay yet.')
    if order.status == 'open':
        order = generate_bill(g.ctx, order.id)
    co = start_checkout(purpose='order', ref_id=order.id, restaurant_id=g.restaurant.id, amount=round2(order.total - order.paid),
                        receipt=order.bill_no, keys=restaurant_keys(g.settings), notes={'bill_no': order.bill_no, 'table': g.table.name})
    return {**co, 'name': g.restaurant.name, 'description': f'Bill {order.bill_no} — Table {g.table.name}'}


@endpoint()
def pay_verify(ctx):
    g = guest(ctx.params['token'])
    verify_checkout(gateway_order_id=ctx.body.get('razorpay_order_id'), payment_id=ctx.body.get('razorpay_payment_id'),
                    signature=ctx.body.get('razorpay_signature'), keys=restaurant_keys(g.settings), expect_purpose='order', restaurant_id=g.restaurant.id)
    return {'ok': True, **table_status(g)}

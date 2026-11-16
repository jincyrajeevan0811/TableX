"""Glue between Razorpay and what a payment is for (restaurant bills / subscriptions)."""
from types import SimpleNamespace

from django.conf import settings as dj
from django.db import transaction

from ..models import GatewayOrder, Order, Restaurant, Subscription
from . import razorpay
from .auth import restaurant_settings
from .http import HttpError, bad, not_found
from .orders import record_payments
from .subscriptions import activate_subscription
from .util import now, round2


def platform_keys():
    return {'key_id': dj.TABLEX['RAZORPAY_KEY_ID'], 'key_secret': dj.TABLEX['RAZORPAY_KEY_SECRET']}


def restaurant_keys(settings):
    return {'key_id': settings.get('razorpay_key_id', ''), 'key_secret': settings.get('razorpay_key_secret', '')}


def start_checkout(*, purpose, ref_id, restaurant_id, amount, receipt, keys, notes=None):
    order = razorpay.create_order(keys, amount, receipt, notes, allow_demo=dj.TABLEX['ALLOW_DEMO_PAYMENTS'])
    GatewayOrder.objects.create(gateway_order_id=order['id'], purpose=purpose, ref_id=ref_id, restaurant_id=restaurant_id,
                                amount=amount, status='created', demo=order['demo'], created_at=now())
    return {'key_id': 'demo' if order['demo'] else keys['key_id'], 'order_id': order['id'], 'amount': order['amount'],
            'currency': order['currency'], 'demo': order['demo']}


def apply_payment(gw, payment_id):
    """Apply a captured payment exactly once (checkout callback and webhook may both arrive)."""
    with transaction.atomic():
        fresh = GatewayOrder.objects.select_for_update().get(id=gw.id)
        if fresh.status == 'paid':
            return {'already': True}
        GatewayOrder.objects.filter(id=gw.id).update(status='paid', payment_id=payment_id)
        if gw.purpose == 'order':
            restaurant = Restaurant.objects.get(id=gw.restaurant_id)
            ctx = SimpleNamespace(rid=restaurant.id, restaurant=restaurant, settings=restaurant_settings(restaurant), user=None)
            order = Order.objects.filter(id=gw.ref_id).first()
            if order and order.status != 'paid':
                due = round2(order.total - order.paid)
                record_payments(ctx, order.id, [{'method': 'razorpay', 'amount': min(due, gw.amount), 'reference': payment_id}])
        elif gw.purpose == 'subscription':
            sub = Subscription.objects.filter(id=gw.ref_id).first()
            if sub and sub.status == 'pending':
                activate_subscription(restaurant_id=sub.restaurant_id, plan_id=sub.plan_id, cycle=sub.cycle, amount=sub.amount,
                                      source='demo' if gw.demo else 'razorpay', subscription_id=sub.id,
                                      razorpay_order_id=gw.gateway_order_id, razorpay_payment_id=payment_id)
        return {'already': False}


def verify_checkout(*, gateway_order_id, payment_id, signature, keys, expect_purpose, restaurant_id=None):
    gw = GatewayOrder.objects.filter(gateway_order_id=str(gateway_order_id or '')).first()
    if gw is None or gw.purpose != expect_purpose or (restaurant_id and gw.restaurant_id != restaurant_id):
        raise not_found('Payment not found.')
    if gw.demo:
        if not dj.TABLEX['ALLOW_DEMO_PAYMENTS']:
            raise HttpError(400, 'Demo payments are disabled.', 'DEMO_DISABLED')
        return apply_payment(gw, payment_id or f'demo_pay_{gw.id}')
    if not payment_id or not signature:
        raise bad('Payment details are missing.')
    if not razorpay.verify_payment_signature(keys['key_secret'], gw.gateway_order_id, payment_id, signature):
        raise bad('Payment could not be verified. If money was deducted it will be refunded by Razorpay.', 'SIGNATURE_MISMATCH')
    return apply_payment(gw, payment_id)

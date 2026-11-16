import json

from django.conf import settings as dj

from ..lib.auth import can
from ..lib.gateway import apply_payment, platform_keys, start_checkout, verify_checkout
from ..lib.http import bad, dump, endpoint, json_response
from ..lib.permissions import FEATURES
from ..lib.razorpay import verify_webhook_signature
from ..lib.util import iso, now, one_of
from ..models import DiningTable, GatewayOrder, MenuItem, Plan, Restaurant, Subscription, User


@endpoint(can('subscription'))
def subscription(ctx):
    r = ctx.restaurant
    plan = Plan.objects.filter(id=r.plan_id).first() if r.plan_id else None
    t = dj.TABLEX
    return {
        'current': {'plan': dump(plan, exclude=('features',), bool_int=False) if plan else None, 'ends_at': iso(r.subscription_ends_at),
                    'active': ctx.subscription['active'], 'reason': ctx.subscription.get('reason')},
        'plans': [dump(p, bool_int=False) for p in Plan.objects.filter(active=True).order_by('sort', 'id')],
        'features': FEATURES,
        'history': [dump(x, plan_name=x.plan.name) for x in Subscription.objects.select_related('plan').filter(restaurant=r)
                    .exclude(status='pending').order_by('-id')[:50]],
        'usage': {'tables': DiningTable.objects.filter(restaurant=r).count(),
                  'staff': User.objects.filter(restaurant=r, is_active=True).count(),
                  'menu_items': MenuItem.objects.filter(restaurant=r).count()},
        'demo': not (t['RAZORPAY_KEY_ID'] and t['RAZORPAY_KEY_SECRET']),
    }


@endpoint(can('subscription'), atomic=False)
def checkout(ctx):
    """Buy / renew / change plan through Razorpay (platform account)."""
    try:
        plan = Plan.objects.filter(id=int(ctx.body.get('plan_id')), active=True).first()
    except (TypeError, ValueError):
        plan = None
    if plan is None:
        raise bad('Choose a plan.')
    cycle = one_of(ctx.body.get('cycle'), 'Billing cycle', ['monthly', 'yearly'], 'monthly')
    amount = plan.price_yearly if cycle == 'yearly' else plan.price_monthly
    if not amount > 0:
        raise bad('This plan has no price for that billing cycle.')
    sub = Subscription.objects.create(restaurant=ctx.restaurant, plan=plan, cycle=cycle, amount=amount, status='pending',
                                      source='razorpay', created_by=ctx.user, created_at=now())
    co = start_checkout(purpose='subscription', ref_id=sub.id, restaurant_id=ctx.rid, amount=amount, receipt=f'sub_{sub.id}',
                        keys=platform_keys(), notes={'restaurant': ctx.restaurant.name, 'plan': plan.name, 'cycle': cycle})
    Subscription.objects.filter(id=sub.id).update(razorpay_order_id=co['order_id'])
    return {**co, 'name': 'TableX', 'description': f'{plan.name} plan — {cycle}',
            'prefill': {'name': ctx.user.name, 'email': ctx.user.email or '', 'contact': ctx.user.phone or ''}}


@endpoint(can('subscription'))
def verify(ctx):
    verify_checkout(gateway_order_id=ctx.body.get('razorpay_order_id'), payment_id=ctx.body.get('razorpay_payment_id'),
                    signature=ctx.body.get('razorpay_signature'), keys=platform_keys(), expect_purpose='subscription', restaurant_id=ctx.rid)
    r = Restaurant.objects.get(id=ctx.rid)
    return {'ok': True, 'ends_at': iso(r.subscription_ends_at), 'plan_id': r.plan_id}


@endpoint()
def webhook(ctx):
    """Razorpay webhook (events payment.captured / order.paid). Subscription payments are verified with the platform
    webhook secret; guest bill payments with that restaurant's own webhook secret (Settings → Online payments)."""
    try:
        payload = json.loads(ctx.raw_body.decode('utf-8') or '{}')
    except ValueError:
        payload = {}
    entity = ((payload.get('payload') or {}).get('payment') or {}).get('entity') or {}
    gw = GatewayOrder.objects.filter(gateway_order_id=entity.get('order_id')).first() if entity.get('order_id') else None
    secret = dj.TABLEX['RAZORPAY_WEBHOOK_SECRET']
    if gw and gw.purpose == 'order':
        rest = Restaurant.objects.filter(id=gw.restaurant_id).first()
        secret = (rest.settings or {}).get('razorpay_webhook_secret', '') if rest else ''
    signature = ctx.request.META.get('HTTP_X_RAZORPAY_SIGNATURE', '')
    if not verify_webhook_signature(secret, ctx.raw_body, signature):
        return json_response({'error': 'Invalid signature.'}, 400)
    if gw and payload.get('event') in ('payment.captured', 'order.paid') and entity.get('status') == 'captured':
        apply_payment(gw, entity.get('id'))
    return {'ok': True}

import datetime as dt

from django.db import transaction

from ..models import Restaurant, Subscription
from .util import now


def cycle_days(cycle):
    return 365 if cycle == 'yearly' else 30


def activate_subscription(*, restaurant_id, plan_id, cycle='monthly', periods=1, days=None, amount=0, source='manual',
                          subscription_id=None, razorpay_order_id=None, razorpay_payment_id=None, note='', created_by=None):
    """Activate or extend a plan. Renewing the same plan early stacks time on the current end date."""
    with transaction.atomic():
        r = Restaurant.objects.select_for_update().get(id=restaurant_id)
        ts = now()
        same_plan_active = bool(r.subscription_ends_at and r.subscription_ends_at > ts and r.plan_id == plan_id)
        start = r.subscription_ends_at if same_plan_active else ts
        end = start + dt.timedelta(days=days if days is not None else cycle_days(cycle) * periods)
        if subscription_id:
            sub = Subscription.objects.get(id=subscription_id)
            sub.status, sub.starts_at, sub.ends_at = 'active', start, end
            sub.razorpay_payment_id, sub.source = razorpay_payment_id, source
            sub.save(update_fields=['status', 'starts_at', 'ends_at', 'razorpay_payment_id', 'source'])
        else:
            sub = Subscription.objects.create(
                restaurant_id=restaurant_id, plan_id=plan_id, cycle=cycle, amount=amount, status='active', source=source,
                starts_at=start, ends_at=end, razorpay_order_id=razorpay_order_id, razorpay_payment_id=razorpay_payment_id,
                note=note, created_by_id=created_by, created_at=ts,
            )
        if not same_plan_active:
            Subscription.objects.filter(restaurant_id=restaurant_id, status='active').exclude(id=sub.id).update(status='replaced')
        Restaurant.objects.filter(id=restaurant_id).update(plan_id=plan_id, subscription_ends_at=end)
        return sub

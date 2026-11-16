import datetime as dt

from django.db.models import Count, F, FloatField, Sum

from ..lib.auth import can
from ..lib.http import bad, endpoint
from ..lib.util import day_bounds, local_date, round2
from ..models import Order, OrderItem, Payment


def _paid(ctx, d_from, d_to):
    return Order.objects.filter(restaurant_id=ctx.rid, status='paid', paid_at__gte=d_from, paid_at__lt=d_to)


@endpoint(can('reports'))
def daily_items(ctx):
    """Every item sold that day, totals, discounts, net sales and payment split."""
    d_from, d_to, date = day_bounds(ctx.query.get('date'), ctx.settings['tz_offset_minutes'])
    orders = _paid(ctx, d_from, d_to)
    items = [{'name': x['name'], 'qty': x['q'], 'orders': x['n_orders'], 'amount': round2(x['amt'])} for x in
             OrderItem.objects.filter(order__in=orders).exclude(status__in=('cancelled', 'pending')).values('name')
             .annotate(amt=Sum(F('qty') * F('price'), output_field=FloatField()), q=Sum('qty'), n_orders=Count('order', distinct=True))
             .order_by('-amt')]
    t = orders.aggregate(orders=Count('id'), gross=Sum('subtotal'), discount=Sum('discount'), service_charge=Sum('service_charge'),
                         tax=Sum('tax'), delivery_fee=Sum('delivery_fee'), round_off=Sum('round_off'), net=Sum('total'))
    totals = {k: (v or 0) if k == 'orders' else round2(v or 0) for k, v in t.items()}
    totals['quantity'] = sum(i['qty'] for i in items)
    methods = [{'method': m['method'], 'amount': round2(m['amt']), 'count': m['cnt']} for m in
               Payment.objects.filter(order__in=orders).values('method').annotate(amt=Sum('amount'), cnt=Count('id')).order_by('-amt')]
    by_type = [{'type': x['type'], 'orders': x['orders'], 'amount': round2(x['amount'] or 0)} for x in
               orders.values('type').annotate(orders=Count('id'), amount=Sum('total'))]
    cancelled = OrderItem.objects.filter(order__restaurant_id=ctx.rid, status='cancelled', created_at__gte=d_from, created_at__lt=d_to)
    c = cancelled.aggregate(c=Count('id'), v=Sum(F('qty') * F('price'), output_field=FloatField()))
    open_orders = Order.objects.filter(restaurant_id=ctx.rid, status__in=('open', 'billed', 'awaiting')).count()
    return {'date': date, 'items': items, 'totals': totals, 'methods': methods, 'byType': by_type,
            'cancelled': {'c': c['c'] or 0, 'v': round2(c['v'] or 0)}, 'open_orders': open_orders}


@endpoint(can('reports'))
def summary(ctx):
    """Sales across a date range (max 92 days)."""
    off = ctx.settings['tz_offset_minutes']
    to_from, to_to, to_date = day_bounds(ctx.query.get('to'), off)
    if ctx.query.get('from'):
        f_from, _, f_date = day_bounds(ctx.query['from'], off)
    else:
        f_from, _, f_date = day_bounds((dt.date.fromisoformat(to_date) - dt.timedelta(days=29)).isoformat(), off)
    span = (to_to - f_from).total_seconds() / 86400
    if span < 1 or span > 92:
        raise bad('Choose a range of up to 92 days.')
    orders = Order.objects.filter(restaurant_id=ctx.rid, status='paid', paid_at__gte=f_from, paid_at__lt=to_to)
    days = {}
    cur = f_from
    while cur < to_to:
        d = local_date(cur, off)
        days[d] = {'date': d, 'orders': 0, 'total': 0}
        cur += dt.timedelta(days=1)
    hours = [{'hour': h, 'orders': 0} for h in range(24)]
    for o in orders.only('paid_at', 'total'):
        d = days.get(local_date(o.paid_at, off))
        if d:
            d['orders'] += 1
            d['total'] = round2(d['total'] + o.total)
        hours[(o.paid_at.astimezone(dt.timezone.utc) + dt.timedelta(minutes=off)).hour]['orders'] += 1
    series = list(days.values())
    total = round2(sum(d['total'] for d in series))
    count = sum(d['orders'] for d in series)
    categories = [{'name': x['menu_cat'] or 'Other', 'amount': round2(x['amount'])} for x in _categories(ctx.rid, orders)]
    staff = [{'name': x['captain__name'], 'orders': x['orders'], 'amount': round2(x['amount'] or 0)} for x in
             orders.filter(captain__isnull=False).values('captain__name').annotate(orders=Count('id'), amount=Sum('total')).order_by('-amount')[:8]]
    return {'from': f_date, 'to': to_date, 'series': series, 'total': total, 'orders': count, 'avg': round2(total / count) if count else 0,
            'categories': categories, 'staff': staff, 'hours': hours}


def _categories(rid, orders):
    from ..models import MenuItem
    cat_of = dict(MenuItem.objects.filter(restaurant_id=rid).values_list('id', 'category__name'))
    agg = {}
    for mid, amount in (OrderItem.objects.filter(order__in=orders).exclude(status__in=('cancelled', 'pending'))
                        .values('menu_item_id').annotate(a=Sum(F('qty') * F('price'), output_field=FloatField())).values_list('menu_item_id', 'a')):
        name = cat_of.get(mid) or 'Other'
        agg[name] = agg.get(name, 0) + (amount or 0)
    return sorted(({'menu_cat': k, 'amount': v} for k, v in agg.items()), key=lambda x: -x['amount'])[:8]

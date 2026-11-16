"""Super Admin: plans, restaurants (onboarding, access, subscriptions, roles), purchases."""
import datetime as dt

from django.conf import settings as dj
from django.db.models import Count, Q, Sum

from ..lib.auth import DEFAULT_SETTINGS, super_admin_only
from ..lib.http import bad, conflict, dump, endpoint, not_found
from ..lib.permissions import (DEFAULT_ROLE_PERMISSIONS, FEATURE_KEYS, FEATURES, PERMISSIONS, ROLE_KEYS, ROLES, has_custom,
                               role_permissions, save_role_permissions)
from ..lib.subscriptions import activate_subscription
from ..lib.util import iso, n, normalize_phone, now, one_of, random_token, round2, s, slugify
from ..models import AuthSession, DiningTable, Order, Plan, Restaurant, Subscription, User


def plan_out(p, **extra):
    return dump(p, bool_int=False, features=list(p.features or []), **extra)


def plan_input(b):
    features = [f for f in (b.get('features') or []) if f in FEATURE_KEYS] if isinstance(b.get('features'), list) else []
    return {
        'name': s(b.get('name'), 'Plan name', required=True, max_len=60),
        'code': slugify(b.get('code') or b.get('name')),
        'description': s(b.get('description'), 'Description', max_len=300),
        'price_monthly': n(b.get('price_monthly'), 'Monthly price', required=True, min_v=0, max_v=1e7),
        'price_yearly': n(b.get('price_yearly'), 'Yearly price', min_v=0, max_v=1e8) or 0,
        'max_tables': n(b.get('max_tables'), 'Max tables', required=True, min_v=1, max_v=10000, integer=True),
        'max_staff': n(b.get('max_staff'), 'Max staff', required=True, min_v=1, max_v=10000, integer=True),
        'max_menu_items': n(b.get('max_menu_items'), 'Max menu items', min_v=1, max_v=100000, integer=True) or 500,
        'features': features,
        'highlight': bool(b.get('highlight')),
        'active': b.get('active') is not False,
        'sort': n(b.get('sort'), 'Sort', min_v=0, max_v=1000, integer=True) or 0,
    }


def unique_slug(name):
    base = slugify(name)
    slug, i = base, 2
    while Restaurant.objects.filter(slug=slug).exists():
        slug, i = f'{base}-{i}', i + 1
    return slug


@endpoint(super_admin_only)
def meta(ctx):
    t = dj.TABLEX
    return {'permissions': PERMISSIONS, 'features': FEATURES, 'roles': ROLES, 'defaults': DEFAULT_ROLE_PERMISSIONS,
            'razorpayConfigured': bool(t['RAZORPAY_KEY_ID'] and t['RAZORPAY_KEY_SECRET']), 'trialDays': t['TRIAL_DAYS']}


@endpoint(super_admin_only)
def stats(ctx):
    ts = now()
    rs = Restaurant.objects.all()
    restaurants = {
        'total': rs.count(),
        'live': rs.filter(status='active', subscription_ends_at__gt=ts).count(),
        'suspended': rs.filter(status='suspended').count(),
        'lapsed': rs.filter(Q(subscription_ends_at__isnull=True) | Q(subscription_ends_at__lte=ts), status='active').count(),
    }
    mrr = sum(x.amount / 12 if x.cycle == 'yearly' else x.amount
              for x in Subscription.objects.filter(status='active', ends_at__gt=ts).exclude(source='trial'))
    revenue = Subscription.objects.filter(status__in=('active', 'replaced', 'expired')).exclude(source='trial').aggregate(v=Sum('amount'))['v'] or 0
    by_plan = [{'name': p.name, 'count': p.restaurants.filter(subscription_ends_at__gt=ts).count()} for p in Plan.objects.order_by('sort', 'id')]
    expiring = [{'id': r.id, 'name': r.name, 'subscription_ends_at': iso(r.subscription_ends_at), 'plan_name': r.plan.name if r.plan else None}
                for r in rs.select_related('plan').filter(subscription_ends_at__gt=ts, subscription_ends_at__lte=ts + dt.timedelta(days=10)).order_by('subscription_ends_at')[:8]]
    recent = [{'id': r.id, 'name': r.name, 'city': r.city, 'created_at': iso(r.created_at), 'plan_name': r.plan.name if r.plan else None}
              for r in rs.select_related('plan').order_by('-id')[:6]]
    payments = [{'id': x.id, 'amount': x.amount, 'cycle': x.cycle, 'source': x.source, 'created_at': iso(x.created_at),
                 'restaurant_name': x.restaurant.name, 'plan_name': x.plan.name}
                for x in Subscription.objects.select_related('restaurant', 'plan').exclude(status='pending').exclude(source='trial').order_by('-id')[:6]]
    orders_today = Order.objects.filter(created_at__gte=ts - dt.timedelta(days=1)).count()
    return {'restaurants': restaurants, 'mrr': round2(mrr), 'revenue': round2(revenue), 'byPlan': by_plan, 'expiring': expiring,
            'recent': recent, 'payments': payments, 'ordersToday': orders_today}


# ---- Plans ----
@endpoint(super_admin_only)
def plans_list(ctx):
    return [plan_out(p, restaurants=p.restaurants.count()) for p in Plan.objects.order_by('sort', 'id')]


@endpoint(super_admin_only)
def plans_create(ctx):
    return plan_out(Plan.objects.create(**plan_input(ctx.body)))


@endpoint(super_admin_only)
def plans_update(ctx):
    p = Plan.objects.filter(id=ctx.params['id']).first()
    if p is None:
        raise not_found('Plan not found.')
    for k, v in plan_input(ctx.body).items():
        setattr(p, k, v)
    p.save()
    return plan_out(p)


@endpoint(super_admin_only)
def plans_delete(ctx):
    pid = ctx.params['id']
    if Subscription.objects.filter(plan_id=pid).exists() or Restaurant.objects.filter(plan_id=pid).exists():
        raise conflict('This plan has been purchased before. Switch it off instead of deleting it.', 'PLAN_IN_USE')
    Plan.objects.filter(id=pid).delete()
    return {'ok': True}


# ---- Restaurants ----
@endpoint(super_admin_only)
def restaurants_list(ctx):
    q = str(ctx.query.get('q') or '').strip()
    qs = Restaurant.objects.select_related('plan').annotate(
        staff_count=Count('users', distinct=True), table_count=Count('tables', distinct=True), order_count=Count('orders', distinct=True))
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(phone__icontains=q) | Q(city__icontains=q) | Q(owner_name__icontains=q))
    return [dump(r, exclude=('settings',), plan_name=r.plan.name if r.plan else None, staff_count=r.staff_count,
                 table_count=r.table_count, order_count=r.order_count) for r in qs.order_by('-id')]


@endpoint(super_admin_only)
def restaurant_detail(ctx):
    r = Restaurant.objects.select_related('plan').filter(id=ctx.params['id']).first()
    if r is None:
        raise not_found('Restaurant not found.')
    owner = r.users.filter(role='owner').order_by('id').first()
    staff_fields = lambda u: {'id': u.id, 'name': u.name, 'phone': u.phone, 'role': u.role, 'active': int(u.is_active),  # noqa: E731
                              'last_login_at': iso(u.last_login)}
    paid = r.orders.filter(status='paid')
    return dump(
        r, exclude=('settings',), plan_name=r.plan.name if r.plan else None,
        owner={**staff_fields(owner), 'email': owner.email} if owner else None,
        staff=[staff_fields(u) for u in r.users.order_by('id')],
        subscriptions=[dump(x, plan_name=x.plan.name) for x in r.subscriptions.select_related('plan').order_by('-id')],
        roles=[{**role, 'permissions': role_permissions(r.id, role['key']), 'custom': has_custom(r.id, role['key'])} for role in ROLES],
        stats={'orders': r.orders.count(), 'sales': round2(paid.aggregate(v=Sum('total'))['v'] or 0)},
    )


@endpoint(super_admin_only)
def restaurants_create(ctx):
    b = ctx.body
    name = s(b.get('name'), 'Restaurant name', required=True, max_len=100)
    owner_name = s(b.get('owner_name'), 'Owner name', required=True, max_len=80)
    phone = normalize_phone(s(b.get('phone'), 'Owner mobile number', required=True, max_len=20))
    if not (phone.isdigit() and 10 <= len(phone) <= 13):
        raise bad('Enter a valid mobile number.')
    email = s(b.get('email'), 'Email', max_len=120).lower() or None
    password = s(b.get('password'), 'Owner password', required=True, min_len=6, max_len=200)
    plan = Plan.objects.filter(id=n(b.get('plan_id'), 'Plan', required=True, integer=True)).first()
    if plan is None:
        raise bad('Choose a plan.')
    mode = one_of(b.get('access'), 'Access', ['trial', 'paid', 'pending'], 'trial')
    cycle = one_of(b.get('cycle'), 'Billing cycle', ['monthly', 'yearly'], 'monthly')
    tables = n(b.get('tables'), 'Tables', min_v=0, max_v=plan.max_tables, integer=True) or 0
    if User.objects.filter(phone=phone).exists():
        raise conflict('A login with this mobile number already exists.')
    if email and User.objects.filter(email=email).exists():
        raise conflict('A login with this email already exists.')
    ts = now()
    r = Restaurant.objects.create(name=name, slug=unique_slug(name), owner_name=owner_name, phone=phone, email=email or '',
                                  address=s(b.get('address'), 'Address', max_len=300), city=s(b.get('city'), 'City', max_len=80),
                                  status='active', plan=plan, settings=dict(DEFAULT_SETTINGS), created_at=ts)
    User.objects.create_user(phone, password, restaurant=r, name=owner_name, email=email, role='owner', created_at=ts)
    DiningTable.objects.bulk_create([DiningTable(restaurant=r, name=f'T{i}', area='Main Hall', seats=4, qr_token=random_token(9),
                                                 sort=i, created_at=ts) for i in range(1, tables + 1)])
    trial_days = dj.TABLEX['TRIAL_DAYS']
    if mode == 'trial' and trial_days > 0:
        activate_subscription(restaurant_id=r.id, plan_id=plan.id, days=trial_days, source='trial', note='Free trial', created_by=ctx.user.id)
    elif mode == 'paid':
        activate_subscription(restaurant_id=r.id, plan_id=plan.id, cycle=cycle,
                              amount=plan.price_yearly if cycle == 'yearly' else plan.price_monthly, source='manual',
                              note=s(b.get('note'), 'Note', max_len=200) or 'Activated by Super Admin', created_by=ctx.user.id)
    r.refresh_from_db()
    return dump(r, exclude=('settings',))


@endpoint(super_admin_only)
def restaurants_update(ctx):
    b = ctx.body
    r = Restaurant.objects.filter(id=ctx.params['id']).first()
    if r is None:
        raise not_found('Restaurant not found.')
    r.name = s(b.get('name'), 'Restaurant name', required=True, max_len=100)
    r.owner_name = s(b.get('owner_name'), 'Owner name', max_len=80)
    r.phone = normalize_phone(s(b.get('phone'), 'Phone', max_len=20))
    r.email = s(b.get('email'), 'Email', max_len=120)
    r.address = s(b.get('address'), 'Address', max_len=300)
    r.city = s(b.get('city'), 'City', max_len=80)
    r.save()
    return {'ok': True}


@endpoint(super_admin_only)
def restaurant_status(ctx):
    """Grant or pause system access for a restaurant."""
    status = one_of(ctx.body.get('status'), 'Status', ['active', 'suspended'])
    if not Restaurant.objects.filter(id=ctx.params['id']).update(status=status):
        raise not_found('Restaurant not found.')
    return {'ok': True, 'status': status}


@endpoint(super_admin_only)
def restaurant_subscription(ctx):
    """Manually assign / extend a plan (bank transfer, cheque, complimentary…)."""
    b = ctx.body
    if not Restaurant.objects.filter(id=ctx.params['id']).exists():
        raise not_found('Restaurant not found.')
    plan = Plan.objects.filter(id=n(b.get('plan_id'), 'Plan', required=True, integer=True)).first()
    if plan is None:
        raise bad('Choose a plan.')
    cycle = one_of(b.get('cycle'), 'Billing cycle', ['monthly', 'yearly'], 'monthly')
    periods = n(b.get('periods'), 'Periods', min_v=1, max_v=36, integer=True) or 1
    amount = n(b.get('amount'), 'Amount', min_v=0, max_v=1e8)
    if amount is None:
        amount = (plan.price_yearly if cycle == 'yearly' else plan.price_monthly) * periods
    sub = activate_subscription(restaurant_id=int(ctx.params['id']), plan_id=plan.id, cycle=cycle, periods=periods, amount=amount,
                                source='manual' if amount > 0 else 'complimentary',
                                note=s(b.get('note'), 'Note', max_len=200) or 'Assigned by Super Admin', created_by=ctx.user.id)
    return dump(sub)


@endpoint(super_admin_only)
def restaurant_owner_password(ctx):
    password = s(ctx.body.get('password'), 'New password', required=True, min_len=6, max_len=200)
    owner = User.objects.filter(restaurant_id=ctx.params['id'], role='owner').order_by('id').first()
    if owner is None:
        raise not_found('Owner login not found.')
    owner.set_password(password)
    owner.is_active = True
    owner.save(update_fields=['password', 'is_active'])
    AuthSession.objects.filter(user=owner, revoked__isnull=True).update(revoked='password')
    return {'ok': True}


def _put_role(ctx, restaurant_id):
    role = one_of(ctx.params['role'], 'Role', ROLE_KEYS)
    if role == 'owner':
        raise bad('The Owner role always has full access.')
    save_role_permissions(restaurant_id, role, ctx.body.get('permissions'), reset=bool(ctx.body.get('reset')))
    return {'role': role, 'permissions': role_permissions(restaurant_id, role)}


@endpoint(super_admin_only)
def restaurant_role(ctx):
    return _put_role(ctx, int(ctx.params['id']))


@endpoint(super_admin_only)
def default_roles(ctx):
    return [{**role, 'permissions': role_permissions(None, role['key'])} for role in ROLES]


@endpoint(super_admin_only)
def default_role_update(ctx):
    return _put_role(ctx, None)


@endpoint(super_admin_only)
def subscriptions_list(ctx):
    return [dump(x, restaurant_name=x.restaurant.name, plan_name=x.plan.name)
            for x in Subscription.objects.select_related('restaurant', 'plan').order_by('-id')[:500]]

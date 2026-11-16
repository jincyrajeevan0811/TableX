"""Restaurant settings, staff, role permissions, notifications and dashboard."""
import datetime as dt

from django.db.models import Count, F, FloatField, Sum

from ..lib.auth import can, hash_secret, public_settings, verify_secret
from ..lib.http import bad, conflict, endpoint, forbidden, not_found
from ..lib.permissions import PERMISSIONS, ROLE_KEYS, ROLES, plan_features, role_permissions, save_role_permissions
from ..lib.util import day_bounds, iso, local_date, n, normalize_phone, now, one_of, round2, s
from ..models import AuthSession, DiningTable, Kot, Notification, Order, OrderItem, Payment, Plan, RiderStatus, User

STAFF_ROLES = [r for r in ROLE_KEYS if r != 'owner']


def pin_taken(rid, pin, except_id=None):
    qs = User.objects.filter(restaurant_id=rid, pin_hash__isnull=False)
    if except_id:
        qs = qs.exclude(id=except_id)
    return any(verify_secret(pin, u.pin_hash) for u in qs)


def _plan(ctx):
    return Plan.objects.filter(id=ctx.restaurant.plan_id).first()


# ---- Settings ----
@endpoint(can('settings'))
def settings_get(ctx):
    r = ctx.restaurant
    return {'restaurant': {'name': r.name, 'phone': r.phone, 'email': r.email, 'address': r.address, 'city': r.city},
            'settings': public_settings(ctx.settings)}


@endpoint(can('settings'))
def settings_put(ctx):
    b = ctx.body
    st = dict(ctx.settings)
    incoming = b.get('settings') or {}
    for k in ('round_off', 'gst_enabled', 'online_ordering', 'delivery_enabled', 'cash_drawer'):
        if k in incoming:
            st[k] = bool(incoming[k])
    for k in ('bill_footer', 'gstin', 'delivery_area', 'printer_bill', 'printer_kitchen', 'razorpay_key_id'):
        if k in incoming:
            st[k] = s(incoming[k], k, max_len=300)
    for k, lo, hi in (('service_charge_percent', 0, 30), ('gst_percent', 0, 28), ('delivery_fee', 0, 10000),
                      ('kitchen_amber_minutes', 1, 240), ('kitchen_red_minutes', 1, 480)):
        if k in incoming:
            st[k] = n(incoming[k], k.replace('_', ' '), min_v=lo, max_v=hi) or 0
    if 'stations' in incoming:
        raw = incoming['stations'] if isinstance(incoming['stations'], list) else str(incoming['stations']).split(',')
        stations = [str(x).strip() for x in raw if str(x).strip()][:12]
        st['stations'] = stations or ['Main Kitchen']
    if incoming.get('razorpay_key_secret'):
        st['razorpay_key_secret'] = s(incoming['razorpay_key_secret'], 'Razorpay secret', max_len=200)
    if incoming.get('razorpay_webhook_secret'):
        st['razorpay_webhook_secret'] = s(incoming['razorpay_webhook_secret'], 'Razorpay webhook secret', max_len=200)
    if incoming.get('clear_razorpay'):
        st['razorpay_key_id'] = st['razorpay_key_secret'] = st['razorpay_webhook_secret'] = ''
    info = b.get('restaurant') or {}
    r = ctx.restaurant
    r.name = s(info.get('name', r.name), 'Restaurant name', required=True, max_len=100)
    r.phone = s(info.get('phone', r.phone), 'Phone', max_len=20)
    r.email = s(info.get('email', r.email), 'Email', max_len=120)
    r.address = s(info.get('address', r.address), 'Address', max_len=300)
    r.city = s(info.get('city', r.city), 'City', max_len=80)
    r.settings = st
    r.save()
    return {'settings': public_settings(st)}


# ---- Staff ----
@endpoint(can('staff', 'delivery'))
def staff_list(ctx):
    plan = _plan(ctx)
    online = dict(RiderStatus.objects.filter(user__restaurant_id=ctx.rid).values_list('user_id', 'online'))
    users = User.objects.filter(restaurant_id=ctx.rid).order_by('-is_active', 'id')
    staff = [{'id': u.id, 'name': u.name, 'phone': u.phone, 'email': u.email, 'role': u.role, 'active': int(u.is_active),
              'last_login_at': iso(u.last_login), 'created_at': iso(u.created_at), 'has_pin': int(bool(u.pin_hash)),
              'online': int(bool(online.get(u.id)))} for u in users]
    return {'staff': staff, 'limit': plan.max_staff if plan else None, 'roles': ROLES}


def _check_staff_limit(ctx):
    plan = _plan(ctx)
    count = User.objects.filter(restaurant_id=ctx.rid, is_active=True).count()
    if plan and count >= plan.max_staff:
        raise forbidden(f'Your plan allows {plan.max_staff} active staff logins. Upgrade your plan to add more.', 'PLAN_LIMIT')


@endpoint(can('staff'))
def staff_create(ctx):
    b = ctx.body
    _check_staff_limit(ctx)
    role = one_of(b.get('role'), 'Role', STAFF_ROLES)
    if role == 'admin' and ctx.user.role not in ('owner', 'admin'):
        raise forbidden('Only the owner can create Admin logins.')
    phone = normalize_phone(s(b.get('phone'), 'Mobile number', required=True, max_len=20))
    if not (phone.isdigit() and 10 <= len(phone) <= 13):
        raise bad('Enter a valid mobile number.')
    pin = s(b.get('pin'), 'PIN', max_len=4)
    if pin and not (pin.isdigit() and len(pin) == 4):
        raise bad('PIN must be 4 digits.')
    if pin and pin_taken(ctx.rid, pin):
        raise conflict('Another staff member already uses this PIN.')
    if User.objects.filter(phone=phone).exists():
        raise conflict('A login with this mobile number already exists.')
    email = s(b.get('email'), 'Email', max_len=120).lower() or None
    if email and User.objects.filter(email=email).exists():
        raise conflict('A login with this email already exists.')
    u = User.objects.create_user(phone, s(b.get('password'), 'Password', required=True, min_len=6, max_len=200),
                                 restaurant=ctx.restaurant, name=s(b.get('name'), 'Name', required=True, max_len=80),
                                 email=email, pin_hash=hash_secret(pin) if pin else None, role=role, created_at=now())
    return {'id': u.id}


@endpoint(can('staff'))
def staff_update(ctx):
    b = ctx.body
    u = User.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).first()
    if u is None:
        raise not_found('Staff member not found.')
    if u.role == 'owner' and ctx.user.role != 'owner':
        raise forbidden('Only the owner can change the owner login.')
    old_role = u.role
    role = 'owner' if u.role == 'owner' else one_of(b.get('role', u.role), 'Role', STAFF_ROLES)
    phone = normalize_phone(s(b.get('phone', u.phone), 'Mobile number', required=True, max_len=20))
    if User.objects.filter(phone=phone).exclude(id=u.id).exists():
        raise conflict('A login with this mobile number already exists.')
    u.name = s(b.get('name', u.name), 'Name', required=True, max_len=80)
    u.phone = phone
    u.email = s(b.get('email', u.email), 'Email', max_len=120).lower() or None
    u.role = role
    if b.get('password'):
        u.set_password(s(b['password'], 'Password', min_len=6, max_len=200))
        AuthSession.objects.filter(user=u, revoked__isnull=True).update(revoked='password')
    pin = b.get('pin')
    if pin not in (None, ''):
        pin = str(pin)
        if not (pin.isdigit() and len(pin) == 4):
            raise bad('PIN must be 4 digits.')
        if pin_taken(ctx.rid, pin, u.id):
            raise conflict('Another staff member already uses this PIN.')
        u.pin_hash = hash_secret(pin)
    u.save()
    if role != old_role:
        AuthSession.objects.filter(user=u, revoked__isnull=True).update(revoked='role')
    return {'ok': True}


@endpoint(can('staff'))
def staff_active(ctx):
    """Switch a login on/off (when someone leaves)."""
    u = User.objects.filter(id=ctx.params['id'], restaurant_id=ctx.rid).first()
    if u is None:
        raise not_found('Staff member not found.')
    if u.role == 'owner':
        raise bad('The owner login cannot be switched off.')
    if u.id == ctx.user.id:
        raise bad('You cannot switch off your own login.')
    active = bool(ctx.body.get('active'))
    if active and not u.is_active:
        _check_staff_limit(ctx)
    u.is_active = active
    u.save(update_fields=['is_active'])
    if not active:
        AuthSession.objects.filter(user=u, revoked__isnull=True).update(revoked='disabled')
    return {'ok': True}


# ---- Roles ----
@endpoint(can('roles', 'staff'))
def roles_get(ctx):
    return {'permissions': PERMISSIONS,
            'roles': [{**role, 'permissions': role_permissions(ctx.rid, role['key'])} for role in ROLES],
            'planFeatures': plan_features(ctx.restaurant.plan_id)}


@endpoint(can('roles'))
def roles_put(ctx):
    role = one_of(ctx.params['role'], 'Role', ROLE_KEYS)
    if role == 'owner':
        raise bad('The Owner role always has full access.')
    if role == 'admin' and ctx.user.role != 'owner':
        raise forbidden('Only the owner can change Admin permissions.')
    save_role_permissions(ctx.rid, role, ctx.body.get('permissions'), reset=bool(ctx.body.get('reset')))
    return {'role': role, 'permissions': role_permissions(ctx.rid, role)}


# ---- Notifications ----
@endpoint(can())
def notifications(ctx):
    since = int(ctx.query.get('since') or 0) if str(ctx.query.get('since') or '0').isdigit() else 0
    items = Notification.objects.select_related('table').filter(restaurant_id=ctx.rid, id__gt=since).order_by('-id')[:30]
    from ..lib.http import dump
    return {'items': [dump(x, table_name=x.table.name if x.table else None) for x in items],
            'unread': Notification.objects.filter(restaurant_id=ctx.rid, read=False).count()}


@endpoint(can())
def notifications_read(ctx):
    qs = Notification.objects.filter(restaurant_id=ctx.rid)
    if ctx.body.get('id'):
        qs = qs.filter(id=ctx.body['id'])
    qs.update(read=True)
    return {'ok': True}


# ---- Dashboard ----
@endpoint(can('dashboard'))
def dashboard(ctx):
    off = ctx.settings['tz_offset_minutes']
    t_from, t_to, _ = day_bounds(None, off)
    paid_today = Order.objects.filter(restaurant_id=ctx.rid, status='paid', paid_at__gte=t_from, paid_at__lt=t_to)
    agg = paid_today.aggregate(orders=Count('id'), total=Sum('total'), discount=Sum('discount'))
    sales = {'orders': agg['orders'] or 0, 'total': round2(agg['total'] or 0), 'discount': round2(agg['discount'] or 0)}
    run = Order.objects.filter(restaurant_id=ctx.rid, status__in=('open', 'billed')).aggregate(c=Count('id'), v=Sum('total'))
    tables = [{'status': x['status'], 'c': x['c']} for x in DiningTable.objects.filter(restaurant_id=ctx.rid).values('status').annotate(c=Count('id'))]
    kitchen = Kot.objects.filter(restaurant_id=ctx.rid, status__in=('new', 'preparing')).count()
    awaiting = Order.objects.filter(restaurant_id=ctx.rid, status__in=('awaiting', 'open', 'billed'), items__status='pending').distinct().count()
    days = []
    for i in range(6, -1, -1):
        days.append({'date': local_date(now() - dt.timedelta(days=i), off), 'total': 0, 'orders': 0})
    from7 = day_bounds(days[0]['date'], off)[0]
    for o in Order.objects.filter(restaurant_id=ctx.rid, status='paid', paid_at__gte=from7).only('paid_at', 'total'):
        d = next((x for x in days if x['date'] == local_date(o.paid_at, off)), None)
        if d:
            d['total'] = round2(d['total'] + o.total)
            d['orders'] += 1
    top = list(OrderItem.objects.filter(order__restaurant_id=ctx.rid, order__status='paid', order__paid_at__gte=from7)
               .exclude(status='cancelled').values('name')
               .annotate(qty=Sum('qty'), amount=Sum(F('qty') * F('price'), output_field=FloatField())).order_by('-qty')[:5])
    by_type = [{'type': x['type'], 'c': x['c'], 'v': round2(x['v'] or 0)} for x in paid_today.values('type').annotate(c=Count('id'), v=Sum('total'))]
    methods = [{'method': x['method'], 'v': round2(x['v'] or 0)} for x in Payment.objects.filter(
        restaurant_id=ctx.rid, created_at__gte=t_from, created_at__lt=t_to).values('method').annotate(v=Sum('amount'))]
    return {'today': {**sales, 'avg': round2(sales['total'] / sales['orders']) if sales['orders'] else 0},
            'running': {'c': run['c'] or 0, 'v': round2(run['v'] or 0)}, 'tables': tables, 'kitchen': kitchen, 'awaiting': awaiting,
            'days': days, 'top': top, 'byType': by_type, 'methods': methods}

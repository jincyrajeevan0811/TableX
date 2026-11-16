from ..lib.auth import (authed, authenticate, clear_rate_limit, create_session, hash_secret, public_settings, rate_limit,
                        verify_secret)
from ..lib.http import bad, endpoint, unauthorized
from ..lib.permissions import PERMISSIONS, ROLES, role_label
from ..lib.util import iso, normalize_phone, s
from ..models import AuthSession, Plan, User


def me_payload(ctx):
    u = ctx.user
    base = {
        'user': {'id': u.id, 'name': u.name, 'phone': u.phone, 'email': u.email, 'role': u.role, 'has_pin': bool(u.pin_hash)},
        'permissions': ctx.perms,
    }
    if ctx.is_super_admin:
        return {**base, 'superAdmin': True}
    r = ctx.restaurant
    plan = Plan.objects.filter(id=r.plan_id).first() if r.plan_id else None
    return {
        **base,
        'roleLabel': role_label(u.role),
        'restaurant': {'id': r.id, 'name': r.name, 'slug': r.slug, 'phone': r.phone, 'email': r.email, 'address': r.address,
                       'city': r.city, 'status': r.status, 'subscription_ends_at': iso(r.subscription_ends_at),
                       'settings': public_settings(ctx.settings)},
        'plan': {'id': plan.id, 'name': plan.name, 'features': plan.features or [], 'max_tables': plan.max_tables,
                 'max_staff': plan.max_staff} if plan else None,
        'subscription': ctx.subscription,
    }


def _sign_in(ctx, user):
    token = create_session(user, ctx.body.get('device') or ctx.request.META.get('HTTP_USER_AGENT', ''))
    authenticate(ctx, token)
    return {'token': token, **me_payload(ctx)}


@endpoint()
def login(ctx):
    login_id = s(ctx.body.get('login'), 'Mobile number or email', required=True, max_len=120)
    password = s(ctx.body.get('password'), 'Password', required=True, max_len=200)
    key = f'login:{ctx.ip}:{login_id.lower()}'
    rate_limit(key, 8)
    if '@' in login_id:
        user = User.objects.filter(email=login_id.lower()).first()
    else:
        user = User.objects.filter(phone=normalize_phone(login_id)).first()
    if user is None or not user.check_password(password):
        raise unauthorized('Mobile number / email or password is wrong.', 'BAD_LOGIN')
    if not user.is_active:
        raise unauthorized('Your login has been switched off. Please contact your manager.', 'USER_DISABLED')
    clear_rate_limit(key)
    return _sign_in(ctx, user)


@endpoint(authed)
def logout(ctx):
    AuthSession.objects.filter(token=ctx.token).update(revoked='logout')
    return {'ok': True}


@endpoint(authed)
def me(ctx):
    return me_payload(ctx)


@endpoint()
def meta(ctx):
    return {'roles': ROLES, 'permissions': PERMISSIONS}


@endpoint(authed)
def pin_switch(ctx):
    """Quick switch on a shared counter device using a 4-digit PIN."""
    if ctx.is_super_admin:
        raise bad('PIN switch is for restaurant staff.')
    pin = s(ctx.body.get('pin'), 'PIN', required=True, max_len=6)
    if not (pin.isdigit() and len(pin) == 4):
        raise bad('PIN must be 4 digits.')
    rate_limit(f'pin:{ctx.ip}:{ctx.rid}', 10)
    staff = User.objects.filter(restaurant_id=ctx.rid, is_active=True, pin_hash__isnull=False)
    user = next((u for u in staff if verify_secret(pin, u.pin_hash)), None)
    if user is None:
        raise unauthorized('That PIN does not match anyone.', 'BAD_PIN')
    clear_rate_limit(f'pin:{ctx.ip}:{ctx.rid}')
    return _sign_in(ctx, user)


@endpoint(authed)
def change_password(ctx):
    current = s(ctx.body.get('current'), 'Current password', required=True, max_len=200)
    nxt = s(ctx.body.get('next'), 'New password', required=True, min_len=6, max_len=200)
    if not ctx.user.check_password(current):
        raise bad('Current password is wrong.')
    ctx.user.set_password(nxt)
    ctx.user.save(update_fields=['password'])
    AuthSession.objects.filter(user=ctx.user, revoked__isnull=True).exclude(token=ctx.token).update(revoked='password')
    return {'ok': True}


@endpoint(authed)
def set_pin(ctx):
    pin = s(ctx.body.get('pin'), 'PIN', required=True)
    if not (pin.isdigit() and len(pin) == 4):
        raise bad('PIN must be 4 digits.')
    if ctx.user.restaurant_id and any(verify_secret(pin, u.pin_hash) for u in User.objects.filter(
            restaurant_id=ctx.user.restaurant_id, pin_hash__isnull=False).exclude(id=ctx.user.id)):
        raise bad('Another staff member already uses this PIN. Choose a different one.')
    ctx.user.pin_hash = hash_secret(pin)
    ctx.user.save(update_fields=['pin_hash'])
    return {'ok': True}

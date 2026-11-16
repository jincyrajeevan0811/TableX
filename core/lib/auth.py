"""Token sessions, guards (super admin / restaurant permission) and restaurant settings."""
import datetime as dt
import hashlib
import hmac

from django.conf import settings as dj_settings
from django.contrib.auth.hashers import check_password
from django.core.cache import cache
from django.db import transaction

from ..models import AuthSession, Restaurant
from .http import HttpError, forbidden, unauthorized
from .permissions import MULTI_DEVICE_ROLES, effective_permissions
from .util import now, random_token

DEFAULT_SETTINGS = {
    'bill_footer': 'Thank you! Visit again.',
    'service_charge_percent': 0,
    'round_off': True,
    'gst_enabled': False,
    'gst_percent': 5,
    'gstin': '',
    'online_ordering': True,
    'delivery_enabled': True,
    'delivery_fee': 30,
    'delivery_area': '',
    'currency': 'INR',
    'tz_offset_minutes': 330,
    'kitchen_amber_minutes': 10,
    'kitchen_red_minutes': 20,
    'stations': ['Main Kitchen'],
    'razorpay_key_id': '',
    'razorpay_key_secret': '',
    'razorpay_webhook_secret': '',
    'printer_bill': '',
    'printer_kitchen': '',
    'cash_drawer': False,
}


def restaurant_settings(restaurant):
    return {**DEFAULT_SETTINGS, **(restaurant.settings or {})} if restaurant else dict(DEFAULT_SETTINGS)


def public_settings(s):
    out = {k: v for k, v in s.items() if k not in ('razorpay_key_secret', 'razorpay_webhook_secret')}
    out['razorpay_secret_set'] = bool(s.get('razorpay_key_secret'))
    out['razorpay_webhook_set'] = bool(s.get('razorpay_webhook_secret'))
    return out


def hash_secret(secret):
    """Hash for 4-digit quick-switch PINs (salted PBKDF2, peppered with SECRET_KEY; brute force is rate limited).
    Passwords use Django's full password hashers via User.set_password()."""
    salt = random_token(12)
    digest = hashlib.pbkdf2_hmac('sha256', f'{secret}{dj_settings.SECRET_KEY}'.encode(), salt.encode(), 20000).hex()
    return f'pin${salt}${digest}'


def verify_secret(secret, stored):
    if not stored:
        return False
    if stored.startswith('pin$'):
        _, salt, digest = stored.split('$', 2)
        test = hashlib.pbkdf2_hmac('sha256', f'{secret}{dj_settings.SECRET_KEY}'.encode(), salt.encode(), 20000).hex()
        return hmac.compare_digest(test, digest)
    return check_password(str(secret), stored)


def create_session(user, device=''):
    token = random_token(32)
    ts = now()
    with transaction.atomic():
        if user.role not in MULTI_DEVICE_ROLES:
            # One device at a time: the older device gets signed out with a clear message.
            AuthSession.objects.filter(user=user, revoked__isnull=True).update(revoked='replaced')
        AuthSession.objects.create(token=token, user=user, device=str(device or '')[:200], created_at=ts, last_seen_at=ts,
                                   expires_at=ts + dt.timedelta(days=dj_settings.TABLEX['SESSION_DAYS']))
        user.last_login = ts
        user.save(update_fields=['last_login'])
    return token


def subscription_state(restaurant):
    if restaurant is None:
        return {'active': True}
    if restaurant.status != 'active':
        return {'active': False, 'reason': 'suspended'}
    if not restaurant.subscription_ends_at or restaurant.subscription_ends_at < now():
        return {'active': False, 'reason': 'expired'}
    return {'active': True}


def authenticate(ctx, token=None):
    header = ctx.request.META.get('HTTP_AUTHORIZATION', '')
    token = token or (header[7:].strip() if header.startswith('Bearer ') else '')
    if not token:
        raise unauthorized()
    session = AuthSession.objects.select_related('user').filter(token=token).first()
    if session is None:
        raise unauthorized('Your session expired. Please sign in again.', 'SESSION_EXPIRED')
    if session.revoked == 'replaced':
        raise unauthorized('This login is now in use on another device. Every person needs their own login — ask the owner to create one for you.', 'SESSION_REPLACED')
    if session.revoked or session.expires_at < now():
        raise unauthorized('Your session expired. Please sign in again.', 'SESSION_EXPIRED')
    user = session.user
    if not user.is_active:
        raise unauthorized('Your login has been switched off. Please contact your manager.', 'USER_DISABLED')

    ctx.token = token
    ctx.user = user
    ctx.perms = []
    if user.role == 'super_admin':
        ctx.is_super_admin = True
    else:
        restaurant = Restaurant.objects.filter(id=user.restaurant_id).first()
        if restaurant is None:
            raise unauthorized('Restaurant not found.', 'NO_RESTAURANT')
        ctx.restaurant = restaurant
        ctx.rid = restaurant.id
        ctx.settings = restaurant_settings(restaurant)
        ctx.perms = effective_permissions(restaurant, user.role)
        ctx.subscription = subscription_state(restaurant)
    ts = now()
    if not session.last_seen_at or (ts - session.last_seen_at).total_seconds() > 60:
        AuthSession.objects.filter(token=token).update(last_seen_at=ts)


def authed(ctx):
    authenticate(ctx)


def super_admin_only(ctx):
    authenticate(ctx)
    if not ctx.is_super_admin:
        raise forbidden('Super Admin access only.')


def can(*perms):
    """Restaurant staff guard: passes with ANY listed permission (or none listed).
    Suspended / lapsed restaurants are blocked except for the subscription screens."""
    def guard(ctx):
        authenticate(ctx)
        if ctx.is_super_admin:
            raise forbidden('Sign in with a restaurant login to use this screen.')
        if not ctx.subscription['active'] and 'subscription' not in perms:
            if ctx.subscription.get('reason') == 'suspended':
                raise HttpError(403, 'Access to this restaurant has been paused by TableX. Please contact support.', 'RESTAURANT_SUSPENDED')
            raise HttpError(402, 'Your TableX subscription has ended. Please renew your plan to continue.', 'SUBSCRIPTION_EXPIRED')
        if perms and not any(p in ctx.perms for p in perms):
            raise forbidden()
    return guard


def has(ctx, perm):
    return ctx.is_super_admin or perm in ctx.perms


def rate_limit(key, max_hits=10, window=300):
    k = f'rl:{key}'
    if cache.add(k, 1, window):
        hits = 1
    else:
        try:
            hits = cache.incr(k)
        except ValueError:
            cache.set(k, 1, window)
            hits = 1
    if hits > max_hits:
        raise HttpError(429, 'Too many attempts. Please wait a few minutes and try again.', 'RATE_LIMITED')


def clear_rate_limit(key):
    cache.delete(f'rl:{key}')

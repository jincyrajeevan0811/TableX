import datetime as dt
import re
import secrets

from django.utils import timezone

from .http import bad


def now():
    return timezone.now()


def round2(n):
    return round(float(n) + 1e-9, 2) if n is not None else 0.0


def random_token(nbytes=24):
    return secrets.token_urlsafe(nbytes)


def random_digits(n):
    return ''.join(str(secrets.randbelow(10)) for _ in range(n))


def slugify(s):
    s = re.sub(r'[^a-z0-9]+', '-', str(s).lower().strip()).strip('-')[:48]
    return s or 'restaurant'


def iso(value):
    """ISO-8601 in UTC with millisecond precision and a Z — the same shape JavaScript produces."""
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        if timezone.is_naive(value):
            value = timezone.make_aware(value, dt.timezone.utc)
        return value.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return value


def parse_iso(value):
    if not value:
        return None
    return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------
def s(v, field, required=False, max_len=500, min_len=0):
    v = '' if v is None else str(v).strip()
    if required and not v:
        raise bad(f'{field} is required.')
    if len(v) > max_len:
        raise bad(f'{field} is too long (max {max_len}).')
    if v and len(v) < min_len:
        raise bad(f'{field} must be at least {min_len} characters.')
    return v


def n(v, field, required=False, min_v=float('-inf'), max_v=float('inf'), integer=False):
    if v is None or v == '':
        if required:
            raise bad(f'{field} is required.')
        return None
    try:
        num = float(v)
    except (TypeError, ValueError):
        raise bad(f'{field} must be a number.')
    if num != num or num in (float('inf'), float('-inf')):
        raise bad(f'{field} must be a number.')
    if integer:
        if num != int(num):
            raise bad(f'{field} must be a whole number.')
        num = int(num)
    if num < min_v or num > max_v:
        lo = int(min_v) if min_v != float('-inf') and min_v == int(min_v) else min_v
        hi = int(max_v) if max_v != float('inf') and max_v == int(max_v) else max_v
        raise bad(f'{field} must be between {lo} and {hi}.')
    return num


def one_of(v, field, options, fallback=None):
    if v is None or v == '':
        if fallback is not None:
            return fallback
        raise bad(f'{field} is required.')
    if v not in options:
        raise bad(f'{field} must be one of: {", ".join(options)}.')
    return v


def normalize_phone(p):
    digits = re.sub(r'[^\d+]', '', str(p or ''))
    return re.sub(r'^\+?91(?=\d{10}$)', '', digits)


def day_bounds(date_str=None, offset_min=330):
    """(from, to, 'YYYY-MM-DD') UTC datetimes for a local calendar day with a fixed UTC offset."""
    off = dt.timedelta(minutes=offset_min)
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', date_str or '')
    if m:
        day = dt.date(int(m[1]), int(m[2]), int(m[3]))
    else:
        day = (timezone.now() + off).date()
    start = dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc) - off
    return start, start + dt.timedelta(days=1), day.isoformat()


def local_date(value, offset_min=330):
    return (value.astimezone(dt.timezone.utc) + dt.timedelta(minutes=offset_min)).date().isoformat()


def add_days(value, days):
    return value + dt.timedelta(days=days)

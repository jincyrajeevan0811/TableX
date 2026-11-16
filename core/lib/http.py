"""JSON API plumbing: errors, endpoint decorator, method routing and model serialisation."""
import datetime as dt
import json
import logging

from django.db import IntegrityError, transaction
from django.http import HttpResponse, JsonResponse
from django.urls import path
from django.views.decorators.csrf import csrf_exempt

log = logging.getLogger('tablex')


class HttpError(Exception):
    def __init__(self, status, message, code='ERROR', extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.extra = extra


def bad(msg, code='BAD_REQUEST', extra=None):
    return HttpError(400, msg, code, extra)


def unauthorized(msg='Please sign in.', code='UNAUTHORIZED'):
    return HttpError(401, msg, code)


def forbidden(msg='You do not have access to this.', code='FORBIDDEN'):
    return HttpError(403, msg, code)


def not_found(msg='Not found.'):
    return HttpError(404, msg, 'NOT_FOUND')


def conflict(msg, code='CONFLICT', extra=None):
    return HttpError(409, msg, code, extra)


def json_response(data, status=200):
    resp = JsonResponse(data, status=status, safe=False, json_dumps_params={'ensure_ascii': False})
    resp['Cache-Control'] = 'no-store'
    return resp


def error_response(err):
    body = {'error': err.message, 'code': err.code}
    if err.extra is not None:
        body['details'] = err.extra
    return json_response(body, err.status)


class Ctx:
    """Per-request context handed to every API handler."""

    def __init__(self, request, params):
        self.request = request
        self.params = params
        self.query = request.GET
        self.body = {}
        self.raw_body = b''
        fwd = request.META.get('HTTP_X_FORWARDED_FOR', '')
        self.ip = fwd.split(',')[0].strip() if fwd else request.META.get('REMOTE_ADDR', '')
        self.user = None
        self.restaurant = None
        self.rid = None
        self.settings = {}
        self.perms = []
        self.subscription = {'active': True}
        self.is_super_admin = False
        self.token = None


def endpoint(*guards, atomic=True):
    """Wrap a handler(ctx) → JSON-able value. Guards run first and may raise HttpError."""
    def deco(fn):
        def view(request, **params):
            ctx = Ctx(request, params)
            try:
                if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
                    ctx.raw_body = request.body
                    if ctx.raw_body:
                        try:
                            parsed = json.loads(ctx.raw_body.decode('utf-8'))
                        except (ValueError, UnicodeDecodeError):
                            raise HttpError(400, 'Invalid JSON body.', 'BAD_JSON')
                        ctx.body = parsed if isinstance(parsed, dict) else {}
                for guard in guards:
                    guard(ctx)
                if atomic and request.method != 'GET':
                    with transaction.atomic():
                        result = fn(ctx)
                else:
                    result = fn(ctx)
                if isinstance(result, HttpResponse):
                    return result
                return json_response({'ok': True} if result is None else result)
            except HttpError as err:
                return error_response(err)
            except IntegrityError as err:
                field = str(err).rsplit('.', 1)[-1] if 'UNIQUE' in str(err) else 'value'
                return json_response({'error': f'That {field.replace("_", " ")} is already in use.', 'code': 'DUPLICATE'}, 409)
            except Exception:  # noqa: BLE001
                log.exception('%s %s failed', request.method, request.path)
                return json_response({'error': 'Something went wrong. Please try again.', 'code': 'SERVER_ERROR'}, 500)
        view.__name__ = fn.__name__
        return view
    return deco


def route(pattern, **methods):
    """path() that dispatches by HTTP method: route('api/menu', GET=list_menu, POST=create)."""
    @csrf_exempt
    def dispatcher(request, **kwargs):
        handler = methods.get(request.method)
        if handler is None:
            return json_response({'error': 'Method not allowed.', 'code': 'METHOD_NOT_ALLOWED'}, 405)
        return handler(request, **kwargs)
    return path(pattern, dispatcher)


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------
def dump(obj, *, exclude=(), bool_int=True, **extra):
    """Model → dict with column-style keys (FKs as `<name>_id`), ISO datetimes, booleans as 0/1."""
    from .util import iso
    out = {}
    for f in obj._meta.concrete_fields:
        if f.name in exclude or f.attname in exclude:
            continue
        v = getattr(obj, f.attname)
        if isinstance(v, dt.datetime):
            v = iso(v)
        elif isinstance(v, bool) and bool_int:
            v = int(v)
        out[f.attname] = v
    out.update(extra)
    return out

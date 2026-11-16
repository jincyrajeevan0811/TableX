import datetime as dt

from django.conf import settings as dj
from django.db.models import Count, Q, Sum

from ..lib.auth import can, has
from ..lib.http import HttpError, bad, conflict, dump, endpoint, forbidden, not_found
from ..lib.orders import ACTIVE_STATUSES, active_order_for_table, order_detail
from ..lib.util import iso, n, now, one_of, random_token, s
from ..models import DiningTable, Order, Plan, User

LOCK_TTL = dt.timedelta(hours=4)


def base_url(ctx):
    if dj.TABLEX['APP_URL']:
        return dj.TABLEX['APP_URL']
    return ctx.request.build_absolute_uri('/').rstrip('/')


def get_table(rid, tid):
    t = DiningTable.objects.filter(id=tid, restaurant_id=rid).first()
    if t is None:
        raise not_found('Table not found.')
    return t


def lock_live(t):
    return bool(t.lock_user_id and t.lock_at and now() - t.lock_at < LOCK_TTL)


@endpoint(can('pos', 'tables_manage', 'qr_orders', 'billing', 'live_orders'))
def tables_list(ctx):
    tables = list(DiningTable.objects.select_related('lock_user').filter(restaurant_id=ctx.rid).order_by('area', 'sort', 'id'))
    orders = (Order.objects.filter(restaurant_id=ctx.rid, status__in=ACTIVE_STATUSES, table__isnull=False)
              .annotate(pending_items=Count('items', filter=Q(items__status='pending')),
                        item_count=Sum('items__qty', filter=~Q(items__status__in=('cancelled', 'pending')))))
    by_table = {o.table_id: {'id': o.id, 'table_id': o.table_id, 'status': o.status, 'total': o.total, 'created_at': iso(o.created_at),
                             'order_no': o.order_no, 'pending_items': o.pending_items, 'item_count': o.item_count or 0} for o in orders}
    out = []
    for t in tables:
        live = lock_live(t)
        out.append(dump(t, lock_user_id=t.lock_user_id if live else None, lock_name=t.lock_user.name if live else None,
                        locked_by_me=bool(live and t.lock_user_id == ctx.user.id), order=by_table.get(t.id)))
    return out


@endpoint(can('tables_manage'))
def tables_create(ctx):
    b = ctx.body
    plan = Plan.objects.filter(id=ctx.restaurant.plan_id).first()
    count = DiningTable.objects.filter(restaurant_id=ctx.rid).count()
    bulk = n(b.get('count'), 'Number of tables', min_v=1, max_v=100, integer=True)
    adding = bulk or 1
    if plan and count + adding > plan.max_tables:
        raise forbidden(f'Your plan allows {plan.max_tables} tables. Upgrade your plan to add more.', 'PLAN_LIMIT')
    area = s(b.get('area'), 'Area', max_len=40) or 'Main Hall'
    seats = n(b.get('seats'), 'Seats', min_v=1, max_v=50, integer=True) or 4
    ts = now()
    created = []
    if bulk:
        prefix = s(b.get('prefix'), 'Prefix', max_len=10) or 'T'
        num = 1
        for i in range(bulk):
            while DiningTable.objects.filter(restaurant_id=ctx.rid, name=f'{prefix}{num}').exists():
                num += 1
            created.append(DiningTable.objects.create(restaurant_id=ctx.rid, name=f'{prefix}{num}', area=area, seats=seats,
                                                      qr_token=random_token(9), sort=count + i + 1, created_at=ts).id)
            num += 1
    else:
        name = s(b.get('name'), 'Table name', required=True, max_len=30)
        if DiningTable.objects.filter(restaurant_id=ctx.rid, name=name).exists():
            raise conflict(f'A table named {name} already exists.')
        created.append(DiningTable.objects.create(restaurant_id=ctx.rid, name=name, area=area, seats=seats, qr_token=random_token(9),
                                                  sort=count + 1, created_at=ts).id)
    return {'created': created}


@endpoint(can('tables_manage'))
def table_update(ctx):
    t = get_table(ctx.rid, ctx.params['id'])
    name = s(ctx.body.get('name', t.name), 'Table name', required=True, max_len=30)
    if DiningTable.objects.filter(restaurant_id=ctx.rid, name=name).exclude(id=t.id).exists():
        raise conflict(f'A table named {name} already exists.')
    t.name = name
    t.area = s(ctx.body.get('area', t.area), 'Area', max_len=40) or 'Main Hall'
    t.seats = n(ctx.body.get('seats', t.seats), 'Seats', min_v=1, max_v=50, integer=True) or t.seats
    t.save()
    return {'ok': True}


@endpoint(can('tables_manage'))
def table_delete(ctx):
    t = get_table(ctx.rid, ctx.params['id'])
    if active_order_for_table(ctx.rid, t.id):
        raise conflict('This table has a running order. Settle it first.')
    t.delete()
    return {'ok': True}


@endpoint(can('tables_manage'))
def table_regenerate_qr(ctx):
    t = get_table(ctx.rid, ctx.params['id'])
    t.qr_token = random_token(9)
    t.save(update_fields=['qr_token'])
    return {'ok': True}


@endpoint(can('tables_manage'))
def tables_qr(ctx):
    base = base_url(ctx)
    return {'restaurant': ctx.restaurant.name,
            'tables': [{'id': t.id, 'name': t.name, 'area': t.area, 'qr_token': t.qr_token, 'url': f'{base}/m/{t.qr_token}'}
                       for t in DiningTable.objects.filter(restaurant_id=ctx.rid).order_by('area', 'sort', 'id')]}


@endpoint(can('pos'))
def table_open(ctx):
    """Open a table: it becomes yours. Others see a lock with your name; the owner can still open it."""
    t = get_table(ctx.rid, ctx.params['id'])
    opened_as_owner = False
    if lock_live(t) and t.lock_user_id != ctx.user.id:
        holder = User.objects.filter(id=t.lock_user_id).values_list('name', flat=True).first()
        if not has(ctx, 'open_any_table'):
            raise HttpError(423, f"Table {t.name} is being served by {holder or 'another waiter'} right now.", 'TABLE_LOCKED', {'by': holder})
        opened_as_owner = True
    else:
        DiningTable.objects.filter(id=t.id).update(lock_user=ctx.user, lock_at=now())
    order = active_order_for_table(ctx.rid, t.id)
    t.refresh_from_db()
    return {'table': dump(t), 'order': order_detail(ctx.rid, order.id) if order else None, 'openedAsOwner': opened_as_owner,
            'message': 'Opened as owner. The waiter keeps the table.' if opened_as_owner else None}


@endpoint(can('pos'))
def table_close(ctx):
    t = get_table(ctx.rid, ctx.params['id'])
    if t.lock_user_id == ctx.user.id:
        DiningTable.objects.filter(id=t.id).update(lock_user=None, lock_at=None)
    return {'ok': True}


@endpoint(can('pos', 'tables_manage'))
def table_status(ctx):
    t = get_table(ctx.rid, ctx.params['id'])
    status = one_of(ctx.body.get('status'), 'Status', ['free', 'reserved', 'cleaning'])
    if active_order_for_table(ctx.rid, t.id):
        raise bad(f'Table {t.name} has a running order.')
    DiningTable.objects.filter(id=t.id).update(status=status, lock_user=None, lock_at=None)
    return {'ok': True}

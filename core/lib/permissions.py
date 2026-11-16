"""Roles, permissions and plan features."""
from ..models import Plan, RolePermission

PERMISSIONS = [
    {'key': 'dashboard', 'label': 'Dashboard & overview', 'group': 'General'},
    {'key': 'pos', 'label': 'POS & tables — take orders, send KOT', 'group': 'Service'},
    {'key': 'qr_orders', 'label': 'Accept QR (customer) orders', 'group': 'Service', 'feature': 'qr_ordering'},
    {'key': 'open_any_table', 'label': 'Open a table another waiter is using', 'group': 'Service'},
    {'key': 'kitchen', 'label': 'Kitchen display (KOT)', 'group': 'Kitchen'},
    {'key': 'billing', 'label': 'Print bills & take payment', 'group': 'Billing'},
    {'key': 'discounts', 'label': 'Give discounts', 'group': 'Billing'},
    {'key': 'cancel_items', 'label': 'Cancel items / KOTs', 'group': 'Billing'},
    {'key': 'bills', 'label': 'Find & reprint old bills', 'group': 'Billing'},
    {'key': 'live_orders', 'label': 'Live orders board', 'group': 'Management'},
    {'key': 'delivery', 'label': 'Manage delivery & assign riders', 'group': 'Delivery', 'feature': 'delivery'},
    {'key': 'rider', 'label': 'Rider app — deliver orders', 'group': 'Delivery', 'feature': 'delivery'},
    {'key': 'reports', 'label': 'Reports & insights', 'group': 'Management', 'feature': 'reports'},
    {'key': 'menu', 'label': 'Menu & prices', 'group': 'Management'},
    {'key': 'tables_manage', 'label': 'Tables, rooms & QR codes', 'group': 'Management'},
    {'key': 'inventory', 'label': 'Stock & purchases', 'group': 'Management', 'feature': 'inventory'},
    {'key': 'staff', 'label': 'Staff logins', 'group': 'Administration'},
    {'key': 'roles', 'label': 'Role permissions', 'group': 'Administration'},
    {'key': 'settings', 'label': 'Restaurant settings', 'group': 'Administration'},
    {'key': 'subscription', 'label': 'Subscription & plan billing', 'group': 'Administration'},
]
PERMISSION_KEYS = [p['key'] for p in PERMISSIONS]
_FEATURE_OF = {p['key']: p.get('feature') for p in PERMISSIONS}

FEATURES = [
    {'key': 'qr_ordering', 'label': 'QR code table ordering'},
    {'key': 'online_payments', 'label': 'Online payments (Razorpay) for guests'},
    {'key': 'delivery', 'label': 'Home delivery & riders'},
    {'key': 'reports', 'label': 'Reports & insights'},
    {'key': 'inventory', 'label': 'Stock & purchases'},
    {'key': 'multi_station', 'label': 'Multiple kitchen stations'},
    {'key': 'offline_mode', 'label': 'Offline billing & sync'},
]
FEATURE_KEYS = [f['key'] for f in FEATURES]

ROLES = [
    {'key': 'owner', 'label': 'Owner', 'locked': True, 'description': 'Everything — orders, billing, reports, menu, staff, settings.'},
    {'key': 'admin', 'label': 'Admin', 'description': 'Restaurant administrator — full management access.'},
    {'key': 'manager', 'label': 'Manager', 'description': 'Runs the floor: orders, billing, discounts, cancellations, reports, menu.'},
    {'key': 'captain', 'label': 'Captain (Waiter)', 'description': 'Takes table orders and sends them to the kitchen.'},
    {'key': 'cashier', 'label': 'Cashier', 'description': 'Prints bills, takes payment, gives discounts.'},
    {'key': 'kitchen', 'label': 'Kitchen', 'description': 'Kitchen screen — marks food preparing / ready.'},
    {'key': 'rider', 'label': 'Rider', 'description': 'Delivers orders, collects cash on delivery.'},
    {'key': 'store_keeper', 'label': 'Store keeper', 'description': 'Manages stock and purchases.'},
]
ROLE_KEYS = [r['key'] for r in ROLES]

DEFAULT_ROLE_PERMISSIONS = {
    'owner': PERMISSION_KEYS,
    'admin': PERMISSION_KEYS,
    'manager': ['dashboard', 'pos', 'qr_orders', 'open_any_table', 'kitchen', 'billing', 'discounts', 'cancel_items',
                'bills', 'live_orders', 'delivery', 'reports', 'menu', 'tables_manage', 'inventory'],
    'captain': ['pos', 'qr_orders'],
    'cashier': ['pos', 'qr_orders', 'billing', 'discounts', 'bills', 'live_orders'],
    'kitchen': ['kitchen'],
    'rider': ['rider'],
    'store_keeper': ['inventory'],
}

# Roles that may be signed in on several devices at once. Everyone else: one device at a time.
MULTI_DEVICE_ROLES = {'super_admin', 'owner', 'admin'}


def role_label(key):
    return next((r['label'] for r in ROLES if r['key'] == key), key)


def sanitize(perms):
    seen = []
    for k in perms if isinstance(perms, list) else []:
        if k in PERMISSION_KEYS and k not in seen:
            seen.append(k)
    return seen


def role_permissions(restaurant_id, role):
    """Restaurant override → platform default override (restaurant=None) → built-in default."""
    if role == 'owner':
        return list(PERMISSION_KEYS)
    row = None
    if restaurant_id:
        row = RolePermission.objects.filter(restaurant_id=restaurant_id, role=role).first()
    if row is None:
        row = RolePermission.objects.filter(restaurant__isnull=True, role=role).first()
    if row is not None:
        return sanitize(row.permissions)
    return list(DEFAULT_ROLE_PERMISSIONS.get(role, []))


def has_custom(restaurant_id, role):
    if restaurant_id:
        return RolePermission.objects.filter(restaurant_id=restaurant_id, role=role).exists()
    return RolePermission.objects.filter(restaurant__isnull=True, role=role).exists()


def save_role_permissions(restaurant_id, role, permissions=None, reset=False):
    qs = RolePermission.objects.filter(role=role)
    qs = qs.filter(restaurant_id=restaurant_id) if restaurant_id else qs.filter(restaurant__isnull=True)
    if reset:
        qs.delete()
        return
    row = qs.first()
    if row:
        row.permissions = sanitize(permissions)
        row.save(update_fields=['permissions'])
    else:
        RolePermission.objects.create(restaurant_id=restaurant_id or None, role=role, permissions=sanitize(permissions))


def plan_features(plan_id):
    if not plan_id:
        return []
    plan = Plan.objects.filter(id=plan_id).only('features').first()
    return list(plan.features or []) if plan else []


def effective_permissions(restaurant, role):
    """Role permissions minus anything the restaurant's plan does not include."""
    perms = role_permissions(restaurant.id, role)
    features = set(plan_features(restaurant.plan_id))
    return [k for k in perms if not _FEATURE_OF.get(k) or _FEATURE_OF[k] in features]

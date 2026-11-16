import { parseJson } from './util.js';

/** Every permission in the system, with a human label and the plan feature it needs (if any). */
export const PERMISSIONS = [
  { key: 'dashboard', label: 'Dashboard & overview', group: 'General' },
  { key: 'pos', label: 'POS & tables — take orders, send KOT', group: 'Service' },
  { key: 'qr_orders', label: 'Accept QR (customer) orders', group: 'Service', feature: 'qr_ordering' },
  { key: 'open_any_table', label: 'Open a table another waiter is using', group: 'Service' },
  { key: 'kitchen', label: 'Kitchen display (KOT)', group: 'Kitchen' },
  { key: 'billing', label: 'Print bills & take payment', group: 'Billing' },
  { key: 'discounts', label: 'Give discounts', group: 'Billing' },
  { key: 'cancel_items', label: 'Cancel items / KOTs', group: 'Billing' },
  { key: 'bills', label: 'Find & reprint old bills', group: 'Billing' },
  { key: 'live_orders', label: 'Live orders board', group: 'Management' },
  { key: 'delivery', label: 'Manage delivery & assign riders', group: 'Delivery', feature: 'delivery' },
  { key: 'rider', label: 'Rider app — deliver orders', group: 'Delivery', feature: 'delivery' },
  { key: 'reports', label: 'Reports & insights', group: 'Management', feature: 'reports' },
  { key: 'menu', label: 'Menu & prices', group: 'Management' },
  { key: 'tables_manage', label: 'Tables, rooms & QR codes', group: 'Management' },
  { key: 'inventory', label: 'Stock & purchases', group: 'Management', feature: 'inventory' },
  { key: 'staff', label: 'Staff logins', group: 'Administration' },
  { key: 'roles', label: 'Role permissions', group: 'Administration' },
  { key: 'settings', label: 'Restaurant settings', group: 'Administration' },
  { key: 'subscription', label: 'Subscription & plan billing', group: 'Administration' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const FEATURES = [
  { key: 'qr_ordering', label: 'QR code table ordering' },
  { key: 'online_payments', label: 'Online payments (Razorpay) for guests' },
  { key: 'delivery', label: 'Home delivery & riders' },
  { key: 'reports', label: 'Reports & insights' },
  { key: 'inventory', label: 'Stock & purchases' },
  { key: 'multi_station', label: 'Multiple kitchen stations' },
  { key: 'offline_mode', label: 'Offline billing & sync' },
];

/** Restaurant roles. `owner` is the account holder and is always all-access. */
export const ROLES = [
  { key: 'owner', label: 'Owner', locked: true, description: 'Everything — orders, billing, reports, menu, staff, settings.' },
  { key: 'admin', label: 'Admin', description: 'Restaurant administrator — full management access.' },
  { key: 'manager', label: 'Manager', description: 'Runs the floor: orders, billing, discounts, cancellations, reports, menu.' },
  { key: 'captain', label: 'Captain (Waiter)', description: 'Takes table orders and sends them to the kitchen.' },
  { key: 'cashier', label: 'Cashier', description: 'Prints bills, takes payment, gives discounts.' },
  { key: 'kitchen', label: 'Kitchen', description: 'Kitchen screen — marks food preparing / ready.' },
  { key: 'rider', label: 'Rider', description: 'Delivers orders, collects cash on delivery.' },
  { key: 'store_keeper', label: 'Store keeper', description: 'Manages stock and purchases.' },
];
export const ROLE_KEYS = ROLES.map((r) => r.key);

const ALL = PERMISSION_KEYS;
export const DEFAULT_ROLE_PERMISSIONS = {
  owner: ALL,
  admin: ALL,
  manager: ['dashboard', 'pos', 'qr_orders', 'open_any_table', 'kitchen', 'billing', 'discounts', 'cancel_items',
    'bills', 'live_orders', 'delivery', 'reports', 'menu', 'tables_manage', 'inventory'],
  captain: ['pos', 'qr_orders'],
  cashier: ['pos', 'qr_orders', 'billing', 'discounts', 'bills', 'live_orders'],
  kitchen: ['kitchen'],
  rider: ['rider'],
  store_keeper: ['inventory'],
};

/** Roles that may be signed in on several devices at once. Everyone else: one device at a time. */
export const MULTI_DEVICE_ROLES = new Set(['super_admin', 'owner', 'admin']);

export function sanitizePermissions(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((k) => PERMISSION_KEYS.includes(k)))];
}

/** Role permissions before plan gating: restaurant override → platform default override → built-in default. */
export function rolePermissions(db, restaurantId, role) {
  if (role === 'owner') return [...ALL];
  const row = db.get('SELECT permissions FROM role_permissions WHERE restaurant_id = ? AND role = ?', restaurantId, role)
    || db.get('SELECT permissions FROM role_permissions WHERE restaurant_id = 0 AND role = ?', role);
  if (row) return sanitizePermissions(parseJson(row.permissions, []));
  return [...(DEFAULT_ROLE_PERMISSIONS[role] || [])];
}

export function planFeatures(db, planId) {
  if (!planId) return [];
  const plan = db.get('SELECT features FROM plans WHERE id = ?', planId);
  return plan ? parseJson(plan.features, []) : [];
}

/** Effective permissions = role permissions minus anything the restaurant's plan does not include. */
export function effectivePermissions(db, restaurant, role) {
  const perms = rolePermissions(db, restaurant.id, role);
  const features = new Set(planFeatures(db, restaurant.plan_id));
  return perms.filter((k) => {
    const def = PERMISSIONS.find((p) => p.key === k);
    return !def?.feature || features.has(def.feature);
  });
}

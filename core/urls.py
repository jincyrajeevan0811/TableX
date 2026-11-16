from django.urls import path, re_path

from . import pages
from .api import (admin, auth, delivery, inventory, kitchen, menu, orders, public, reports, restaurant, subscription, tables)
from .lib.http import route

api = [
    # Auth
    route('api/auth/login', POST=auth.login),
    route('api/auth/logout', POST=auth.logout),
    route('api/auth/me', GET=auth.me),
    route('api/auth/meta', GET=auth.meta),
    route('api/auth/pin', POST=auth.pin_switch),
    route('api/auth/pin/set', POST=auth.set_pin),
    route('api/auth/password', POST=auth.change_password),

    # Super Admin
    route('api/admin/meta', GET=admin.meta),
    route('api/admin/stats', GET=admin.stats),
    route('api/admin/plans', GET=admin.plans_list, POST=admin.plans_create),
    route('api/admin/plans/<int:id>', PUT=admin.plans_update, DELETE=admin.plans_delete),
    route('api/admin/restaurants', GET=admin.restaurants_list, POST=admin.restaurants_create),
    route('api/admin/restaurants/<int:id>', GET=admin.restaurant_detail, PUT=admin.restaurants_update),
    route('api/admin/restaurants/<int:id>/status', POST=admin.restaurant_status),
    route('api/admin/restaurants/<int:id>/subscription', POST=admin.restaurant_subscription),
    route('api/admin/restaurants/<int:id>/owner-password', POST=admin.restaurant_owner_password),
    route('api/admin/restaurants/<int:id>/roles/<str:role>', PUT=admin.restaurant_role),
    route('api/admin/roles', GET=admin.default_roles),
    route('api/admin/roles/<str:role>', PUT=admin.default_role_update),
    route('api/admin/subscriptions', GET=admin.subscriptions_list),

    # Restaurant administration
    route('api/settings', GET=restaurant.settings_get, PUT=restaurant.settings_put),
    route('api/staff', GET=restaurant.staff_list, POST=restaurant.staff_create),
    route('api/staff/<int:id>', PUT=restaurant.staff_update),
    route('api/staff/<int:id>/active', POST=restaurant.staff_active),
    route('api/roles', GET=restaurant.roles_get),
    route('api/roles/<str:role>', PUT=restaurant.roles_put),
    route('api/notifications', GET=restaurant.notifications),
    route('api/notifications/read', POST=restaurant.notifications_read),
    route('api/dashboard', GET=restaurant.dashboard),

    # Menu
    route('api/menu', GET=menu.menu_get),
    route('api/menu/categories', POST=menu.category_create),
    route('api/menu/categories/<int:id>', PUT=menu.category_update, DELETE=menu.category_delete),
    route('api/menu/items', POST=menu.item_create),
    route('api/menu/items/bulk-delete', POST=menu.items_bulk_delete),
    route('api/menu/items/<int:id>', PUT=menu.item_update, DELETE=menu.item_delete),
    route('api/menu/items/<int:id>/availability', POST=menu.item_availability),
    route('api/menu/import', POST=menu.menu_import),

    # Tables
    route('api/tables', GET=tables.tables_list, POST=tables.tables_create),
    route('api/tables/qr', GET=tables.tables_qr),
    route('api/tables/<int:id>', PUT=tables.table_update, DELETE=tables.table_delete),
    route('api/tables/<int:id>/regenerate-qr', POST=tables.table_regenerate_qr),
    route('api/tables/<int:id>/open', POST=tables.table_open),
    route('api/tables/<int:id>/close', POST=tables.table_close),
    route('api/tables/<int:id>/status', POST=tables.table_status),

    # Orders, billing, QR acceptance, live orders, bills
    route('api/orders/kot', POST=orders.kot),
    route('api/orders', GET=orders.orders_list),
    route('api/orders/<int:id>', GET=orders.order_get, PATCH=orders.order_patch),
    route('api/orders/<int:id>/move', POST=orders.order_move),
    route('api/orders/<int:id>/cancel', POST=orders.order_cancel),
    route('api/orders/<int:id>/bill', POST=orders.order_bill),
    route('api/orders/<int:id>/pay', POST=orders.order_pay),
    route('api/orders/<int:id>/razorpay', POST=orders.order_razorpay),
    route('api/orders/<int:id>/razorpay/verify', POST=orders.order_razorpay_verify),
    route('api/orders/<int:id>/accept', POST=orders.order_accept),
    route('api/orders/<int:id>/reject', POST=orders.order_reject),
    route('api/order-items/<int:id>/cancel', POST=orders.item_cancel),
    route('api/qr-orders', GET=orders.qr_orders),
    route('api/live-orders', GET=orders.live_orders),
    route('api/bills', GET=orders.bills),

    # Kitchen
    route('api/kitchen', GET=kitchen.kitchen),
    route('api/kitchen/kots/<int:id>/advance', POST=kitchen.kot_advance),
    route('api/kitchen/kots/<int:id>/cancel', POST=kitchen.kot_cancel),

    # Delivery & rider
    route('api/delivery', GET=delivery.delivery),
    route('api/delivery/<int:id>/assign', POST=delivery.assign),
    route('api/rider', GET=delivery.rider_home),
    route('api/rider/online', POST=delivery.rider_online),
    route('api/rider/orders/<int:id>/accept', POST=delivery.rider_accept),
    route('api/rider/orders/<int:id>/pickup', POST=delivery.rider_pickup),
    route('api/rider/orders/<int:id>/deliver', POST=delivery.rider_deliver),

    # Reports & stock
    route('api/reports/daily-items', GET=reports.daily_items),
    route('api/reports/summary', GET=reports.summary),
    route('api/inventory', GET=inventory.inventory),
    route('api/inventory/items', POST=inventory.item_create),
    route('api/inventory/items/<int:id>', PUT=inventory.item_update, DELETE=inventory.item_delete),
    route('api/inventory/moves', POST=inventory.move),

    # Subscription & payments
    route('api/subscription', GET=subscription.subscription),
    route('api/subscription/checkout', POST=subscription.checkout),
    route('api/subscription/verify', POST=subscription.verify),
    route('api/webhooks/razorpay', POST=subscription.webhook),

    # Guest QR ordering (public)
    route('api/public/t/<str:token>', GET=public.menu),
    route('api/public/t/<str:token>/status', GET=public.status),
    route('api/public/t/<str:token>/order', POST=public.place_order),
    route('api/public/t/<str:token>/call-waiter', POST=public.call_waiter),
    route('api/public/t/<str:token>/pay', POST=public.pay),
    route('api/public/t/<str:token>/pay/verify', POST=public.pay_verify),
]

urlpatterns = api + [
    re_path(r'^api/', pages.api_not_found),
    path('sw.js', pages.service_worker),
    path('m/<str:token>', pages.guest_menu),
    path('', pages.app),
]

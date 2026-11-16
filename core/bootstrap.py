"""First-run data: default subscription plans and the Super Admin login (runs after every `migrate`, idempotent)."""
from django.conf import settings

DEFAULT_PLANS = [
    {'name': 'Average', 'code': 'average', 'description': 'For cafés and small restaurants getting started.',
     'price_monthly': 999, 'price_yearly': 9990, 'max_tables': 12, 'max_staff': 6, 'max_menu_items': 150,
     'features': ['qr_ordering', 'offline_mode', 'reports'], 'highlight': False, 'sort': 1},
    {'name': 'Medium', 'code': 'medium', 'description': 'For busy restaurants with delivery and online payments.',
     'price_monthly': 1999, 'price_yearly': 19990, 'max_tables': 30, 'max_staff': 20, 'max_menu_items': 500,
     'features': ['qr_ordering', 'offline_mode', 'reports', 'delivery', 'online_payments', 'multi_station'], 'highlight': True, 'sort': 2},
    {'name': 'Premium', 'code': 'premium', 'description': 'Everything in TableX, for large and multi-counter outlets.',
     'price_monthly': 3999, 'price_yearly': 39990, 'max_tables': 200, 'max_staff': 100, 'max_menu_items': 2000,
     'features': ['qr_ordering', 'offline_mode', 'reports', 'delivery', 'online_payments', 'multi_station', 'inventory'],
     'highlight': False, 'sort': 3},
]


def bootstrap(sender=None, **kwargs):
    from .models import Plan, User
    if not Plan.objects.exists():
        for p in DEFAULT_PLANS:
            Plan.objects.create(**p)
    if not User.objects.filter(role='super_admin').exists():
        t = settings.TABLEX
        User.objects.create_superuser(t['SUPERADMIN_PHONE'], t['SUPERADMIN_PASSWORD'], name=t['SUPERADMIN_NAME'],
                                      email=(t['SUPERADMIN_EMAIL'] or '').lower() or None)

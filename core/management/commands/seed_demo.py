"""python manage.py seed_demo — one demo restaurant with staff for every role, a menu, tables and a week of sales."""
import datetime as dt
import random
from types import SimpleNamespace

from django.core.management.base import BaseCommand
from django.db import transaction

from core.bootstrap import bootstrap
from core.lib.auth import DEFAULT_SETTINGS, hash_secret, restaurant_settings
from core.lib.orders import generate_bill, record_payments, send_kot
from core.lib.subscriptions import activate_subscription
from core.lib.util import now, random_token
from core.models import (Category, DiningTable, InventoryItem, Kot, MenuItem, Order, OrderItem, Payment, Plan, Restaurant,
                         RiderStatus, User)

PASSWORD = 'Demo@123'
STAFF = [
    ('owner', 'Meera Nair', '9876500001', '1111'), ('admin', 'Rahul Menon', '9876500002', '2222'),
    ('manager', 'Anita Joseph', '9876500003', '3333'), ('captain', 'Arjun Das', '9876500004', '4444'),
    ('captain', 'Fathima K', '9876500005', '5555'), ('cashier', 'Vinod Kumar', '9876500006', '6666'),
    ('kitchen', 'Chef Thomas', '9876500007', '7777'), ('rider', 'Sanjay R', '9876500008', '8888'),
    ('store_keeper', 'Lakshmi P', '9876500009', '9999'),
]
MENU = {
    'Starters': [('Chicken 65', 220, 0, 'Main Kitchen'), ('Paneer Tikka', 240, 1, 'Tandoor'), ('Gobi Manchurian', 160, 1, 'Main Kitchen'),
                 ('Fish Fry (Seer)', 320, 0, 'Main Kitchen'), ('Crispy Corn', 150, 1, 'Main Kitchen')],
    'Biriyani': [('Chicken Dum Biriyani', 260, 0, 'Main Kitchen'), ('Mutton Biriyani', 340, 0, 'Main Kitchen'), ('Veg Biriyani', 190, 1, 'Main Kitchen'),
                 ('Prawns Biriyani', 360, 0, 'Main Kitchen'), ('Egg Biriyani', 180, 0, 'Main Kitchen')],
    'Main Course': [('Butter Chicken', 290, 0, 'Main Kitchen'), ('Kerala Beef Roast', 260, 0, 'Main Kitchen'),
                    ('Paneer Butter Masala', 240, 1, 'Main Kitchen'), ('Dal Tadka', 160, 1, 'Main Kitchen'), ('Fish Curry Meals', 210, 0, 'Main Kitchen')],
    'Breads': [('Kerala Parotta', 25, 1, 'Tandoor'), ('Butter Naan', 45, 1, 'Tandoor'), ('Tandoori Roti', 30, 1, 'Tandoor'), ('Garlic Naan', 60, 1, 'Tandoor')],
    'Hot Drinks': [('Masala Chai', 30, 1, 'Beverages'), ('Filter Coffee', 40, 1, 'Beverages'), ('Ginger Lemon Tea', 35, 1, 'Beverages')],
    'Cool Drinks': [('Fresh Lime Soda', 60, 1, 'Beverages'), ('Mango Lassi', 90, 1, 'Beverages'), ('Cold Coffee', 110, 1, 'Beverages'),
                    ('Watermelon Juice', 80, 1, 'Beverages')],
    'Desserts': [('Gulab Jamun (2 pc)', 70, 1, 'Beverages'), ('Tender Coconut Pudding', 120, 1, 'Beverages'), ('Chocolate Brownie', 140, 1, 'Beverages')],
}


class Command(BaseCommand):
    help = 'Create the "Spice Route Kitchen" demo restaurant (skips if it already exists).'

    def add_arguments(self, parser):
        parser.add_argument('--no-history', action='store_true', help='Skip the week of demo sales.')

    @transaction.atomic
    def handle(self, *args, **opts):
        bootstrap()
        if Restaurant.objects.filter(slug='spice-route-kitchen').exists():
            self.stdout.write('Demo restaurant already exists — nothing to do.')
            return
        plan = Plan.objects.filter(code='premium').first() or Plan.objects.order_by('-sort').first()
        ts = now()
        r = Restaurant.objects.create(
            name='Spice Route Kitchen', slug='spice-route-kitchen', owner_name=STAFF[0][1], phone=STAFF[0][2], email='hello@spiceroute.example',
            address='MG Road, Ernakulam', city='Kochi', status='active', plan=plan, created_at=ts,
            settings={**DEFAULT_SETTINGS, 'stations': ['Main Kitchen', 'Tandoor', 'Beverages'], 'bill_footer': 'Thank you for dining with us! Visit again.'})
        activate_subscription(restaurant_id=r.id, plan_id=plan.id, cycle='yearly', amount=plan.price_yearly, source='manual', note='Demo account')

        users = {}
        for role, name, phone, pin in STAFF:
            u = User.objects.create_user(phone, PASSWORD, restaurant=r, name=name, role=role, pin_hash=hash_secret(pin), created_at=ts)
            users.setdefault(role, u)
        RiderStatus.objects.create(user=users['rider'], online=True, updated_at=ts)

        tables = [DiningTable.objects.create(restaurant=r, name=f'T{i}', area='Main Hall', seats=6 if i % 3 == 0 else 4,
                                             qr_token=random_token(9), sort=i, created_at=ts) for i in range(1, 11)]
        tables += [DiningTable.objects.create(restaurant=r, name=f'R{i}', area='Rooftop', seats=2, qr_token=random_token(9),
                                              sort=10 + i, created_at=ts) for i in range(1, 5)]
        item_ids = []
        for sort, (cat, items) in enumerate(MENU.items(), start=1):
            c = Category.objects.create(restaurant=r, name=cat, sort=sort, created_at=ts)
            for name, price, veg, station in items:
                item_ids.append(MenuItem.objects.create(restaurant=r, category=c, name=name, price=price, veg=bool(veg), station=station, created_at=ts).id)
        for name, unit, qty, reorder, cost in [('Basmati Rice', 'kg', 42, 15, 120), ('Chicken', 'kg', 18, 10, 220), ('Mutton', 'kg', 6, 5, 720),
                                               ('Paneer', 'kg', 4, 3, 360), ('Cooking Oil', 'L', 25, 10, 140), ('Milk', 'L', 12, 8, 56), ('Onion', 'kg', 30, 10, 38)]:
            InventoryItem.objects.create(restaurant=r, name=name, unit=unit, qty=qty, reorder_level=reorder, cost=cost, created_at=ts)

        if not opts['no_history']:
            self._history(r, users, tables, item_ids)
        self.stdout.write(self.style.SUCCESS(f'Seeded "{r.name}". All demo staff use password {PASSWORD}:'))
        for role, name, phone, pin in STAFF:
            self.stdout.write(f'  {role:<13} {phone}  (PIN {pin})  {name}')

    def _history(self, r, users, tables, item_ids):
        r.refresh_from_db()
        mk = lambda u: SimpleNamespace(rid=r.id, restaurant=r, settings=restaurant_settings(r), user=u)  # noqa: E731
        pick = lambda k: [{'menu_item_id': random.choice(item_ids), 'qty': random.randint(1, 2)} for _ in range(k)]  # noqa: E731
        methods = ['cash', 'upi', 'upi', 'card']
        for day in range(6, -1, -1):
            count = 6 + random.randint(0, 7) + (-3 if day == 0 else 0)
            for k in range(count):
                captain = users['captain'] if k % 2 else users['manager']
                takeaway = k % 5 == 0
                order, _ = send_kot(mk(captain), type='takeaway' if takeaway else 'dine_in', table_id=None if takeaway else tables[k % len(tables)].id,
                                    items=pick(2 + k % 3), force=True)
                kwargs = {'discount_type': 'percent', 'discount_value': 10} if k % 7 == 0 else {}
                o = generate_bill(mk(users['cashier']), order.id, **kwargs)
                record_payments(mk(users['cashier']), order.id, [{'method': methods[k % 4], 'amount': o.total}])
                at = now() - dt.timedelta(days=day, minutes=(k + 1) * 23)
                Order.objects.filter(id=order.id).update(created_at=at, billed_at=at, paid_at=at, updated_at=at)
                OrderItem.objects.filter(order_id=order.id).update(status='served', created_at=at)
                Kot.objects.filter(order_id=order.id).update(status='served', created_at=at, served_at=at)
                Payment.objects.filter(order_id=order.id).update(created_at=at)
        send_kot(mk(users['captain']), type='dine_in', table_id=tables[1].id, items=pick(3), force=True)
        send_kot(mk(users['captain']), type='dine_in', table_id=tables[4].id, items=pick(2), force=True)
        DiningTable.objects.filter(id=tables[7].id).update(status='reserved')

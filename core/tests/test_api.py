"""End-to-end API tests — every role and flow, mirroring how the web app calls the API."""
import hashlib
import hmac
import json

from django.conf import settings
from django.test import TestCase, override_settings

from core.lib.razorpay import verify_payment_signature, verify_webhook_signature

TABLEX = {**settings.TABLEX, 'RAZORPAY_KEY_ID': '', 'RAZORPAY_KEY_SECRET': '', 'ALLOW_DEMO_PAYMENTS': True,
          'SUPERADMIN_PHONE': '9000000000', 'SUPERADMIN_PASSWORD': 'ChangeMe@123'}


@override_settings(TABLEX=TABLEX)
class EndToEndTests(TestCase):
    def call(self, method, url, token=None, body=None):
        headers = {'HTTP_AUTHORIZATION': f'Bearer {token}'} if token else {}
        resp = self.client.generic(method, url, data=json.dumps(body) if body is not None else '', content_type='application/json', **headers)
        try:
            data = resp.json()
        except ValueError:
            data = None
        return resp.status_code, data

    def ok(self, method, url, token=None, body=None):
        status, data = self.call(method, url, token, body)
        self.assertLess(status, 300, f'{method} {url} → {status} {data}')
        return data

    def login(self, login, password):
        return self.ok('POST', '/api/auth/login', body={'login': login, 'password': password})['token']

    # ------------------------------------------------------------------
    def test_full_restaurant_lifecycle(self):
        S = {}
        steps = [m for m in sorted(dir(self)) if m.startswith('step_')]
        self.assertGreater(len(steps), 15)
        for name in steps:
            with self.subTest(step=name):
                getattr(self, name)(S)

    def step_01_super_admin_plans(self, S):
        S['sa'] = self.login('9000000000', 'ChangeMe@123')
        plans = self.ok('GET', '/api/admin/plans', S['sa'])
        self.assertEqual([p['name'] for p in plans], ['Average', 'Medium', 'Premium'])
        S['medium'] = next(p for p in plans if p['code'] == 'medium')
        self.assertEqual(self.call('POST', '/api/auth/login', body={'login': '9000000000', 'password': 'nope'})[0], 401)

    def step_02_custom_plan(self, S):
        p = self.ok('POST', '/api/admin/plans', S['sa'], {'name': 'Starter Lite', 'price_monthly': 499, 'price_yearly': 4990, 'max_tables': 3,
                                                        'max_staff': 3, 'features': ['qr_ordering', 'bogus']})
        self.assertEqual(p['features'], ['qr_ordering'])
        S['lite'] = p

    def step_03_onboard_pending(self, S):
        r = self.ok('POST', '/api/admin/restaurants', S['sa'], {'name': 'Test Bistro', 'owner_name': 'Olivia Owner', 'phone': '9811111111',
                                                              'password': 'Owner@123', 'plan_id': S['medium']['id'], 'access': 'pending', 'tables': 4})
        S['rid'] = r['id']
        S['owner'] = self.login('9811111111', 'Owner@123')
        self.assertFalse(self.ok('GET', '/api/auth/me', S['owner'])['subscription']['active'])
        self.assertEqual(self.call('GET', '/api/tables', S['owner'])[0], 402)
        self.assertTrue(self.ok('GET', '/api/subscription', S['owner'])['demo'])

    def step_04_buy_plan(self, S):
        co = self.ok('POST', '/api/subscription/checkout', S['owner'], {'plan_id': S['medium']['id'], 'cycle': 'monthly'})
        self.assertTrue(co['demo'])
        self.assertEqual(co['amount'], S['medium']['price_monthly'] * 100)
        v = self.ok('POST', '/api/subscription/verify', S['owner'], {'razorpay_order_id': co['order_id'], 'razorpay_payment_id': 'demo_pay_1', 'razorpay_signature': 'demo'})
        again = self.ok('POST', '/api/subscription/verify', S['owner'], {'razorpay_order_id': co['order_id'], 'razorpay_payment_id': 'demo_pay_1'})
        self.assertEqual(again['ends_at'], v['ends_at'], 'verifying twice must not extend twice')
        self.ok('GET', '/api/tables', S['owner'])

    def step_05_setup(self, S):
        for name, phone, role, pin in [('Cara Captain', '9822222222', 'captain', '1234'), ('Cody Captain', '9822222223', 'captain', '2345'),
                                       ('Cash Carl', '9833333333', 'cashier', '3456'), ('Kitchen Kim', '9844444444', 'kitchen', ''),
                                       ('Rider Ravi', '9855555555', 'rider', ''), ('Adam Admin', '9866666666', 'admin', '')]:
            self.ok('POST', '/api/staff', S['owner'], {'name': name, 'phone': phone, 'role': role, 'password': 'Staff@123', 'pin': pin})
        self.assertEqual(self.call('POST', '/api/staff', S['owner'], {'name': 'X', 'phone': '9877777777', 'role': 'captain', 'password': 'Staff@123', 'pin': '1234'})[0], 409)
        imp = self.ok('POST', '/api/menu/import', S['owner'], {'csv': 'name,category,price,veg\nChicken Biriyani, Biriyani, 250, non_veg\nVeg Biriyani, Biriyani, 180, veg\n"Tea, Masala", Hot Drinks, 30, veg\nbroken line'})
        self.assertEqual(imp['imported'], 3)
        self.assertEqual(len(imp['errors']), 1)
        menu = self.ok('GET', '/api/menu', S['owner'])
        S['items'] = {i['name']: i for i in menu['items']}
        self.assertIn('Tea, Masala', S['items'])
        self.ok('PUT', '/api/settings', S['owner'], {'settings': {'gst_enabled': True, 'gst_percent': 5, 'service_charge_percent': 10, 'round_off': True}})
        S['tables'] = self.ok('GET', '/api/tables', S['owner'])
        self.assertEqual(len(S['tables']), 4)

    def step_06_table_lock(self, S):
        S['cap1'] = self.login('9822222222', 'Staff@123')
        S['cap2'] = self.login('9822222223', 'Staff@123')
        t1 = S['tables'][0]
        self.assertIsNone(self.ok('POST', f"/api/tables/{t1['id']}/open", S['cap1'])['order'])
        status, data = self.call('POST', f"/api/tables/{t1['id']}/open", S['cap2'])
        self.assertEqual(status, 423)
        self.assertIn('being served by Cara Captain', data['error'])
        self.assertTrue(self.ok('POST', f"/api/tables/{t1['id']}/open", S['owner'])['openedAsOwner'])

    def step_07_kot(self, S):
        t1 = S['tables'][0]
        items = [{'menu_item_id': S['items']['Chicken Biriyani']['id'], 'qty': 2, 'note': 'less spicy'}, {'menu_item_id': S['items']['Tea, Masala']['id'], 'qty': 1}]
        r = self.ok('POST', '/api/orders/kot', S['cap1'], {'type': 'dine_in', 'table_id': t1['id'], 'items': items, 'client_key': 'k-1'})
        S['order'] = r['order']
        self.assertEqual(len(r['order']['items']), 2)
        # subtotal 530, service 10% = 53, GST 5% of 583 = 29.15, gross 612.15 → 612
        self.assertEqual(r['order']['subtotal'], 530)
        self.assertEqual(r['order']['service_charge'], 53)
        self.assertEqual(r['order']['tax'], 29.15)
        self.assertEqual(r['order']['total'], 612)
        replay = self.ok('POST', '/api/orders/kot', S['cap1'], {'type': 'dine_in', 'table_id': t1['id'], 'items': items, 'client_key': 'k-1'})
        self.assertTrue(replay['replayed'])
        self.assertEqual(len(replay['order']['items']), 2)
        status, dup = self.call('POST', '/api/orders/kot', S['cap1'], {'type': 'dine_in', 'table_id': t1['id'], 'items': items, 'client_key': 'k-2'})
        self.assertEqual(status, 409)
        self.assertEqual(dup['code'], 'DUPLICATE_ITEMS')
        forced = self.ok('POST', '/api/orders/kot', S['cap1'], {'type': 'dine_in', 'table_id': t1['id'], 'items': [items[1]], 'client_key': 'k-3', 'force': True})
        self.assertEqual(len(forced['order']['items']), 3)
        self.assertEqual(next(t for t in self.ok('GET', '/api/tables', S['cap1']) if t['id'] == t1['id'])['status'], 'occupied')
        self.assertEqual(self.call('POST', '/api/orders/kot', S['cap2'], {'type': 'dine_in', 'table_id': t1['id'], 'items': [items[1]]})[0], 423)

    def step_08_kitchen(self, S):
        S['kitchen'] = self.login('9844444444', 'Staff@123')
        k = self.ok('GET', '/api/kitchen', S['kitchen'])
        self.assertGreaterEqual(len(k['kots']), 1)
        kot = k['kots'][0]
        for expected in ('preparing', 'ready', 'served'):
            self.assertEqual(self.ok('POST', f"/api/kitchen/kots/{kot['id']}/advance", S['kitchen'], {})['status'], expected)
        self.assertEqual(self.call('GET', '/api/reports/daily-items', S['kitchen'])[0], 403)

    def step_09_billing(self, S):
        oid = S['order']['id']
        self.assertEqual(self.call('POST', f'/api/orders/{oid}/bill', S['cap1'], {})[0], 403)
        S['cashier'] = self.login('9833333333', 'Staff@123')
        billed = self.ok('POST', f'/api/orders/{oid}/bill', S['cashier'], {'discount_type': 'amount', 'discount_value': 60})
        self.assertEqual(billed['status'], 'billed')
        self.assertRegex(billed['bill_no'], r'^TX\d{5}$')
        self.assertEqual(self.call('POST', f'/api/orders/{oid}/pay', S['cashier'], {'payments': [{'method': 'cash', 'amount': billed['total'] + 100}]})[0], 400)
        part = self.ok('POST', f'/api/orders/{oid}/pay', S['cashier'], {'payments': [{'method': 'cash', 'amount': 200}]})
        self.assertEqual(part['status'], 'billed')
        done = self.ok('POST', f'/api/orders/{oid}/pay', S['cashier'], {'payments': [{'method': 'upi', 'amount': part['balance'], 'reference': 'UPI123'}]})
        self.assertEqual(done['status'], 'paid')
        t1 = next(t for t in self.ok('GET', '/api/tables', S['cashier']) if t['id'] == S['tables'][0]['id'])
        self.assertEqual(t1['status'], 'free')
        self.assertIsNone(t1['lock_user_id'])
        self.assertEqual(len(self.ok('GET', f"/api/bills?q={billed['bill_no']}", S['cashier'])['bills']), 1)

    def step_10_qr_ordering(self, S):
        tok = S['tables'][1]['qr_token']
        pub = self.ok('GET', f'/api/public/t/{tok}')
        self.assertTrue(pub['ordering'])
        self.assertTrue(pub['pay_online'])
        placed = self.ok('POST', f'/api/public/t/{tok}/order', body={'name': 'Guest Gita', 'items': [{'menu_item_id': S['items']['Veg Biriyani']['id'], 'qty': 2}]})
        self.assertEqual(placed['order']['items'][0]['status'], 'pending')
        self.assertEqual(self.call('POST', f'/api/public/t/{tok}/pay', body={})[0], 409, 'cannot pay before staff accept')
        self.assertEqual(len(self.ok('GET', '/api/qr-orders', S['cap2'])), 1)
        self.assertTrue(any(n['type'] == 'qr_order' for n in self.ok('GET', '/api/notifications', S['cap2'])['items']))
        self.ok('POST', f"/api/orders/{placed['order']['id']}/accept", S['cap2'])
        self.ok('POST', f'/api/public/t/{tok}/call-waiter', body={'reason': 'bill'})
        co = self.ok('POST', f'/api/public/t/{tok}/pay', body={})
        self.assertTrue(co['demo'])
        self.ok('POST', f'/api/public/t/{tok}/pay/verify', body={'razorpay_order_id': co['order_id'], 'razorpay_payment_id': 'demo_pay_2'})
        o = self.ok('GET', f"/api/orders/{placed['order']['id']}", S['owner'])
        self.assertEqual(o['status'], 'paid')
        self.assertEqual(o['payments'][0]['method'], 'razorpay')

    def step_11_delivery(self, S):
        S['rider'] = self.login('9855555555', 'Staff@123')
        r = self.ok('POST', '/api/orders/kot', S['cap1'], {'type': 'delivery', 'customer': {'name': 'Dev', 'phone': '9000011111', 'address': '12 Lake Road'},
                                                         'items': [{'menu_item_id': S['items']['Chicken Biriyani']['id'], 'qty': 1}]})
        oid = r['order']['id']
        self.assertEqual(self.call('POST', f'/api/delivery/{oid}/assign', S['owner'], {'auto': True})[0], 409)
        self.ok('POST', '/api/rider/online', S['rider'], {'online': True})
        assigned = self.ok('POST', f'/api/delivery/{oid}/assign', S['owner'], {'auto': True})
        self.assertEqual(assigned['rider_name'], 'Rider Ravi')
        self.assertEqual(assigned['delivery_fee'], 30)
        mine = self.ok('GET', '/api/rider', S['rider'])
        self.assertEqual(len(mine['orders']), 1)
        self.assertNotIn('delivery_otp', mine['orders'][0], 'rider must not see the OTP')
        self.ok('POST', f'/api/rider/orders/{oid}/accept', S['rider'])
        self.ok('POST', f'/api/rider/orders/{oid}/pickup', S['rider'])
        wrong = '1111' if assigned['delivery_otp'] == '0000' else '0000'
        self.assertEqual(self.call('POST', f'/api/rider/orders/{oid}/deliver', S['rider'], {'otp': wrong})[0], 400)
        delivered = self.ok('POST', f'/api/rider/orders/{oid}/deliver', S['rider'], {'otp': assigned['delivery_otp']})
        self.assertEqual(delivered['status'], 'paid')
        self.assertEqual(delivered['delivery_status'], 'delivered')
        self.assertEqual(self.ok('GET', '/api/rider', S['rider'])['cash_collected'], delivered['total'])

    def step_12_reports(self, S):
        r = self.ok('GET', '/api/reports/daily-items', S['owner'])
        self.assertEqual(r['totals']['orders'], 3)
        self.assertEqual(round(sum(m['amount'] for m in r['methods']), 2), r['totals']['net'])
        self.assertEqual(self.ok('GET', '/api/dashboard', S['owner'])['today']['orders'], 3)
        trends = self.ok('GET', '/api/reports/summary', S['owner'])
        self.assertEqual(len(trends['series']), 30)
        self.assertEqual(trends['orders'], 3)

    def step_13_one_device(self, S):
        fresh = self.login('9822222222', 'Staff@123')
        status, data = self.call('GET', '/api/auth/me', S['cap1'])
        self.assertEqual(status, 401)
        self.assertEqual(data['code'], 'SESSION_REPLACED')
        S['cap1'] = fresh
        owner_again = self.login('9811111111', 'Owner@123')
        self.ok('GET', '/api/auth/me', S['owner'])  # owners may use several devices
        S['owner'] = owner_again

    def step_14_pin_switch(self, S):
        self.assertEqual(self.ok('POST', '/api/auth/pin', S['cashier'], {'pin': '2345'})['user']['name'], 'Cody Captain')
        self.assertEqual(self.call('POST', '/api/auth/pin', S['cashier'], {'pin': '9999'})[0], 401)

    def step_15_role_permissions(self, S):
        self.ok('PUT', '/api/roles/captain', S['owner'], {'permissions': ['qr_orders']})
        self.assertEqual(self.call('GET', '/api/menu', S['cap1'])[0], 403)
        detail = self.ok('GET', f"/api/admin/restaurants/{S['rid']}", S['sa'])
        self.assertTrue(next(x for x in detail['roles'] if x['key'] == 'captain')['custom'])
        self.ok('PUT', f"/api/admin/restaurants/{S['rid']}/roles/captain", S['sa'], {'reset': True})
        self.ok('GET', '/api/menu', S['cap1'])
        self.assertEqual(self.call('PUT', '/api/roles/owner', S['owner'], {'permissions': []})[0], 400)

    def step_16_plan_features(self, S):
        me = self.ok('GET', '/api/auth/me', S['owner'])
        self.assertNotIn('inventory', me['permissions'])
        self.assertIn('delivery', me['permissions'])
        self.assertEqual(self.call('GET', '/api/inventory', S['owner'])[0], 403)

    def step_17_plan_limits(self, S):
        self.ok('POST', f"/api/admin/restaurants/{S['rid']}/subscription", S['sa'], {'plan_id': S['lite']['id'], 'cycle': 'monthly', 'amount': 0})
        status, data = self.call('POST', '/api/tables', S['owner'], {'name': 'T99'})
        self.assertEqual(status, 403)
        self.assertEqual(data['code'], 'PLAN_LIMIT')
        self.ok('POST', f"/api/admin/restaurants/{S['rid']}/subscription", S['sa'], {'plan_id': S['medium']['id'], 'cycle': 'monthly'})

    def step_18_access_control(self, S):
        self.ok('POST', f"/api/admin/restaurants/{S['rid']}/status", S['sa'], {'status': 'suspended'})
        status, data = self.call('GET', '/api/tables', S['owner'])
        self.assertEqual(status, 403)
        self.assertEqual(data['code'], 'RESTAURANT_SUSPENDED')
        self.assertFalse(self.ok('GET', f"/api/public/t/{S['tables'][2]['qr_token']}")['ordering'])
        self.ok('POST', f"/api/admin/restaurants/{S['rid']}/status", S['sa'], {'status': 'active'})
        self.ok('GET', '/api/tables', S['owner'])
        self.assertEqual(self.ok('GET', '/api/admin/stats', S['sa'])['restaurants']['total'], 1)
        self.assertEqual(self.call('GET', '/api/admin/stats', S['owner'])[0], 403)

    def step_19_isolation(self, S):
        self.ok('POST', '/api/admin/restaurants', S['sa'], {'name': 'Other Place', 'owner_name': 'Otto', 'phone': '9899999999', 'password': 'Other@123',
                                                          'plan_id': S['medium']['id'], 'access': 'trial', 'tables': 1})
        other = self.login('9899999999', 'Other@123')
        self.assertEqual(self.call('GET', f"/api/orders/{S['order']['id']}", other)[0], 404)
        self.assertEqual(self.call('POST', '/api/orders/kot', other, {'type': 'takeaway', 'items': [{'menu_item_id': S['items']['Veg Biriyani']['id'], 'qty': 1}]})[0], 400)

    def step_20_admin_screens(self, S):
        for url in ('/api/admin/meta', '/api/admin/restaurants', '/api/admin/subscriptions', '/api/admin/roles'):
            self.ok('GET', url, S['sa'])
        for url in ('/api/live-orders', '/api/orders', '/api/delivery', '/api/staff', '/api/roles', '/api/settings', '/api/tables/qr', '/api/bills'):
            self.ok('GET', url, S['owner'])

    # ------------------------------------------------------------------
    def test_razorpay_signatures(self):
        sig = hmac.new(b'test_secret', b'order_1|pay_1', hashlib.sha256).hexdigest()
        self.assertTrue(verify_payment_signature('test_secret', 'order_1', 'pay_1', sig))
        self.assertFalse(verify_payment_signature('test_secret', 'order_1', 'pay_2', sig))
        body = b'{"event":"payment.captured"}'
        wsig = hmac.new(b'wh', body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook_signature('wh', body, wsig))
        self.assertFalse(verify_webhook_signature('', body, wsig))
        resp = self.client.post('/api/webhooks/razorpay', data=body, content_type='application/json', HTTP_X_RAZORPAY_SIGNATURE='bad')
        self.assertEqual(resp.status_code, 400)

    def test_pages_served(self):
        home = self.client.get('/')
        self.assertContains(home, '<title>TableX')
        self.assertContains(home, '/static/js/app.js')
        self.assertContains(self.client.get('/m/anything'), 'js/order.js')
        self.assertEqual(self.client.get('/sw.js').status_code, 200)
        self.assertEqual(self.client.get('/api/nope').status_code, 404)
        self.assertEqual(self.client.delete('/api/auth/me').status_code, 405)

    def test_seed_demo_command(self):
        from django.core.management import call_command
        call_command('seed_demo', verbosity=0)
        tok = self.login('9876500001', 'Demo@123')
        dash = self.ok('GET', '/api/dashboard', tok)
        self.assertEqual(len(dash['days']), 7)
        self.assertGreater(sum(d['orders'] for d in dash['days']), 20)
        call_command('seed_demo', verbosity=0)  # idempotent

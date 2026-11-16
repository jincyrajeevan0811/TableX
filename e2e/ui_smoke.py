"""Browser smoke test: signs in as several roles and clicks through every TableX screen, failing on any JS error.
usage: python e2e/ui_smoke.py http://127.0.0.1:8000"""
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8000'
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)
errors = []


def new_page(browser, w=1440, h=900):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, service_workers='block')
    page = ctx.new_page()
    page.on('console', lambda m: m.type == 'error' and not re.search(r'fonts\.g|ERR_|Failed to load resource', m.text) and errors.append(f'[console] {page.url} {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'[pageerror] {page.url} {e}'))
    page.set_default_timeout(15000)
    return ctx, page


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, f'{name}.png'))


def login(page, who, pw):
    page.goto(BASE + '/')
    page.fill('[name=login]', who)
    page.fill('[name=password]', pw)
    page.click('button[type=submit]')
    page.wait_for_selector('#app')
    page.wait_for_timeout(700)


def visit(page, path, name, wait='.content > *'):
    page.goto(BASE + '/#' + path)
    page.wait_for_timeout(900)
    page.wait_for_selector(wait)
    if page.locator('.content:has-text("Could not open this screen")').count():
        errors.append(f'[screen] {path} failed to open')
    shot(page, name)
    print('ok', path)


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- Owner: every screen + a full order → kitchen → pay flow ----
    ctx, pg = new_page(browser)
    pg.goto(BASE + '/'); pg.wait_for_selector('[name=login]'); shot(pg, '01-login')
    login(pg, '9876500001', 'Demo@123'); shot(pg, '02-dashboard'); print('ok dashboard')
    visit(pg, '/pos', '03-pos', '.tcard')
    pg.click('[data-table]:has-text("T3")'); pg.wait_for_selector('.items-grid'); pg.wait_for_timeout(400)
    for item in ('Chicken Dum Biriyani', 'Chicken Dum Biriyani', 'Butter Naan', 'Masala Chai'):
        pg.click(f'.mitem:has-text("{item}")')
    shot(pg, '04-order'); pg.click('[data-kot]'); pg.wait_for_selector('.tcard'); pg.wait_for_timeout(600); print('ok send KOT')
    pg.click('[data-table]:has-text("T3")'); pg.wait_for_selector('[data-pay]:not([disabled])'); pg.wait_for_timeout(300)
    pg.click('[data-pay]'); pg.wait_for_selector('.modal [data-a=pay]'); shot(pg, '05-pay')
    pg.click('.modal [data-a=pay]'); pg.wait_for_selector('.tcard'); pg.wait_for_timeout(600); print('ok payment')
    status = pg.evaluate("""async () => { const r = await fetch('/api/tables', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.tx_token) } });
                            return (await r.json()).find((t) => t.name === 'T3').status; }""")
    if status != 'free':
        errors.append(f'[flow] T3 should be free after payment, got {status}')
    for path, name, wait in [('/kitchen', '06-kitchen', '.seg'), ('/live', '07-live', '.kpi'), ('/bills', '08-bills', '.card'),
                             ('/reports', '09-reports', '.kpi'), ('/menu', '10-menu', '.tbl'), ('/tables', '11-tables', '.tbl'),
                             ('/inventory', '12-stock', '.kpi'), ('/staff', '13-staff', '.tbl'), ('/settings', '14-settings', 'form'),
                             ('/subscription', '15-subscription', '.plan'), ('/delivery', '16-delivery', '.card'), ('/qr-orders', '17-qr', '.card'),
                             ('/account', '18-account', '.card')]:
        visit(pg, path, name, wait)
    pg.goto(BASE + '/#/reports'); pg.wait_for_selector('[data-tab=trends]'); pg.click('[data-tab=trends]'); pg.wait_for_timeout(800); print('ok trends')
    pg.goto(BASE + '/#/tables'); pg.wait_for_selector('[data-a=qr]'); pg.click('[data-a=qr]'); pg.wait_for_selector('.qr-card svg'); shot(pg, '19-qr'); print('ok qr codes')
    qr_url = pg.evaluate("""async () => { const r = await fetch('/api/tables/qr', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.tx_token) } });
                            return (await r.json()).tables[5].url; }""")
    ctx.close()

    # ---- Super Admin ----
    ctx, sa = new_page(browser)
    login(sa, '9000000000', 'ChangeMe@123'); shot(sa, '30-sa'); print('ok super admin')
    for path, name, wait in [('/admin/restaurants', '31-sa-restaurants', '.tbl'), ('/admin/plans', '32-sa-plans', '.plan'),
                             ('/admin/subscriptions', '33-sa-purchases', '.kpi'), ('/admin/roles', '34-sa-roles', '.matrix')]:
        visit(sa, path, name, wait)
    sa.goto(BASE + '/#/admin/restaurants'); sa.wait_for_selector('tr[data-id]'); sa.click('tr[data-id]'); sa.wait_for_selector('[data-tab=roles]')
    sa.click('[data-tab=roles]'); sa.wait_for_selector('.matrix'); shot(sa, '35-sa-detail'); print('ok restaurant detail')
    ctx.close()

    # ---- Guest QR ordering (mobile) ----
    ctx, g = new_page(browser, 390, 844)
    g.goto(qr_url); g.wait_for_selector('.g-item'); shot(g, '40-guest')
    g.click('.g-item:has-text("Paneer Tikka") [data-inc]'); g.click('[data-cart]'); g.wait_for_selector('[data-place]')
    g.click('[data-place]'); g.wait_for_selector('.status-card'); shot(g, '41-guest-status'); print('ok guest order')
    ctx.close()

    # ---- Captain accepts the QR order; rider screen ----
    ctx, m = new_page(browser, 390, 844)
    login(m, '9876500004', 'Demo@123')
    m.goto(BASE + '/#/qr-orders'); m.wait_for_selector('[data-accept]'); m.click('[data-accept]'); m.wait_for_timeout(800); shot(m, '50-captain'); print('ok accept QR')
    ctx.close()
    ctx, r = new_page(browser, 390, 844)
    login(r, '9876500008', 'Demo@123'); r.wait_for_selector('.big-toggle'); shot(r, '51-rider'); print('ok rider')
    ctx.close()
    browser.close()

print('\n'.join(errors) if errors else 'NO BROWSER ERRORS')
if errors:
    sys.exit(1)
print('E2E PASSED')

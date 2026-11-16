"""Razorpay Orders API + signature verification (no SDK needed)."""
import base64
import hashlib
import hmac
import json
import urllib.error
import urllib.request

from .http import HttpError
from .util import random_token

API = 'https://api.razorpay.com/v1'


def is_configured(keys):
    return bool(keys and keys.get('key_id') and keys.get('key_secret'))


def create_order(keys, amount, receipt, notes=None, allow_demo=True):
    """Create a Razorpay order. Without keys (and demo allowed) a local demo order is returned."""
    paise = int(round(float(amount) * 100))
    if paise < 100:
        raise HttpError(400, 'Amount must be at least ₹1.', 'AMOUNT_TOO_LOW')
    if not is_configured(keys):
        if not allow_demo:
            raise HttpError(503, 'Online payments are not configured yet.', 'PAYMENTS_NOT_CONFIGURED')
        return {'id': f'demo_order_{random_token(10)}', 'amount': paise, 'currency': 'INR', 'receipt': receipt, 'demo': True}
    auth = base64.b64encode(f"{keys['key_id']}:{keys['key_secret']}".encode()).decode()
    payload = json.dumps({'amount': paise, 'currency': 'INR', 'receipt': str(receipt)[:40], 'notes': notes or {}}).encode()
    req = urllib.request.Request(f'{API}/orders', data=payload, method='POST',
                                 headers={'Authorization': f'Basic {auth}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get('error', {}).get('description')
        except Exception:  # noqa: BLE001
            msg = None
        raise HttpError(502, msg or 'Could not reach Razorpay. Please try again.', 'GATEWAY_ERROR')
    except (urllib.error.URLError, TimeoutError):
        raise HttpError(502, 'Could not reach Razorpay. Please try again.', 'GATEWAY_ERROR')
    return {'id': data['id'], 'amount': data['amount'], 'currency': data['currency'], 'receipt': data.get('receipt'), 'demo': False}


def verify_payment_signature(key_secret, order_id, payment_id, signature):
    """Checkout handler: HMAC_SHA256(order_id + '|' + payment_id, key_secret)."""
    expected = hmac.new(str(key_secret).encode(), f'{order_id}|{payment_id}'.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(signature or ''))


def verify_webhook_signature(webhook_secret, raw_body, signature):
    if not webhook_secret:
        return False
    expected = hmac.new(str(webhook_secret).encode(), raw_body or b'', hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(signature or ''))

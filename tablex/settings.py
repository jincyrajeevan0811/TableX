"""TableX — Django settings. Every value can be overridden from the environment or a .env file."""
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_env(path):
    """Tiny .env loader (KEY=VALUE lines) so no extra package is needed."""
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env(BASE_DIR / '.env')
env = os.environ.get


def env_bool(name, default=False):
    return str(env(name, str(default))).lower() in ('1', 'true', 'yes', 'on')


SECRET_KEY = env('DJANGO_SECRET_KEY', 'dev-insecure-change-me-tablex')
DEBUG = env_bool('DJANGO_DEBUG', True)
ALLOWED_HOSTS = [h.strip() for h in env('DJANGO_ALLOWED_HOSTS', '*').split(',') if h.strip()]
CSRF_TRUSTED_ORIGINS = [o.strip() for o in env('DJANGO_CSRF_TRUSTED_ORIGINS', '').split(',') if o.strip()]

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'core.apps.CoreConfig',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'tablex.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'tablex.wsgi.application'

if env('DB_ENGINE', 'sqlite') == 'postgres':
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': env('DB_NAME', 'tablex'),
            'USER': env('DB_USER', 'tablex'),
            'PASSWORD': env('DB_PASSWORD', ''),
            'HOST': env('DB_HOST', 'localhost'),
            'PORT': env('DB_PORT', '5432'),
            'CONN_MAX_AGE': 60,
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / env('DB_FILE', 'db.sqlite3'),
            'OPTIONS': {'timeout': 20},
        }
    }

AUTH_USER_MODEL = 'core.User'
AUTH_PASSWORD_VALIDATORS = []
if 'test' in sys.argv:
    PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']  # fast tests

LANGUAGE_CODE = 'en-in'
TIME_ZONE = 'Asia/Kolkata'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    # No hashed names: the web app uses relative ES-module imports.
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedStaticFilesStorage'},
}
WHITENOISE_MAX_AGE = 300

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024

CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'SAMEORIGIN'
if not DEBUG:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': 'WARNING'},
}

# ---------------------------------------------------------------------------
# TableX
# ---------------------------------------------------------------------------
TABLEX = {
    'APP_URL': env('APP_URL', '').rstrip('/'),
    'SUPERADMIN_NAME': env('SUPERADMIN_NAME', 'TableX Super Admin'),
    'SUPERADMIN_PHONE': env('SUPERADMIN_PHONE', '9000000000'),
    'SUPERADMIN_EMAIL': env('SUPERADMIN_EMAIL', 'admin@tablex.app'),
    'SUPERADMIN_PASSWORD': env('SUPERADMIN_PASSWORD', 'ChangeMe@123'),
    'RAZORPAY_KEY_ID': env('RAZORPAY_KEY_ID', ''),
    'RAZORPAY_KEY_SECRET': env('RAZORPAY_KEY_SECRET', ''),
    'RAZORPAY_WEBHOOK_SECRET': env('RAZORPAY_WEBHOOK_SECRET', ''),
    'ALLOW_DEMO_PAYMENTS': env_bool('ALLOW_DEMO_PAYMENTS', True),
    'TRIAL_DAYS': int(env('TRIAL_DAYS', '14')),
    'SESSION_DAYS': 30,
}

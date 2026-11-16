"""HTML pages: the staff/Super Admin web app and the guest QR menu (Django templates + static files)."""
from django.contrib.staticfiles import finders
from django.http import FileResponse, Http404
from django.shortcuts import render
from django.views.decorators.cache import never_cache

from .lib.http import json_response


@never_cache
def app(request):
    """Single-page web app for every role (routing happens in the browser after #)."""
    return render(request, 'tablex/index.html')


@never_cache
def guest_menu(request, token):
    return render(request, 'tablex/order.html', {'token': token})


@never_cache
def service_worker(request):
    """Served from the site root so it can cache the whole app for offline use."""
    path = finders.find('sw.js')
    if not path:
        raise Http404
    resp = FileResponse(open(path, 'rb'), content_type='text/javascript')
    resp['Service-Worker-Allowed'] = '/'
    return resp


def api_not_found(request):
    return json_response({'error': 'Not found.', 'code': 'NOT_FOUND'}, 404)

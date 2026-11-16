from django.contrib import admin
from django.urls import include, path

admin.site.site_header = 'TableX administration'
admin.site.site_title = 'TableX'
admin.site.index_title = 'Data browser'

urlpatterns = [
    # Django's built-in admin (Super Admin can sign in with the same mobile number + password).
    path('django-admin/', admin.site.urls),
    path('', include('core.urls')),
]

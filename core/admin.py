"""Django admin — a raw data browser for the Super Admin (the main console is the TableX web app)."""
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from . import models


@admin.register(models.User)
class UserAdmin(BaseUserAdmin):
    ordering = ['id']
    list_display = ['name', 'phone', 'role', 'restaurant', 'is_active', 'last_login']
    list_filter = ['role', 'is_active']
    search_fields = ['name', 'phone', 'email']
    fieldsets = [
        (None, {'fields': ['phone', 'password']}),
        ('Profile', {'fields': ['name', 'email', 'restaurant', 'role']}),
        ('Access', {'fields': ['is_active', 'is_staff', 'is_superuser']}),
        ('Dates', {'fields': ['last_login', 'created_at']}),
    ]
    add_fieldsets = [(None, {'classes': ['wide'], 'fields': ['phone', 'name', 'role', 'restaurant', 'password1', 'password2']})]
    filter_horizontal = []


@admin.register(models.Plan)
class PlanAdmin(admin.ModelAdmin):
    list_display = ['name', 'price_monthly', 'price_yearly', 'max_tables', 'max_staff', 'active', 'sort']
    list_editable = ['active', 'sort']


@admin.register(models.Restaurant)
class RestaurantAdmin(admin.ModelAdmin):
    list_display = ['name', 'owner_name', 'phone', 'city', 'plan', 'status', 'subscription_ends_at']
    list_filter = ['status', 'plan']
    search_fields = ['name', 'owner_name', 'phone', 'city']


@admin.register(models.Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ['restaurant', 'plan', 'cycle', 'amount', 'status', 'source', 'starts_at', 'ends_at']
    list_filter = ['status', 'source', 'plan']


class OrderItemInline(admin.TabularInline):
    model = models.OrderItem
    extra = 0
    fields = ['name', 'qty', 'price', 'status', 'note']


class PaymentInline(admin.TabularInline):
    model = models.Payment
    extra = 0
    fields = ['method', 'amount', 'reference', 'created_at']


@admin.register(models.Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ['order_no', 'restaurant', 'type', 'status', 'bill_no', 'total', 'paid', 'created_at']
    list_filter = ['status', 'type', 'restaurant']
    search_fields = ['bill_no', 'customer_name', 'customer_phone']
    inlines = [OrderItemInline, PaymentInline]


for m in (models.DiningTable, models.Category, models.MenuItem, models.Kot, models.Payment, models.GatewayOrder,
          models.Notification, models.InventoryItem, models.StockMove, models.RolePermission):
    admin.site.register(m)

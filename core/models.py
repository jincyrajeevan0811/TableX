"""TableX data model."""
from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.utils import timezone


class Plan(models.Model):
    name = models.CharField(max_length=60)
    code = models.SlugField(max_length=60, unique=True)
    description = models.CharField(max_length=300, blank=True, default='')
    price_monthly = models.FloatField(default=0)
    price_yearly = models.FloatField(default=0)
    max_tables = models.PositiveIntegerField(default=10)
    max_staff = models.PositiveIntegerField(default=5)
    max_menu_items = models.PositiveIntegerField(default=200)
    features = models.JSONField(default=list, blank=True)
    highlight = models.BooleanField(default=False)
    active = models.BooleanField(default=True)
    sort = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['sort', 'id']

    def __str__(self):
        return self.name


class Restaurant(models.Model):
    STATUS = [('active', 'Active'), ('suspended', 'Suspended')]
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=60, unique=True)
    owner_name = models.CharField(max_length=80, blank=True, default='')
    phone = models.CharField(max_length=20, blank=True, default='')
    email = models.CharField(max_length=120, blank=True, default='')
    address = models.CharField(max_length=300, blank=True, default='')
    city = models.CharField(max_length=80, blank=True, default='')
    status = models.CharField(max_length=12, choices=STATUS, default='active')
    plan = models.ForeignKey(Plan, null=True, blank=True, on_delete=models.SET_NULL, related_name='restaurants')
    subscription_ends_at = models.DateTimeField(null=True, blank=True)
    settings = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    def __str__(self):
        return self.name


class UserManager(BaseUserManager):
    use_in_migrations = True

    def create_user(self, phone, password=None, **extra):
        user = self.model(phone=phone, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, phone, password=None, **extra):
        extra.setdefault('role', 'super_admin')
        extra.setdefault('is_staff', True)
        extra.setdefault('is_superuser', True)
        extra.setdefault('name', 'Super Admin')
        return self.create_user(phone, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """Everyone who signs in: the platform Super Admin and every restaurant staff member."""
    ROLES = [('super_admin', 'Super Admin'), ('owner', 'Owner'), ('admin', 'Admin'), ('manager', 'Manager'),
             ('captain', 'Captain (Waiter)'), ('cashier', 'Cashier'), ('kitchen', 'Kitchen'), ('rider', 'Rider'),
             ('store_keeper', 'Store keeper')]
    restaurant = models.ForeignKey(Restaurant, null=True, blank=True, on_delete=models.CASCADE, related_name='users')
    name = models.CharField(max_length=80)
    phone = models.CharField(max_length=20, unique=True)
    email = models.EmailField(max_length=120, unique=True, null=True, blank=True)
    pin_hash = models.CharField(max_length=128, null=True, blank=True)
    role = models.CharField(max_length=20, choices=ROLES)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False, help_text='Can sign in to Django admin.')
    created_at = models.DateTimeField(default=timezone.now)

    objects = UserManager()
    USERNAME_FIELD = 'phone'
    REQUIRED_FIELDS = ['name']

    def __str__(self):
        return f'{self.name} ({self.phone})'


class AuthSession(models.Model):
    """Bearer-token session used by the web app (one device per waiter/cashier login)."""
    token = models.CharField(max_length=64, primary_key=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='auth_sessions')
    device = models.CharField(max_length=200, blank=True, default='')
    revoked = models.CharField(max_length=20, null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()


class Subscription(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='subscriptions')
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name='subscriptions')
    cycle = models.CharField(max_length=10, default='monthly')
    amount = models.FloatField(default=0)
    status = models.CharField(max_length=12, default='pending')
    source = models.CharField(max_length=16, default='razorpay')
    starts_at = models.DateTimeField(null=True, blank=True)
    ends_at = models.DateTimeField(null=True, blank=True)
    razorpay_order_id = models.CharField(max_length=60, null=True, blank=True)
    razorpay_payment_id = models.CharField(max_length=60, null=True, blank=True)
    note = models.CharField(max_length=200, blank=True, default='')
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(default=timezone.now)


class RolePermission(models.Model):
    """Role → permission list. restaurant=None holds the platform-wide defaults set by the Super Admin."""
    restaurant = models.ForeignKey(Restaurant, null=True, blank=True, on_delete=models.CASCADE, related_name='role_permissions')
    role = models.CharField(max_length=20)
    permissions = models.JSONField(default=list)

    class Meta:
        unique_together = [('restaurant', 'role')]


class DiningTable(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='tables')
    name = models.CharField(max_length=30)
    area = models.CharField(max_length=40, default='Main Hall')
    seats = models.PositiveIntegerField(default=4)
    status = models.CharField(max_length=12, default='free')
    lock_user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    lock_at = models.DateTimeField(null=True, blank=True)
    qr_token = models.CharField(max_length=32, unique=True)
    sort = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['area', 'sort', 'id']


class Category(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='categories')
    name = models.CharField(max_length=60)
    sort = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['sort', 'name']
        verbose_name_plural = 'categories'


class MenuItem(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='menu_items')
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL, related_name='items')
    name = models.CharField(max_length=100)
    description = models.CharField(max_length=300, blank=True, default='')
    price = models.FloatField(default=0)
    veg = models.BooleanField(default=True)
    available = models.BooleanField(default=True)
    station = models.CharField(max_length=40, default='Main Kitchen')
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['name']


class Order(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='orders')
    order_no = models.PositiveIntegerField()
    type = models.CharField(max_length=12, default='dine_in')
    source = models.CharField(max_length=8, default='pos')
    table = models.ForeignKey(DiningTable, null=True, blank=True, on_delete=models.SET_NULL, related_name='orders')
    status = models.CharField(max_length=12, default='open')
    customer_name = models.CharField(max_length=80, blank=True, default='')
    customer_phone = models.CharField(max_length=20, blank=True, default='')
    address = models.CharField(max_length=400, blank=True, default='')
    notes = models.CharField(max_length=500, blank=True, default='')
    captain = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    discount_type = models.CharField(max_length=8, default='amount')
    discount_value = models.FloatField(default=0)
    subtotal = models.FloatField(default=0)
    discount = models.FloatField(default=0)
    service_charge = models.FloatField(default=0)
    tax = models.FloatField(default=0)
    delivery_fee = models.FloatField(default=0)
    round_off = models.FloatField(default=0)
    total = models.FloatField(default=0)
    paid = models.FloatField(default=0)
    bill_no = models.CharField(max_length=20, null=True, blank=True)
    billed_at = models.DateTimeField(null=True, blank=True)
    paid_at = models.DateTimeField(null=True, blank=True)
    rider = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    delivery_status = models.CharField(max_length=12, null=True, blank=True)
    delivery_otp = models.CharField(max_length=6, null=True, blank=True)
    cod = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=['restaurant', 'status']), models.Index(fields=['restaurant', 'created_at'])]


class Kot(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='kots')
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='kots')
    kot_no = models.PositiveIntegerField()
    station = models.CharField(max_length=40, default='Main Kitchen')
    status = models.CharField(max_length=12, default='new')
    client_key = models.CharField(max_length=80, null=True, blank=True)
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    ready_at = models.DateTimeField(null=True, blank=True)
    served_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=['restaurant', 'status'])]
        constraints = [models.UniqueConstraint(fields=['restaurant', 'client_key', 'station'], condition=models.Q(client_key__isnull=False), name='uniq_kot_client_key')]


class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='items')
    menu_item_id = models.IntegerField(null=True, blank=True)
    kot = models.ForeignKey(Kot, null=True, blank=True, on_delete=models.SET_NULL, related_name='items')
    name = models.CharField(max_length=100)
    price = models.FloatField()
    qty = models.PositiveIntegerField(default=1)
    veg = models.BooleanField(default=True)
    station = models.CharField(max_length=40, default='Main Kitchen')
    note = models.CharField(max_length=200, blank=True, default='')
    seat = models.CharField(max_length=20, blank=True, default='')
    status = models.CharField(max_length=12, default='new')
    cancel_reason = models.CharField(max_length=200, blank=True, default='')
    added_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(default=timezone.now)


class Payment(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='payments')
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name='payments')
    method = models.CharField(max_length=12)
    amount = models.FloatField()
    reference = models.CharField(max_length=120, blank=True, default='')
    received_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(default=timezone.now)


class GatewayOrder(models.Model):
    """A Razorpay order and what it pays for (a restaurant bill or a subscription)."""
    gateway_order_id = models.CharField(max_length=60, unique=True)
    purpose = models.CharField(max_length=16)
    ref_id = models.IntegerField()
    restaurant = models.ForeignKey(Restaurant, null=True, blank=True, on_delete=models.CASCADE, related_name='+')
    amount = models.FloatField()
    status = models.CharField(max_length=12, default='created')
    payment_id = models.CharField(max_length=60, null=True, blank=True)
    demo = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)


class RiderStatus(models.Model):
    user = models.OneToOneField(User, primary_key=True, on_delete=models.CASCADE, related_name='rider_status')
    online = models.BooleanField(default=False)
    updated_at = models.DateTimeField(default=timezone.now)


class Notification(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='notifications')
    type = models.CharField(max_length=20)
    title = models.CharField(max_length=200)
    body = models.CharField(max_length=500, blank=True, default='')
    table = models.ForeignKey(DiningTable, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    order = models.ForeignKey(Order, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    read = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)


class InventoryItem(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='inventory_items')
    name = models.CharField(max_length=80)
    unit = models.CharField(max_length=12, default='kg')
    qty = models.FloatField(default=0)
    reorder_level = models.FloatField(default=0)
    cost = models.FloatField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['name']


class StockMove(models.Model):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='stock_moves')
    item = models.ForeignKey(InventoryItem, on_delete=models.CASCADE, related_name='moves')
    type = models.CharField(max_length=12)
    qty = models.FloatField()
    cost = models.FloatField(default=0)
    supplier = models.CharField(max_length=80, blank=True, default='')
    note = models.CharField(max_length=200, blank=True, default='')
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    created_at = models.DateTimeField(default=timezone.now)


class Counter(models.Model):
    """Per-restaurant running numbers for orders, KOTs and bills."""
    restaurant_id_ref = models.IntegerField()
    key = models.CharField(max_length=20)
    value = models.PositiveIntegerField(default=0)

    class Meta:
        unique_together = [('restaurant_id_ref', 'key')]

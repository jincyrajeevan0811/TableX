from django.apps import AppConfig
from django.db.models.signals import post_migrate


class CoreConfig(AppConfig):
    name = 'core'
    verbose_name = 'TableX'
    default_auto_field = 'django.db.models.BigAutoField'

    def ready(self):
        from .bootstrap import bootstrap
        post_migrate.connect(bootstrap, sender=self)

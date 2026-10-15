from django.urls import path

from . import views

urlpatterns = [
    path("", views.home, name="home"),
    path("features/", views.features, name="features"),
    path("security/", views.security, name="security"),
    path("security/disclosure/", views.disclosure, name="disclosure"),
    path("zero-trust/", views.zero_trust, name="zero_trust"),
    path("federation/", views.federation, name="federation"),
    path("pricing/", views.pricing, name="pricing"),
    path("docs/", views.docs_index, name="docs"),
    path("docs/<slug:slug>/", views.docs_article, name="doc"),
    path("download/", views.download, name="download"),
    path("status/", views.status, name="status"),
    path("contact/", views.contact, name="contact"),
    path("privacy/", views.privacy, name="privacy"),
    path("terms/", views.terms, name="terms"),
]

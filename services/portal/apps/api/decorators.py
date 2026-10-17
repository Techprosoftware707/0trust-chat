"""``@api_endpoint``: the single entry point of every JSON API view.

    @api_endpoint(methods=["GET", "POST"], feature="crm")
    def contacts(request, actor):
        ...

For each request it, in order:

1. rejects methods the view does not declare (405, with ``Allow``);
2. authenticates the bearer token (``apps.api.auth``; never the session cookie) and
   requires ``read_scopes`` for GET/HEAD and ``write_scopes`` for everything else;
3. applies the per-user read/write rate limits (``apps.core.ratelimit``);
4. with ``workspace=True`` (the default) resolves the ``workspace_id`` URL argument to an
   ``apps.crm.access.Actor`` (404 if the user is not a member: workspace IDs are never
   confirmed to outsiders) and, with ``feature=``, requires that workspace feature;
5. runs the view (writes inside one database transaction) and turns ``ApiError``,
   ``Http404``, ``PermissionDenied`` and validation errors into the one error format.

Views are CSRF-exempt because they only ever accept bearer tokens: a request that carries
the portal session cookie but no token is rejected like any other unauthenticated one.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from functools import wraps

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.http import Http404
from django.views.decorators.csrf import csrf_exempt

from apps.core import ratelimit

from .auth import TokenPolicy, api_policy, authenticate_bearer
from .errors import (
    ApiError,
    Conflict,
    FeatureDisabled,
    MethodNotAllowed,
    NotFound,
    PermissionDeniedError,
    RateLimited,
    ServerError,
    ValidationFailed,
    error_response,
)

log = logging.getLogger("nexus.api")
SAFE_METHODS = frozenset({"GET", "HEAD"})


def _rate_limit(request, user, method: str) -> None:
    kind = "read" if method in SAFE_METHODS else "write"
    limit, window = settings.NEXUS_API_RATE_LIMITS[kind]
    decision = ratelimit.hit(f"api-{kind}:u{user.pk}", limit, window)
    if not decision.allowed:
        raise RateLimited(headers={"Retry-After": str(decision.retry_after)})


def api_endpoint(
    *,
    methods: Iterable[str],
    workspace: bool = True,
    feature: str | None = None,
    read_scopes: Iterable[str] = ("workspace:read",),
    write_scopes: Iterable[str] = ("workspace:write",),
    policy: Callable[[], TokenPolicy] = api_policy,
):
    allowed = frozenset(m.upper() for m in methods)
    if "GET" in allowed:
        allowed = allowed | {"HEAD"}
    read_scopes, write_scopes = tuple(read_scopes), tuple(write_scopes)

    def decorator(view):
        @csrf_exempt
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            try:
                method = request.method.upper()
                if method not in allowed:
                    raise MethodNotAllowed(headers={"Allow": ", ".join(sorted(allowed))})
                ctx = authenticate_bearer(
                    request, policy=policy(), scopes=read_scopes if method in SAFE_METHODS else write_scopes
                )
                request.token_context = ctx
                _rate_limit(request, ctx.user, method)
                if workspace:
                    from apps.crm.access import actor_for

                    actor = actor_for(ctx.user, kwargs.pop("workspace_id"), token=ctx)
                    if feature and not actor.features.get(feature):
                        raise FeatureDisabled(f"“{feature}” is not enabled for this workspace.")
                    subject = actor
                else:
                    subject = ctx
                if method in SAFE_METHODS:
                    return view(request, subject, *args, **kwargs)
                with transaction.atomic():
                    return view(request, subject, *args, **kwargs)
            except ApiError as err:
                return error_response(err, request)
            except Http404:
                return error_response(NotFound(), request)
            except PermissionDenied as exc:
                return error_response(PermissionDeniedError(str(exc) or None), request)
            except DjangoValidationError as exc:
                fields = exc.message_dict if hasattr(exc, "error_dict") else {"non_field_errors": exc.messages}
                return error_response(ValidationFailed(fields=fields), request)
            except IntegrityError:
                return error_response(Conflict("That conflicts with an existing record."), request)
            except Exception:
                # Never echo request data: it may contain record contents.
                log.exception("api view %s failed", getattr(view, "__name__", "?"))
                if settings.DEBUG:
                    raise
                return error_response(ServerError(), request)

        wrapped.api_methods = allowed
        return wrapped

    return decorator


def not_found_view(request, *args, **kwargs):
    """Unknown paths under /api/ answer in the API's error format."""
    return error_response(NotFound("No such API endpoint."), request)

"""The one error format of the JSON API.

Every error response is::

    {"error": {"code": "validation_error", "message": "...", "fields": {"name": ["..."]},
               "request_id": "..."}}

``fields`` is only present for validation errors. Codes are stable identifiers that
clients branch on; messages are for people and may change.
"""

from __future__ import annotations

from django.http import JsonResponse


class ApiError(Exception):
    status = 400
    code = "bad_request"
    message = "The request is not valid."

    def __init__(self, message: str | None = None, *, code: str | None = None, status: int | None = None,
                 fields: dict[str, list[str]] | None = None, headers: dict[str, str] | None = None):
        super().__init__(message or self.message)
        self.message = message or self.message
        self.code = code or self.code
        self.status = status or self.status
        self.fields = fields
        self.headers = headers or {}


class ValidationFailed(ApiError):
    status, code, message = 400, "validation_error", "Some fields are not valid."


class Unauthenticated(ApiError):
    status, code, message = 401, "unauthenticated", "A valid bearer access token is required."


class InsufficientScope(ApiError):
    status, code, message = 403, "insufficient_scope", "The access token does not grant this operation."


class PermissionDeniedError(ApiError):
    status, code, message = 403, "permission_denied", "You are not allowed to do that."


class FeatureDisabled(ApiError):
    status, code, message = 403, "feature_disabled", "This feature is not enabled for the workspace."


class NotFound(ApiError):
    status, code, message = 404, "not_found", "Not found."


class MethodNotAllowed(ApiError):
    status, code, message = 405, "method_not_allowed", "Method not allowed."


class Conflict(ApiError):
    status, code, message = 409, "conflict", "The request conflicts with the current state."


class PayloadTooLarge(ApiError):
    status, code, message = 413, "payload_too_large", "The request body is too large."


class UnsupportedMediaType(ApiError):
    status, code, message = 415, "unsupported_media_type", "Send a JSON body with Content-Type: application/json."


class RateLimited(ApiError):
    status, code, message = 429, "rate_limited", "Too many requests. Try again shortly."


class ServerError(ApiError):
    status, code, message = 500, "server_error", "Something went wrong on our side."


def error_response(err: ApiError, request=None) -> JsonResponse:
    body: dict = {"code": err.code, "message": err.message}
    if err.fields:
        body["fields"] = err.fields
    rid = getattr(request, "request_id", None)
    if rid:
        body["request_id"] = rid
    response = JsonResponse({"error": body}, status=err.status)
    for k, v in err.headers.items():
        response[k] = v
    response["Cache-Control"] = "no-store"
    return response

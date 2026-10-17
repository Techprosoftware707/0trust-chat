"""The Anthropic Messages API provider (``AI_PROVIDER=anthropic``), raw HTTPS via ``requests``.

Configuration (docs/nexus/CONFIG.md):

* ``AI_API_KEY_FILE`` - secret file with the API key (``AI_API_KEY`` only in development);
* ``AI_MODEL`` - REQUIRED, set it to a current Claude model ID; there is no default;
* ``AI_API_BASE_URL`` (default ``https://api.anthropic.com``), ``AI_MAX_TOKENS``,
  ``AI_TIMEOUT_SECONDS``.

What is sent: the system prompt, the conversation text, tool definitions and tool results.
Never credentials, tokens, documents or native chat content (the server cannot read it).
Request and response bodies are never logged; only status codes and the provider's
request id.
"""

from __future__ import annotations

import json
import logging
import time

import requests
from django.conf import settings

from . import Message, ProviderError, ProviderReply, ToolCall, ToolSpec

log = logging.getLogger("nexus.assistant.provider")
API_VERSION = "2023-06-01"
RETRYABLE = {429, 500, 502, 503, 504, 529}


class AnthropicProvider:
    name = "anthropic"
    label = "Claude (Anthropic API)"
    is_model = True

    def __init__(self, session: requests.Session | None = None):
        self.model = (settings.AI_MODEL or "").strip()
        self.session = session or requests.Session()

    def problem(self) -> str:
        if not settings.AI_API_KEY:
            return "The Anthropic API key is not configured (AI_API_KEY_FILE)."
        if not self.model:
            return "No model is configured: set AI_MODEL to a current Claude model ID."
        return ""

    # --- wire format ---------------------------------------------------------------------------

    @staticmethod
    def _messages(messages: list[Message]) -> list[dict]:
        out: list[dict] = []
        for msg in messages:
            if msg.role == "user":
                out.append({"role": "user", "content": msg.text})
            elif msg.role == "assistant" and msg.raw is not None:
                out.append({"role": "assistant", "content": msg.raw})  # replayed unchanged (incl. thinking blocks)
            elif msg.role == "assistant":
                out.append({"role": "assistant", "content": msg.text or "(no answer)"})
            elif msg.role == "tool":
                out.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": r.call_id, "content": r.content, **({"is_error": True} if r.is_error else {})}
                    for r in msg.results
                ]})
        return out

    def _post(self, body: dict) -> dict:
        url = settings.AI_API_BASE_URL.rstrip("/") + "/v1/messages"
        headers = {"x-api-key": settings.AI_API_KEY, "anthropic-version": API_VERSION, "content-type": "application/json"}
        timeout = (5, settings.AI_TIMEOUT_SECONDS)
        for attempt in range(2):
            try:
                resp = self.session.post(url, data=json.dumps(body), headers=headers, timeout=timeout)
            except requests.Timeout:
                raise ProviderError("The AI provider took too long to answer. Try again.", code="provider_timeout", status=504) from None
            except requests.RequestException:
                raise ProviderError("The AI provider couldn't be reached.", code="provider_unreachable", status=502) from None
            rid = resp.headers.get("request-id", "")
            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError:
                    raise ProviderError("The AI provider sent an unreadable answer.", code="provider_error") from None
            log.warning("anthropic API answered HTTP %s (request-id %s)", resp.status_code, rid)
            if resp.status_code in RETRYABLE and attempt == 0:
                try:
                    wait = min(float(resp.headers.get("retry-after", "1")), 5.0)
                except ValueError:
                    wait = 1.0
                time.sleep(max(wait, 0.2))
                continue
            if resp.status_code in (401, 403):
                raise ProviderError("The AI provider rejected this installation's API key. An administrator needs to check AI_API_KEY_FILE.",
                                    code="provider_auth", status=502)
            if resp.status_code == 404:
                raise ProviderError("The configured AI model isn't available. An administrator needs to check AI_MODEL.",
                                    code="provider_model", status=502)
            if resp.status_code == 400:
                raise ProviderError("The AI provider couldn't process this request.", code="provider_bad_request", status=502)
            if resp.status_code in RETRYABLE:
                raise ProviderError("The AI provider is busy right now. Try again in a moment.", code="provider_busy", status=503)
            raise ProviderError("The AI provider returned an error.", code="provider_error", status=502)
        raise ProviderError("The AI provider is busy right now. Try again in a moment.", code="provider_busy", status=503)

    def complete(self, *, system: str, messages: list[Message], tools: list[ToolSpec]) -> ProviderReply:
        problem = self.problem()
        if problem:
            raise ProviderError(problem, code="provider_not_configured", status=503)
        body = {
            "model": self.model,
            "max_tokens": settings.AI_MAX_TOKENS,
            "system": system,
            "messages": self._messages(messages),
        }
        if tools:
            body["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools]
        data = self._post(body)
        content = data.get("content") or []
        stop = data.get("stop_reason") or ""
        text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()
        if stop == "refusal":
            return ProviderReply(text="The AI model declined to answer this request.", stop="refusal", raw=content)
        if stop == "max_tokens":
            # A cut-off turn may hold a truncated tool call: never run it.
            return ProviderReply(text=(text + "\n\n(The answer was cut short.)").strip(), stop="max_tokens", raw=content)
        if stop == "pause_turn":
            return ProviderReply(text=text, stop="pause", raw=content)
        calls = [ToolCall(id=str(b.get("id", "")), name=str(b.get("name", "")), arguments=b.get("input") if isinstance(b.get("input"), dict) else {})
                 for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
        if stop == "tool_use" and calls:
            return ProviderReply(text=text, tool_calls=calls, stop="tool_use", raw=content)
        return ProviderReply(text=text, stop="end", raw=content)

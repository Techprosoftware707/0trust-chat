"""AI providers: one small, provider-independent interface.

    provider = get_provider()                    # from settings.AI_PROVIDER, or None
    reply = provider.complete(system=..., messages=[...], tools=[ToolSpec(...)])
    reply.text, reply.tool_calls, reply.stop     # text and/or tool calls out

``messages`` is a neutral transcript: ``Message(role="user"|"assistant", text=...)`` for
conversation turns, ``Message(role="assistant", tool_calls=[...], raw=...)`` for a model
turn that asked for tools, and ``Message(role="tool", results=[...])`` for the results.
Each provider translates it to its own wire format.

Built in:

* ``dev`` - deterministic, model-free. Recognises the brief's intents, asks for the matching
  tools and answers only from their results. Every answer is labelled "Development mode:
  no AI model connected". It never pretends to be an AI and never invents content.
* ``anthropic`` - the Anthropic Messages API over HTTPS (``AI_PROVIDER=anthropic``). The
  API key comes from the secret file ``AI_API_KEY_FILE`` (plain ``AI_API_KEY`` only in
  development); the model from ``AI_MODEL``, which must be set explicitly to a current
  Claude model ID (there is no built-in default).

Another provider is a class with ``name``, ``label``, ``model``, ``is_model``,
``problem()`` and ``complete()``, registered in ``PROVIDERS``.

The Claude MCP connector does NOT give this app a model: Claude calls the app's tools,
but the in-app assistant needs its own provider credentials and billing. A Claude Pro or
Team login is never used as an API credential.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from django.conf import settings


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass(frozen=True)
class ToolOutput:
    call_id: str
    name: str
    content: str
    is_error: bool = False


@dataclass
class Message:
    role: str  # user | assistant | tool
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    results: list[ToolOutput] = field(default_factory=list)
    raw: Any = None  # provider-specific assistant content to replay unchanged


@dataclass
class ProviderReply:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop: str = "end"  # end | tool_use | max_tokens | refusal | pause
    raw: Any = None


class ProviderError(Exception):
    """The provider could not answer. ``message`` is safe to show; ``code`` is stable."""

    def __init__(self, message: str, *, code: str = "provider_error", status: int = 502):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class AIProvider(Protocol):
    name: str
    label: str
    model: str
    is_model: bool

    def problem(self) -> str: ...

    def complete(self, *, system: str, messages: list[Message], tools: list[ToolSpec]) -> ProviderReply: ...


def _registry() -> dict[str, type]:
    from .anthropic import AnthropicProvider
    from .dev import DevProvider

    return {"dev": DevProvider, "anthropic": AnthropicProvider}


PROVIDERS = _registry


def get_provider() -> AIProvider | None:
    name = (settings.AI_PROVIDER or "none").strip().lower()
    cls = PROVIDERS().get(name)
    return cls() if cls else None


def provider_status() -> dict:
    """What the UI shows about the configured provider (never secrets)."""
    p = get_provider()
    if p is None:
        return {"name": "none", "label": "No AI provider configured", "model": "", "is_model": False, "configured": False,
                "problem": "No AI provider is configured for this installation (AI_PROVIDER)."}
    problem = p.problem()
    return {"name": p.name, "label": p.label, "model": p.model, "is_model": p.is_model, "configured": not problem, "problem": problem}

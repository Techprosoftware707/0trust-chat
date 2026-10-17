"""Provider adapters (one per external service) behind the common ``Adapter`` interface."""

from __future__ import annotations

from ..models import Provider
from .base import AccountInfo, Adapter, OAuthFailed, SyncResult
from .gmail import GmailAdapter
from .gohighlevel import GoHighLevelAdapter
from .slack import SlackAdapter

ADAPTERS: dict[str, Adapter] = {
    Provider.GMAIL: GmailAdapter(),
    Provider.GOHIGHLEVEL: GoHighLevelAdapter(),
    Provider.SLACK: SlackAdapter(),
}


def adapter_for(provider: str) -> Adapter:
    try:
        return ADAPTERS[provider]
    except KeyError:
        raise LookupError(provider) from None


__all__ = ["ADAPTERS", "AccountInfo", "Adapter", "OAuthFailed", "SyncResult", "adapter_for"]

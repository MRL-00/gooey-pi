"""Supabase integration for Prime Agent's Python kernel."""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Supabase", "supabase"]


class Supabase(McpIntegration):
    server = "supabase"
    url = "https://mcp.supabase.com/mcp"


supabase = Supabase()

_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(supabase, name)

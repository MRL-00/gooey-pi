"""Prime Agent bridge to GooeyPi's separately installed Cua Driver."""

from __future__ import annotations

import os
import re
import subprocess
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from rlm import McpIntegration

MIN_CUA_DRIVER_VERSION = "0.19.0"
_VERSION_RE = re.compile(r"\b(?:cua-driver(?:-rs)?\s+)?v?(\d+)\.(\d+)\.(\d+)\b", re.IGNORECASE)
_MIN_VERSION = tuple(int(part) for part in MIN_CUA_DRIVER_VERSION.split("."))
_DEFAULT_COMMAND = "cua-driver.exe" if os.name == "nt" else "cua-driver"
_RESERVED = {"run", "__wrapped__", "__call__"}


def _command() -> str:
    configured = os.environ.get("GOOEYPI_CUA_DRIVER_PATH")
    return configured if configured else _DEFAULT_COMMAND


def _probe_version(command: str) -> tuple[int, int, int] | None:
    try:
        result = subprocess.run(
            [command, "--version"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    match = _VERSION_RE.search(f"{result.stdout}\n{result.stderr}")
    return tuple(int(part) for part in match.groups()) if match else None


def installed_driver_version() -> str | None:
    version = _probe_version(_command())
    return ".".join(str(part) for part in version) if version else None


def _ensure_supported_driver(command: str) -> None:
    version = _probe_version(command)
    if version is None:
        raise RuntimeError(
            f"Cua Driver was not detected at {command!r}. "
            "Enable it from GooeyPi's Plugins page after installing the driver."
        )
    if version < _MIN_VERSION:
        found = ".".join(str(part) for part in version)
        raise RuntimeError(
            f"Cua Driver {MIN_CUA_DRIVER_VERSION}+ is required; found {found}. "
            "Update the driver and start a new Prime session."
        )


class GooeyPiCuaDriver(McpIntegration):
    """Expose every tool advertised by the installed Cua Driver MCP server."""

    server = "gooeypi-cua-driver"

    async def _open_session(self, stack: AsyncExitStack):
        command = _command()
        _ensure_supported_driver(command)
        params = StdioServerParameters(command=command, args=["mcp"], env=None)
        read, write, *_ = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session

    async def invoke(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        await self._ensure_tools()
        if self._tools is not None and name not in self._tools:
            available = ", ".join(sorted(self._tools)) or "(none)"
            raise AttributeError(f"Cua Driver has no tool {name!r}. Available: {available}")
        return await self.call_tool(name, arguments or {})


gooeypi_cua_driver = GooeyPiCuaDriver()


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(gooeypi_cua_driver, name)

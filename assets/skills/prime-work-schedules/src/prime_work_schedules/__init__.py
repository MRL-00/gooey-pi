"""Prime Work's capability-scoped scheduling client."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _request(method: str, params: dict[str, Any] | None = None) -> Any:
    url = os.environ.get("PRIME_WORK_SCHEDULE_URL")
    token = os.environ.get("PRIME_WORK_SCHEDULE_TOKEN")
    if not url or not token:
        raise RuntimeError("Prime Work scheduling is unavailable. Open this session in Prime Work and keep its broker running.")
    payload = json.dumps({"method": method, "params": params or {}}, separators=(",", ":")).encode()
    request = Request(url, data=payload, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode())
    except HTTPError as error:
        try:
            detail = json.loads(error.read().decode()).get("error")
        except Exception:
            detail = None
        raise RuntimeError(detail or f"Prime Work scheduling failed ({error.code})") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("Prime Work's scheduling broker is not reachable") from error
    if not body.get("ok"):
        raise RuntimeError(body.get("error") or "Prime Work scheduling failed")
    return body.get("result")


async def _call(method: str, params: dict[str, Any] | None = None) -> Any:
    return await asyncio.to_thread(_request, method, params)


async def list() -> list[dict[str, Any]]:
    """List durable tasks in this agent's current project/thread scope."""
    return await _call("list")


def _execution(model: str, thinking: str, fast: bool) -> dict[str, str]:
    return {"model": model, "thinking": thinking, "speed": "fast" if fast else "normal"}


async def create_once(
    prompt: str,
    at: str,
    target: str = "current_project",
    title: str | None = None,
    model: str = "auto",
    thinking: str = "auto",
    fast: bool = False,
) -> dict[str, Any]:
    """Create a one-time task at an explicit ISO timestamp."""
    return await _call("create", {"target": target, "input": {
        "title": title, "prompt": prompt, "timing": {"kind": "once", "at": at},
        "execution": _execution(model, thinking, fast),
    }})


async def create_recurring(
    prompt: str,
    rrule: str,
    dtstart_local: str,
    time_zone: str,
    target: str = "current_project",
    title: str | None = None,
    model: str = "auto",
    thinking: str = "auto",
    fast: bool = False,
) -> dict[str, Any]:
    """Create an RFC 5545 recurring task in an IANA timezone."""
    return await _call("create", {"target": target, "input": {
        "title": title, "prompt": prompt,
        "timing": {"kind": "rrule", "rrule": rrule, "dtstartLocal": dtstart_local, "timeZone": time_zone},
        "execution": _execution(model, thinking, fast),
    }})


async def update(task_id: str, **changes: Any) -> dict[str, Any]:
    """Update title, prompt, timing, or execution fields on a task in scope."""
    return await _call("update", {"id": task_id, "patch": changes})


async def pause(task_id: str) -> dict[str, Any]:
    return await _call("pause", {"id": task_id})


async def resume(task_id: str) -> dict[str, Any]:
    return await _call("resume", {"id": task_id})


async def run_now(task_id: str) -> dict[str, Any]:
    return await _call("run_now", {"id": task_id})


async def delete(task_id: str) -> bool:
    return bool(await _call("delete", {"id": task_id}))

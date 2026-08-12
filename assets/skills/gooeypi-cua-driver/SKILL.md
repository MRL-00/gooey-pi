---
name: gooeypi-cua-driver
description: Drive native applications through the user's separately installed Cua Driver on macOS, Windows, or Linux. Use for native desktop automation and exact Chromium or Electron window control.
license: MIT
---

# CUA Driver

This GooeyPi adapter connects to an existing [Cua Driver](https://cua.ai/driver) installation. GooeyPi does not bundle the driver runtime.

Import `gooeypi_cua_driver` and discover the live MCP tool surface before calling it:

```python
tools = await gooeypi_cua_driver.list_tools()
result = await gooeypi_cua_driver.call_tool("list_apps", {})
```

Use the server-defined schemas from `list_tools()`; do not assume a stale argument shape. For UI actions, always:

1. Start one declared session with the narrowest appropriate capture scope.
2. Select the exact process and window.
3. Snapshot immediately before an action.
4. Prefer a snapshot-bound accessibility target before pixel coordinates.
5. Verify the postcondition from fresh state after every action.
6. End the session when the run finishes.

Treat action delivery as distinct from task success. Never reuse element tokens or browser refs after a newer snapshot, navigation, reconnect, or browser lifecycle change. Escalate from background accessibility to pixels, foreground delivery, or desktop scope only when fresh evidence requires it.

If the bridge reports that Cua Driver is unavailable, ask the user to install or update it in GooeyPi's Plugins page and start a new session.

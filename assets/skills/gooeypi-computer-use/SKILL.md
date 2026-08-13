---
name: gooeypi-computer-use
description: Drive native applications on macOS, Windows, or Linux through the separately installed TryCUA driver CLI.
license: MIT
---

# Computer Use | TryCUA

Use the executable in `GOOEYPI_CUA_DRIVER_PATH` for native GUI work. GooeyPi does not bundle TryCUA and this capability does not require an MCP server.

Invoke tools with an argv-safe shell call shaped as:

```text
"$GOOEYPI_CUA_DRIVER_PATH" <snake_case_tool> '<JSON object>'
```

Start with `doctor`, `list-tools`, or `describe <tool>` when the live surface is unclear. Prefer a non-GUI API, CLI, or filesystem operation when the requested result does not actually live in an application's UI.

For GUI actions:

1. Declare the narrowest session scope and exact desired postcondition.
2. Select the exact process and window.
3. Take a fresh state snapshot immediately before every action.
4. Prefer a snapshot-bound accessibility target, then pixels, foreground delivery, and desktop scope only as evidence requires.
5. Verify the postcondition from fresh state after every action. Successful delivery alone is not task success.
6. Never reuse element tokens or browser references after a newer snapshot, navigation, reconnect, or browser lifecycle change.
7. End the session when the task finishes.

On Prime Agent, the same CLI may be invoked with Python `subprocess.run([...], shell=False)` when a shell tool is unavailable. Never interpolate untrusted text into a shell command.

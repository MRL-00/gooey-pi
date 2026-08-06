# MCP settings conflict remediation

This change addresses `CFR-04` and the remaining non-cooperating settings-writer race.

- MCP mutation captures a SHA-256 fingerprint of the exact settings bytes read.
- The fully serialized replacement is written to a private temporary file first, then the live file is fingerprinted immediately before rename.
- A mismatch discards the temporary file, rereads the latest complete document, revalidates duplicate names, merges the MCP server again, and retries up to four times. Repeated churn fails explicitly rather than overwriting another writer.
- Package installation and MCP connection now share `PluginService`'s mutation queue, preventing Prime Work's own package subprocess from racing its MCP writer.
- Package process timeout/output overflow no longer reports installation success.

Tests inject a non-cooperating write precisely at the pre-rename comparison and prove its unrelated key survives, and run package installation concurrently with MCP connection to prove both updates remain in the final settings document.

A same-user process can still write in the final instructions between comparison and POSIX rename because it does not honor Prime Work's lock; eliminating that last filesystem-level instant would require a transaction primitive shared by Prime Agent. The admitted race window is now minimized to one compare/rename boundary, conflicts before it are retried, and no broad stale read/modify/write window remains.

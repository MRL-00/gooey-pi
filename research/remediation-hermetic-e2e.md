# Hermetic Electron E2E remediation

This change addresses testing finding `TST-01` and the order/suppression portion of `TST-02`.

Each of the nine Electron tests now launches an independent application process with:

- a fresh temporary `HOME`, Electron user-data directory, project, and Prime session catalog;
- a deterministic executable fake Prime Agent implementing version, schedule, and strict-LF RPC responses;
- an allowlisted environment that does not inherit provider tokens, proxy credentials, Git injection variables, or the developer's Prime session path;
- an `about:blank` browser home, so the browser guest test does not depend on the network;
- teardown of the app and complete fixture root after every test.

The suite no longer uses a serial describe block, cannot skip its PTY test based on the developer's real projects, and does not read or capture real Prime transcripts in Playwright failure traces. A failing test no longer suppresses the remaining tests, and state mutations from navigation/settings/pane tests cannot leak across cases.

Final verification: all 9 independent Electron tests passed in 27 seconds after a clean production build.

# Terminal shutdown remediation

This change addresses process-safety finding `PS-02` and the terminal cleanup performance finding.

- PTY shutdown now sends HUP, then TERM, then KILL to the captured descendant set, the PTY process group, and the PTY leader. A shell that traps HUP/TERM can no longer survive terminal closure.
- Process-tree enumeration uses asynchronous `execFile` rather than blocking Electron's main thread with `execFileSync` for up to two seconds per terminal.
- Existing detached-background-child coverage still passes.
- A new hostile PTY test installs HUP/TERM traps in the leader, enters a long-running loop, closes the terminal, and proves escalation removes the leader.

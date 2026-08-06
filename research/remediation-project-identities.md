# Project grant identity remediation

## Finding addressed

This change closes `ESB-01`: an approved project path could previously be renamed and replaced by a symlink or a different directory, after which Prime Work would re-resolve the pathname and authorize the replacement target.

## Implementation

- New grants persist the canonical directory path and POSIX filesystem identity (`dev` and `ino`) for every approved folder.
- Every privileged authorization rechecks that the final path component is a real directory and that its current identity matches the approved identity.
- Stale, missing, symlink-replaced, and delete/recreated roots remain visible but are not executable. They must be explicitly added again.
- Authorization rebuilding after listing or removal uses the persisted identity and preserves the existing revision guard, so stale asynchronous lists cannot restore a revoked grant.
- Project removal records both lexical and current canonical forms for dismissal without granting either one.
- Legacy persisted projects without an identity are fail-closed until explicitly re-added.

## Verification

Focused tests cover normal file listing/removal, in-process rename plus symlink replacement, the same substitution across a service/store restart, directory deletion and recreation with a different inode, inferred-project trust, and authorization-revision races.

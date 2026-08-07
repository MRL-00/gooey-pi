# Handoff: installable Codex-native compaction for Prime Agent

## Outcome

Ship **Codex-native remote compaction** as an optional, separately installable Prime Agent capability package. A user should update to a compatible Prime Agent release and then run:

```bash
prime-agent package install npm:@am-will/prime-agent-codex-compaction
```

The package must activate only when the active model is Prime Agent's Codex Responses model:

- `provider === 'openai-codex'`
- the Codex Responses API variant (`openai-codex-responses`)

It must be a strict no-op for generic OpenAI API-key models, OpenAI-compatible endpoints, and every non-OpenAI provider. This is an optional package, not a Prime Agent fork. Anyone using a compatible official Prime Agent release should be able to install it.

The feature is based on the MIT-licensed `@ogulcancelik/pi-codex-compaction` 0.1.3 package. Its intended behavior is to ask the Codex Responses endpoint for an opaque remote compaction item, persist that item in the real session compaction entry, and reuse it only with the compatible Codex model. Do not silently replace this with text summarization.

## Why a package alone cannot work on current Prime Agent 0.7.0

Prime Agent already supports package manifests, `before_provider_request`, `session_before_compact`, and compaction `details`. That is enough for most of the port.

The upstream Pi package also depends on two extension hooks that Prime Agent 0.7.0 does not expose:

1. `before_provider_headers`, which adds the Codex `remote_compaction_v2` feature header to regular Codex requests after native compaction.
2. `agent_settled`, which runs after the tool/agent loop has become idle. The package uses it to safely start a forced compaction after reaching its turn-boundary context threshold.

Without those hooks, an extension-only install can appear to load but cannot safely guarantee automatic compaction or continued use of the opaque remote checkpoint. Do not ship a workaround based on timers, private fields, monkey-patching, or reimplementing Prime Agent's request loop.

## Architecture and ownership

### 1. Small upstream Prime Agent release

Make a narrow, generic extension-API enhancement in the Prime Agent source repository and release it normally. This is an upstream product change, not a divergent fork.

Required additions:

- Export and document a mutable `before_provider_headers` event. Emit it after Prime Agent has constructed provider/auth headers but immediately before the provider request is sent. Run handlers in extension order, preserve the final header map, and do not log credential-bearing headers.
- Export and document an `agent_settled` event. Emit it only after the current agent loop has finished and the runtime is safe for `ctx.compact()`. Its ordering must allow a `turn_end` handler to call `ctx.abort()` and then have an `agent_settled` handler perform compaction without racing another provider request.
- Add focused tests for both events and their ordering. Existing `before_provider_request`, `session_before_compact`, `session_compact`, `CompactionEntry.details`, and `ctx.compact()` behavior should remain unchanged.

Keep these hooks provider-agnostic. They are general extension primitives, not Codex-specific behavior in Prime Agent core.

### 2. Standalone package: `@am-will/prime-agent-codex-compaction`

Create a separate public package/repository, with a Pi-compatible package manifest:

```json
{
  "name": "@am-will/prime-agent-codex-compaction",
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Prime Agent's normal package loader should discover this manifest. Publish the package independently from Prime Agent so users can update or remove it with `prime-agent package update` / `prime-agent package remove`.

Port the relevant behavior from the reference package, adapting only to the official Prime Agent extension APIs:

- Check the Codex model guard at **every** request, compaction, continuation, and status path.
- On `before_provider_headers`, add/merge the `remote_compaction_v2` feature header only for Codex.
- On `before_provider_request`, retain the request shape for the current Codex model and, after a native checkpoint exists, replace normal history with the valid opaque checkpoint history.
- On `session_before_compact`, submit the finalized Codex Responses history plus a `compaction_trigger`, then return a real Prime Agent compaction entry containing the opaque checkpoint in `details`.
- Add the native checkpoint only to `CompactionEntry.details`; use a local marker solely because Prime Agent requires a string `summary`. Filter that marker from model context so it is never sent to a provider.
- Support manual, threshold, and overflow compaction. Default automatic turn-boundary compaction to 90% context usage, but make it configurable.
- Fail closed: if native compaction fails, cancel compaction and preserve the original history. Never fall back to model-generated textual compaction.
- Make checkpoints model-specific. If a user switches models/providers, do not send an opaque Codex checkpoint to the new model. Block unsafe continuation rather than leaking a local marker or attempting portability.
- Reuse Prime Agent's existing model registry/auth headers and model base URL. Do not introduce a separate API key store or expose credentials to the renderer.

Use Prime-specific configuration paths, not Pi paths:

- global: `~/.prime/agent/prime-agent-codex-compaction.json`
- project: `.prime/prime-agent-codex-compaction.json`

Suggested initial configuration:

```json
{
  "autoCompact": true,
  "thresholdRatio": 0.9
}
```

Validate `thresholdRatio` as greater than `0` and less than `1`; project configuration overrides global configuration.

## Security and data boundary

- This is third-party-style extension code running with the user's OS permissions; document that clearly in the package README.
- Only the active Codex conversation, its enabled tools, system instructions, and related Responses request payload may be sent to the authenticated Codex endpoint.
- The returned encrypted/opaque compaction item is sensitive session material. Persist it only in the existing local session JSONL `CompactionEntry.details` flow and replay it only to compatible Codex requests.
- Do not add IPC, renderer-visible secrets, dynamic process execution, or filesystem write access beyond the explicit package configuration and normal Prime session persistence.

## Required verification

### Prime Agent core

- Unit-test `before_provider_headers`: extensions can mutate headers; header order is deterministic; nonparticipating requests are unchanged.
- Unit-test `agent_settled` ordering: a `turn_end` handler can abort, then an `agent_settled` handler can invoke compaction before another provider request begins.
- Run the normal typecheck and full Vitest suite for the Prime Agent source repository.

### Package

- Package manifest is discovered by a fresh Prime Agent install and `prime-agent package list` reports it.
- Codex manual compaction sends the feature header and receives a fake/native compaction response; the session has a real compaction entry with opaque `details`.
- The next Codex request uses the compatible checkpoint and includes the feature header.
- At 90% context after a tool-driven turn, automatic compaction runs once, resumes with the visible continuation, and does not double-compact if Prime Agent's own threshold/overflow compaction already ran.
- A generic `openai` model, an OpenAI-compatible provider, and a non-OpenAI provider produce no header changes, no compaction calls, and no session markers.
- Switching away from Codex after compaction does not replay the opaque checkpoint. Switching back to the exact compatible Codex model resumes safely.
- A rejected network/auth/malformed-checkpoint case preserves original history and emits a clear error; it does not fall back to text summarization.
- Run an end-to-end CLI/daemon or Prime Work test with real ChatGPT/Codex authentication only after mock coverage passes. Verify the persisted session JSONL and the follow-up request path, not just a UI status message.

## Deliverables

1. A released Prime Agent version that includes the two generic extension hooks and changelog entries.
2. Public `@am-will/prime-agent-codex-compaction` source and npm package, with MIT-compatible attribution/license handling for the reference implementation.
3. README with prerequisites, global and `--local` installation commands, config examples, provider scope, data handling, and uninstall instructions.
4. Automated tests covering the provider guard, remote compaction/replay, failure behavior, provider switching, and automatic threshold behavior.
5. A short release note: **installable optional package; activates only for `openai-codex` Codex Responses; no behavior change for other providers.**

## Acceptance statement

After updating Prime Agent, any user can install one optional package. It performs native remote compaction only for their authenticated Codex Responses sessions, persists and reuses opaque checkpoints safely, and leaves every other provider and endpoint unchanged. No user needs a custom Prime Agent fork.


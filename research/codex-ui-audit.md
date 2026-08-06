# Codex / ChatGPT Work macOS UI audit

**Audit date:** 5 August 2026  
**Scope:** Current public OpenAI documentation and official product screenshots; visual measurements below are approximate, not extracted product CSS.

## Current product reality

The standalone Codex macOS app launched in February 2026, but on **9 July 2026 it merged into the ChatGPT desktop app**. The current reference is therefore one macOS app with a product selector:

- **ChatGPT → Chat / Work:** general conversation versus outcome-oriented research, analysis, browsing, and file creation.
- **Codex:** the developer presentation of the same agent workspace—Codex-only chat history, local folders, shell/tool detail, diffs, pull requests, and Git controls.
- The legacy `codex://` deep-link scheme remains supported. Availability varies by plan, region, rollout, and admin policy.

An original implementation should reproduce the **workspace model and interaction contract**, not the OpenAI brand treatment.

## Information architecture and layout

### 1. Native desktop shell

The documented UI is a calm macOS split workspace, not an IDE clone:

1. **Native title/toolbar row:** traffic lights, back/forward, sidebar toggle, current chat title and overflow menu; contextual actions on the right (Run/action menu, Open in editor, terminal, browser, review/panel controls).
2. **Collapsible left sidebar (~240–280 pt):** product switcher; New chat; primary destinations such as Projects, Plugins/Skills, Scheduled, and the new Activity view; recent/pinned chats and projects below.
3. **Main transcript (~500–720 pt preferred):** chat header, a vertically scrolling stream of messages and agent activity, and a bottom-anchored composer.
4. **Optional right detail pane (roughly 45–65% of remaining width):** interchangeable Review, Browser, file/artifact preview, pull-request, or plugin UI. It has its own tab strip/toolbar and may be hidden.
5. **Optional bottom drawer:** an integrated terminal scoped to the selected chat/project/worktree.

At narrower widths, collapse the sidebar first, then replace the side-by-side detail pane with a single selected surface. Preserve selection and scroll position when panels reopen.

### 2. Sidebar and navigation behavior

- **Product selection changes both tools and history.** ChatGPT shows Chat and Work chats; Codex focuses on development projects and Codex chats.
- In Codex, hovering **New chat** reveals **Quick chat**, which opens an ordinary ChatGPT chat; Quick chats do not become Codex sidebar items.
- Project/chat rows support pin, rename, archive, overflow actions, timestamps, unread/attention state, and live statuses (queued, running, waiting for approval, complete, failed). Current releases also surface side chats and subagent status.
- **Activity** (bell) is an attention queue for recently engaged or unread chats. **Scheduled** is an inbox for recurring-run findings, with unread markers and All/Active/Paused filters.
- Search is global across saved chat titles/content and can match Git branch names; in-chat find is separate.
- Essential shortcuts: `Cmd+K` / `Cmd+Shift+P` command menu, `Cmd+N` new chat, `Cmd+Option+N` Quick chat, `Cmd+G` search chats, `Cmd+B` sidebar, `Ctrl+Shift+G` review, **Ctrl + backtick** terminal, `Cmd+Shift+B` browser, `Cmd+,` settings.

## Project, chat, and session model

Use this hierarchy rather than one flat chat list:

- **Product mode** → ChatGPT (Chat/Work) or Codex.
- **Project** → either a ChatGPT project with shared files/instructions/sources, or a local project attached to one or more folders.
- **Chat** → one distinct outcome with its own transcript, run state, goal, environment, tool sessions, artifacts, and child-agent tree.
- **Turn/activity item** → user message, assistant prose, plan/goal progress, command, file edit, tool call, approval, finding, artifact, or error.

For local projects, multiple related folders are supported. One is **primary**: it is the default working directory and target for Git plus automatic discovery of `AGENTS.md`, skills, and `config.toml`; secondary folders remain searchable/readable/editable. A project menu provides Edit project, Make primary, pin/archive, and permanent-worktree actions.

New Codex chats choose an execution environment before first send:

- **Local:** work in the primary checkout.
- **Worktree:** create an isolated Git worktree from a selected branch (including an option to seed uncommitted changes). Each chat retains its associated worktree.
- **Cloud:** run in a configured hosted environment.

A worktree chat exposes branch state and **Create branch here**. **Hand off** moves the chat and code between Worktree and Local with a confirmation dialog. Parallel chats must remain independent; recommend worktrees whenever two coding chats could edit the same repo. Archived/deleted managed worktrees need snapshot/restore behavior.

Long-running work uses a goal/progress row above the composer with pause, resume, edit, and clear. Side chat provides an ephemeral status/explanation path without disturbing the main transcript. Subagents appear as inspectable child threads; the main chat receives their summaries rather than all raw output.

## Core chat interactions

### Composer

The composer is a large, softly rounded card anchored to the bottom. It should contain:

- Multiline prompt with hints for `@` files/plugins and `/` commands.
- Add/attachment button; file/image chips.
- Model and reasoning/“intelligence” selectors.
- Codex environment selector (`Local / Worktree / Cloud`), branch/working-directory indicator, and permission/sandbox control.
- Microphone/voice control and a circular send button that becomes Stop while running.
- Slash-command palette with filtering; allow prompts to be queued while a turn is active.

### Transcript

Keep agent work readable rather than showing a raw log:

- User prompts in light rounded bubbles; assistant narrative mostly unboxed.
- “Worked for …”/running state, compact progress summaries, citations/file links, and expandable command/tool cards.
- File-change summary cards with added/deleted counts and Undo where safe.
- Persistent visible states for queued, streaming, waiting, stopped, complete, and error.
- Inline approvals that name the tool/app/site and consequence, with Cancel/Allow and carefully scoped “Always allow.” Approvals should pause only the affected task, not navigation elsewhere.
- Contextual actions on completed messages (copy, retry/fork, feedback, overflow).

## Developer and work surfaces

### Git review

This is the most important Codex-specific right pane. Cover:

- Scopes: **Unstaged, Staged, Commit, Branch, Last turn**.
- Repository selector, including **All repos** for last-turn/multi-folder review.
- Collapsible file diffs with line numbers and added/removed styling.
- Hover `+` for line-specific comments; comments become guidance when the user sends the next message.
- Stage/unstage/revert at all, file, and hunk level; commit, push, branch, and create/open PR.
- PR context and reviewer feedback in the sidebar/pane. Clicking file names opens the configured editor; modifier-click opens a specific line.

### Integrated terminal and actions

- A real PTY drawer scoped to the current checkout, opened from the toolbar or **Ctrl + backtick**.
- Interactive input, ANSI color, long-running processes, clear/close, and preserved output per chat.
- Agent-readable terminal output so a failed build or running server can be referenced in the chat.
- Project **Actions** (Run, Build, Test, etc.) in the top bar; configurable actions execute inside this terminal.

### Built-in browser

- Right-pane tab with back/forward/reload, address/search bar, tabs, and separate browser profile/history/download settings.
- Open URLs and localhost previews beside the transcript/diff.
- Annotation mode: click an element or drag an area, attach a numbered comment, and optionally adjust text/font/spacing/color in a structured inspector.
- Agent browser control via explicit plugin mention, site permission prompts, and separate confirmations for sensitive actions.
- Optional Developer mode for CDP inspection (DOM, console, network, performance), marked elevated risk and requiring explicit approval.
- Do not imply browser isolation if it is not real; authentication, cookies, downloads, and permission boundaries must match actual behavior.

### Files and finished work (Work-like behavior)

- Generated file cards in the transcript; selecting one opens a right-side preview.
- Viewer-specific controls: document pages, slide thumbnails, spreadsheet tabs/cells, PDF/image zoom, file metadata, download, and **Open in…** external app.
- Inline annotation/comment workflow that returns focused revision requests to the same chat.
- ChatGPT Work should suppress most raw shell/Git detail and foreground plans, sources, and finished outputs; Codex should expose technical detail and the review pane.

### Plugins, skills, and scheduled tasks

- Plugin directory as a first-class destination: OpenAI/workspace/personal/installed groupings, category tabs, search, two-column rows/cards, detail sheet, install check/plus state, authentication/connection, enable/disable, and uninstall.
- Plugins may bundle skills, connectors, MCP tools, browser extensions, hooks, and scheduled-task templates. Installed capabilities become available to **new** chats; invoke explicitly with `@Plugin`/`@Skill` or let the agent select them.
- Scheduled-task editor needs prompt, cadence/custom RRULE, project(s), Local vs dedicated Worktree, model/reasoning, permission policy, active/paused state, test run, and run history/findings. A scheduled task may be standalone (new chat per run) or attached to an existing chat (reuse context).
- Computer Use/appshots/voice are extensions of the same model: show the active capability, visible progress, app/site scope, and confirmations; never make silent clicks or conceal consequential actions.

## Visual system to emulate functionally, not literally

Official screenshots use an understated neutral system. Approximate observed values:

- **Color:** white/near-white canvas; `#F5F5F5–#FAFAFA` secondary surfaces; `#E5E5E5–#EBEBEB` hairlines; `#171717–#2D2D2D` primary text; `#737373–#8A8A8F` secondary text. Selection/unread uses a very pale cool blue/lilac surface with a medium blue dot. Dark mode uses deep navy-charcoal surfaces rather than pure black.
- **Type:** system-like grotesk, 13–14 pt controls, 15–16 pt transcript, 20–28 pt page headings; 12–14 pt monospace for terminal/diff. Medium weight for labels; bold used sparingly.
- **Geometry:** 1 px hairlines, 8–10 px controls, 12–16 px cards/dialogs, ~20–24 px composer radius; 16–18 px thin outline icons; compact 36–44 px sidebar rows.
- **Spacing:** 4/8/12/16/24 pt rhythm, generous blank space, low-elevation shadows, almost no decorative gradients inside work surfaces.
- **Motion:** short fades/slides for panels, spinner/progress for active work, gentle selection transitions; no gratuitous animation. Respect Reduce Motion.

For an original product, choose a clearly different accent family, typeface, icon family, radii, sidebar treatment, and wallpaper/empty states while retaining the hierarchy and density.

## Recommended parity order and acceptance checks

**P0 — credible shell:** native toolbar, product/mode selector, projects + chat hierarchy, durable per-chat state, composer, streaming/tool/approval states, command palette, keyboard navigation, light/dark mode.

**P1 — developer loop:** local/worktree/cloud choice, branch/handoff, scoped PTY, actions, Git diff/review/comment/stage/revert, editor handoff, multi-repo support.

**P2 — agent workspace:** browser preview + annotations, file viewers, plugins/skills, schedules/activity inbox, goals, subagent threads, voice/Computer Use.

Minimum behavioral acceptance:

1. Three chats can run concurrently; switching chats never loses streaming state, terminal output, approvals, or panel selection.
2. Local and Worktree chats demonstrably operate in different directories; Handoff preserves chat and Git state.
3. Review scopes reflect repository truth, not just agent edits, and hunk actions are reversible where promised.
4. Browser, terminal, plugins, and Computer Use expose truthful permissions and consequential confirmations.
5. Projects, pins, unread states, archived chats, schedules, and panel state restore after relaunch.
6. The app remains fully usable by keyboard, with focus, contrast, screen-reader labels, and reduced-motion support.

## Legally safer originality boundary

Functional workflows, common desktop patterns, and compatibility behavior can be studied; **do not ship a pixel-identical or source-derived clone**.

- Use an original product name, logo, app icon, copy, illustrations, wallpaper, sounds, empty states, onboarding, and plugin artwork. Do not reuse OpenAI/Codex/ChatGPT marks, OpenAI Sans, official screenshots, or bundled assets.
- Redesign the palette, iconography, spacing signature, corner radii, and motion while preserving usability and platform conventions. Native macOS controls and generic split-view patterns are safer than tracing screenshot pixels.
- Do not imply affiliation. If using OpenAI APIs, describe it factually (for example, “supports OpenAI models”) and follow current trademark/API terms.
- Implement real sandboxing, consent, credential storage, browser isolation, deletion, and undo semantics before using matching security language.
- Keep a clean-room record: public sources consulted, independently authored component specs/assets, and no extraction of proprietary app code/resources. Obtain counsel for trademark, trade-dress, patent, or distribution questions; this audit is not legal advice.

## Primary official sources

- [Desktop app overview](https://learn.chatgpt.com/docs/app)
- [July 2026 merge and current Codex desktop changes](https://learn.chatgpt.com/docs/whats-new#use-codex-in-the-chatgpt-desktop-app)
- [ChatGPT Work vs Codex](https://learn.chatgpt.com/docs/use-chatgpt#compare-chatgpt-work-and-codex-on-desktop)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Worktrees and Handoff](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal)
- [Browser and annotations](https://learn.chatgpt.com/docs/browser)
- [Code review](https://learn.chatgpt.com/docs/code-review)
- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations)
- [Commands and keyboard shortcuts](https://learn.chatgpt.com/docs/reference/commands)

# Visual QA history

The final toolbar treatment was refined in Codex session `019fd4de-e0f8-7f92-8243-992e27ebad64` using rendered Electron screenshots rather than source inspection alone.

## Iteration 1: replace ambiguous controls

- Replaced the dense boxed-terminal glyph with a conventional terminal prompt.
- Replaced the first browser glyph with an app-window treatment.
- Removed the title-bar Prime mark to diagnose its collision with the macOS traffic-light area.
- Built the renderer and captured `research/icon-visual-qa.png` at 1440 by 920.

The screenshot showed that the controls had consistent visual weight, but user review correctly identified that the missing Prime mark weakened the title bar and the browser glyph still read like a terminal window.

## Iteration 2: restore identity and reserve native chrome

- Restored the Prime mark.
- Increased the left title-bar reserve from 70px to 94px to clear all three macOS window controls.
- Replaced the browser app-window glyph with an 18px globe.
- Rebuilt before recapturing after discovering that the isolated QA runner was loading stale compiled CSS.

This fixed the collision but compressed the wordmark and title actions too aggressively.

## Iteration 3: balance spacing and make Browser unmistakable

- Reduced the protected title-bar area from 94px to 84px.
- Replaced the library globe with a purpose-built lined-globe SVG: outer circle, vertical meridian, and horizontal latitude.
- Applied the same icon treatment across the toolbar, Settings, and command palette.
- Verified the final layout in dark mode and reran build and tests.

The resulting treatment is the one in the current source. It preserves a clear gap after the green window control, keeps the Prime identity visible, avoids crowding the title actions, and makes Browser distinct from Terminal at toolbar scale.

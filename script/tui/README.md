# HoldThis release cockpit

A native terminal interface written in JavaScript for Bun 1.3+. No framework, install step, network request, or npm dependency is needed to open it. Start with `bun run tui:demo` to try all interactions using simulated output.

## Design

The bucket-shaped mark anchors a restrained terminal palette. Amber (`#f5bd72`) marks selection and actions, ice (`#83cbd8`) marks activity, mint (`#99d5ad`) marks completed work, and rose (`#f08d96`) marks failures. Text (`#e7e9ed`) and muted slate (`#929cad`) inherit the terminal background. Symbols and labels accompany colors. The terminal's own monospace font controls typography. Selected rows use a slate highlight, while readiness counts, prerequisites, and the current task explain what can happen next.

```text
 ▗▖ ▗▖  HoldThis / release cockpit
 ▐▙▄▟▌  Apple Silicon • notarize & staple

 ● Workspace   · Artifacts   · Logs       / commands  ? help
 ╭ Release pipeline ─────╮  ╭ Live output ─────────────────────╮
 │ ✓ Build app      12s  │  │ $ ./script/release.sh notarize-app│
 │ ✓ Sign app        3s  │  │ Apple submission: …              │
 │ ⠹ Notarize app   28s  │  │ Waiting for Apple…                │
 │ ○ Updater archive    │  │                                  │
 │ ○ Installer image    │  │                                  │
 │ ○ Verify checksums   │  │                                  │
 ╰──────────────────────╯  ╰──────────────────────────────────╯
 ━━━━━━━━━━━───────────────────────  2/6 stages   43s
 ⠹ Notarize app
 Enter select   Tab views   / commands   ? help   Q quit
```

At 100 columns the pipeline becomes a persistent sidebar. Narrow terminals use one panel, with a dedicated six-step selection screen. The minimum size is 58×20; smaller windows show a resize hint. Rendering reserves the last column to prevent terminal autowrap. Rows are updated only when their contents change. Idle screens have no animation; active tasks use a 90 ms spinner, stage timers, and a completed-stage progress bar. `--no-motion`, `HOLDTHIS_REDUCED_MOTION=1`, and the M key disable animation. `NO_COLOR` removes color.

Release editing, command search, review, help, artifact inspection, and cancellation appear in centered dialogs. Long reviews and help scroll with arrow keys or Page Up/Page Down, while dialog controls stay visible. The command palette scrolls through all results and supports multiword search; Home/End jump to the first/last match. Confirmation defaults to Cancel. A release never automatically publishes: validation runs first, its logs remain available to read, and P opens a separate upload review.

## Workspace controls

- **W / A / L** jump to workspace, artifacts, and logs; **Tab / Shift+Tab** cycle views. Arrow keys or **J/K** move within the current view. Enter on an artifact shows its full path, file size, modified time, and verification status.
- **F2** in the version editor cycles Suggested, Patch, Minor, Major, and Rebuild. Patch/minor/major increase the build. Rebuild preserves both version and build. **Esc** from release review returns to the edited draft.
- **F** filters log output. **Enter** applies the filter and **Esc** clears it. Log entries have elapsed timestamps and wrap to the panel width. Scrolling pauses following; new output keeps the visible lines in place. **End** resumes following.
- **E** saves the retained session log with timestamps to `dist/tui-logs/` and shows the full path. This explicit export is disabled in demo mode to keep it read-only.
- **T** after failure or cancellation reviews the remaining stages. Resuming keeps completed stage indicators and the original release mode. An interrupted version change returns to version setup. Publishing always goes back through validation.
- **1–6** in the step view reviews the corresponding step. On other views, **1 / 2 / 3** open new release, publish, and step selection.

## Implementation

- `index.js`: CLI flags, terminal lifecycle, raw keyboard input, resize handling, and differential drawing.
- `app.js`: navigation, forms, action review, and publish validation flow.
- `view.js`: responsive workspace, readiness, artifacts, pipeline, and task status.
- `terminal.js` / `dialogs.js`: color, width handling, wrapping, and scrollable overlays.
- `logs.js`: cached wrapping, filtering, and stable log scroll positions.
- `model.js`: streamed checksum validation, plist inspection, prerequisites, and release planning.
- `runner.js`: sequential backend commands, bounded output, UTF-8 decoding, process-group cancellation, and demo simulation.
- `tui.test.js`: planning, keyboard, terminal-size, checksum, failure, and child-process tests.

Real actions invoke `script/release.sh` with an argument array. The shell backend still performs signing, notarization, Gatekeeper checks, release validation, and GitHub upload. Tool output is stripped of terminal control sequences. Output retains the latest 2,500 lines for the current session. Cancellation sends SIGTERM to the entire process group and escalates to SIGKILL after three seconds if needed. Completed files and version edits are retained so individual steps can be rerun.

Run `bun run test:tui` to validate the cockpit. `bun run tui --snapshot` prints a read-only plain-text frame, useful from a noninteractive shell.

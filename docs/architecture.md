# releaseThis architecture

Living plan for turning releaseThis into a host cockpit that runs a repo's own release workflow through plugins.

This document is the source of truth for that generalization. The work required to reach it is listed in [`implementation.md`](implementation.md). The cockpit behavior that exists today is described in [`src/release/README.md`](../src/release/README.md). When these disagree about where the program is going, this document wins. When they disagree about what the current TUI already does, the code and the cockpit README win.

## How we extend this document

Update this file as the plan changes. Keep it accurate enough that a later session can continue without the original conversation.

- Record a settled choice in [Decisions](#decisions). Leave rejected alternatives there in one line so they are not re-litigated by accident.
- Park anything unresolved in [Open questions](#open-questions). When one is resolved, move it into Decisions and delete it here.
- When a roadmap phase lands, check it off and note which modules changed.
- Mark speculative mechanism details as **working proposal** until they are promoted into Decisions. The direction below is adopted. The exact sentinel syntax, filenames, and timing constants are working proposals.
- Do not copy this plan into README or the cockpit README. Link here instead.
- Keep implementation breakdown in [`implementation.md`](implementation.md). Mechanisms, data shapes, and file-level steps belong in that section's technical document under `docs/impl/`, not here.

## Intent

releaseThis is a fast terminal cockpit. A project adapts it by shipping a **profile**: the tasks, artifacts, modes, and plans of that project's release. The host paints the cockpit, stores facts, runs one plan at a time, and samples status. It does not know HoldThis, notarization, or GitHub.

The reason for plugins is adaptation. A different repo, with a different release script and a different definition of "done," should be able to use the same cockpit without forking the renderer.

HoldThis's current pipeline is the first profile and the stress test for the host. It is not the architecture.

## Current state

The cockpit renders a profile. `bin/cli.js` loads `releasethis.config.js` from the working directory. HoldThis stays the in-process profile for this package when that file is absent.

| Path | Role today |
|---|---|
| `bin/cli.js` | Entrypoint. Loads the cwd profile, then demo, snapshot, motion, and wiring. HoldThis is the fallback only when this package is the cwd and the config file is absent. |
| `src/tui/runtime.js` | Raw input, resize, differential paint, snapshot mode. The draw loop asks `frame.js` when to paint. |
| `src/tui/frame.js` | 90ms frame clock. Coalesces log, status, chrome, and animation into one paint per frame. |
| `src/tui/terminal.js` | Palette, fit/wrap, boxes, spinner, progress bar. |
| `src/tui/format.js` | Byte sizes and durations. |
| `src/tui/logs.js` | Log viewport. Append-only wrap cache keyed by width and filter. A paused viewport keeps its anchor. The 2,500-line cap lives in the runner. |
| `src/tui/runner.js` | Plan runner. Spawns a task command when the job has one, otherwise the profile script with the task's argv. Cancel is SIGTERM to the process group, then SIGKILL after three seconds. Demo playback reads lines declared on the task. Child `::status` lines fill the status slot and stay out of the transcript. The recorded plan instance sits beside `jobs`. |
| `src/workflow/model.js` | Facts, task resolution, semver and integer fields, plan resolve, and command-binding checks. |
| `src/workflow/load.js` | Loads `releasethis.config.js` into the profile object. A missing or invalid file becomes an empty cockpit. |
| `src/profiles/holdthis.js` | HoldThis catalog, probes, version parameters, signed-only mode, publish plan, demo lines, and product copy. |
| `src/release/app.js` | Session: navigation, plan start, publish's validate-then-upload gate, mode toggle, resume, and demo fact application. It does not name HoldThis paths or stage ids. |
| `src/release/view.js` | Header, tabs, pipeline, artifacts, logs, progress. Rows, readiness, and the header come from the profile's descriptors. The running row and footer read the status slot. |
| `src/release/dialogs.js` | Palette, schema-driven form, help generated from the command list, and confirmations. |
| `src/release/repo.js` | GitHub `owner/repo` from `origin` or `RELEASETHIS_REPO`. |

The HoldThis catalog, in [`src/profiles/holdthis.js`](../src/profiles/holdthis.js), is:

| Id | Label | Work |
|---|---|---|
| `build` | Build app | Compile and stage the app bundle |
| `sign` | Sign app | Developer ID and hardened runtime |
| `notarize-app` | Notarize app | Submit to Apple and staple |
| `zip` | Updater archive | Package the update ZIP |
| `dmg` | Installer image | Create the installer DMG |
| `checksums` | Verify checksums | SHA-256 for both archives |

Jobs that exist outside that list: `version` (optional first step when the version or build changes), `preflight` (`publish --dry-run`), and `publish` (the upload). A release never publishes itself. Signed-only mode skips notarization and flags zip and dmg with `--signed-only`.

Paint behavior worth keeping:

- `render` is a pure read of state. `runtime.js` writes only rows that changed.
- Active work uses a 90ms frame clock for the spinner and elapsed time. Log lines and status patches share that paint. Idle screens do not animate.
- A keypress updates state and draws immediately, without wrapping log lines that arrived since the last frame.
- Log wrapping is append-only. A paused viewport keeps its anchor when new lines arrive.
- `--no-motion`, `RELEASETHIS_REDUCED_MOTION=1`, `M`, and `NO_COLOR` already exist.

Phase 1 has landed. The sampler is `src/tui/frame.js`. An identical status patch does not mark the frame dirty. Phase 2 has landed in `src/tui/runner.js` and `src/release/view.js`: child `::status` lines fill the slot, and the running row and footer read it. Phase 3 has landed: facts, tasks, and plans are the product model, and HoldThis is the in-process profile. Phase 4 has landed in `src/workflow/load.js`: the cwd profile is `releasethis.config.js`. A missing or invalid file opens an empty cockpit. This package still opens HoldThis when that file is absent. Phase 5 has landed in `src/workflow/refresh.js`: refresh runs probes off the key path, isolates a failed probe, and streams checksums. Phase 6 has landed in `examples/library`: a library profile with its own task ids and publish plan runs through the same cockpit, and the host does not branch on profile id.

## Target

```text
host          terminal, chrome, facts, plan runner, status sampler, profile loader
profile       one repo's workflow: tasks, order, artifacts, modes, plans, forms
tasks/probes  capabilities the profile composes
```

The host with no profile is an empty cockpit that explains how to add one. It does not open the HoldThis pipeline.

### Facts, tasks, and plans

These three nouns are the whole product model.

A **fact** is a named observation: `version.source`, `artifact.app.built`, `artifact.update.zip`, `notarization.stapled`, `checksum.dmg`. Probes write facts on refresh. Tasks require facts and produce facts. The artifact list is the artifact facts. Readiness is how many facts the active plan needs are satisfied.

A **task** is a capability. It has a stable id, a label, a detail, requirements, the facts it produces, and a way to run. Sign does not import build. It requires `artifact.app.built`. The unmet requirement carries the sentence the UI shows.

A **plan** is an ordered run. "New release" and "Publish" are plans. The profile's `resolve(ctx)` returns the task list for this run (today's `planRelease`). The host runs that list and records it for resume. Plan order is the product sequence. Requirements answer whether a single step can run against the current facts. A full plan run trusts its own order. A single-step run checks requirements first.

Plugins share the fact store and nothing else.

### Profiles and task plugins

Task plugins are capabilities. A profile is the product.

| Plugin | Today | Requires | Produces |
|---|---|---|---|
| `build` | `build` | source tree | built app |
| `sign` | `sign` | built app | signed app |
| `notarize` | `notarize-app` | signed app, and notarization enabled | stapled ticket |
| `zip` | `zip` | signed app, or a stapled ticket | updater archive |
| `package` | `dmg` | same as zip | installer image |
| `verify` | `checksums` | both archives | verified checksum facts |

Zip and package stay separate tasks. They produce different artifacts and can fail independently. A profile may group them under a packaging heading in the sidebar.

Verify is a task and a probe. The task writes checksums. The probe, on refresh, hashes existing files and sets `verified` or `mismatch`.

Publish and version belong to the profile as different contributions:

- **Version** is a parameter schema on the release plan (semver, build, presets). The host draws the form from field types. The profile supplies bump rules.
- **Publish** is a second plan with a confirm gate: validate, then a dangerous confirm, then upload. The host supports "confirm before the next task." It does not know GitHub.
- **Signed-only** is a mode. Tasks declare when they are skipped or which arguments they gain. The header chip and the `N` binding come from that mode.

`script/release.sh` stays the HoldThis backend. Task plugins invoke it with different arguments. Splitting that shell script is out of scope for this architecture. The task contract already allows a later plugin to call another executable.

### What the host owns

- Terminal lifecycle: raw mode, alternate screen, resize, differential paint, snapshot, motion, `NO_COLOR`.
- Chrome: header, tabs, sidebar, main panel, progress, notice, one modal, log viewport, command palette.
- Layout: wide terminals get the pipeline sidebar, narrow ones get one panel, 58×20 remains the floor.
- Palette and tone mapping: mint done, ice running, amber attention, rose failure.
- The fact store, the plan runner, and cancellation (SIGTERM, then SIGKILL after three seconds).
- Structural keys: Ctrl+C, `Q`, Tab, arrows, Esc, `/`, `?`.
- Profile loading from the repo being released.
- Helpers the declarative path needs: command task, file probe, checksum probe, semver and integer fields.

### What a plugin must not do

- Draw, or receive `stdin`, the screen, or another plugin.
- Write to the terminal, or await a paint.
- Spawn except through the host, so cancellation and stream splitting stay in one place.
- Keep a private copy of the workspace.
- Bind keys by listening for input. A plugin registers a command. One binding, one winner, profile priority.
- Do heavy synchronous work on the status path. Hashing and compilation happen in the child process.

Code registration is the escape hatch when a probe cannot be expressed as a file check or a command. Plist inspection and `stapler validate` live in the HoldThis profile.

### Host contract

Working proposal for the registration surface:

```text
host.task(...)
host.probe(...)
host.artifact(...)
host.plan(...)
host.action(...)
host.mode(...)
```

A task `run(ctx)` returns a command (`argv`, `cwd`) or an async function. Context:

```text
{ root, repo, demo, mode, facts, params, log, status, spawn }
```

`root` and `repo` stay host concerns. `repo.js` stays the default detection (`origin`, overridable with `RELEASETHIS_REPO`).

Demo mode plays lines declared on the task and applies that task's produced facts. Refresh then overwrites those facts with probes. One path. The HoldThis message table in `runner.js` goes away.

### Status and responsiveness

Plugins have to report fine-grained progress. The cockpit has to stay responsive while they do it. Bun is one thread, so the paint path and the key path cannot do plugin work.

Two channels:

**Status** is one small slot on the running task. `ctx.status(patch)` overwrites it. The slot holds:

- `phase` — short label, host-truncated
- `detail` — one short line, host-truncated
- `progress` — a number from 0 to 1, or null when indeterminate
- `completed` / `total` — optional counters
- `heartbeatAt` — stamped by the host on every accepted update

Patches are not history. A patch that does not change visible text does not mark the frame dirty. Patches that arrive between paints collapse to the latest one.

**The log** is the transcript. Child stdout and `ctx.log` append to the bounded buffer. Progress does not go through the log.

The frame clock samples both channels. While a task runs, paints happen at most once per 90ms tick. A keypress still paints on the next turn and never waits for a plugin. Elapsed time is read from the host clock during render. `render` does not call plugins.

The running pipeline row and the footer bar read the same slot. A number draws a determinate bar. `null` keeps the spinner. After 15 seconds with the process still alive, the footer keeps the phase and says work is still going, with the age of the last update, so a wait such as notarization does not look frozen. On completion the row collapses to its label and duration. Reduced motion still updates the phase text and the bar.

Shell tasks report through this line, lifted out of the child stream by the runner:

```text
::status phase=Linking progress=0.66 completed=2 total=3
::status phase=Notarizing detail="Waiting for Apple"
```

The parser is one check per line. Sentinel lines update the slot and stay out of the transcript. Any other line is a log line. A malformed sentinel is logged as text and does not fail the task. A JavaScript task calls `ctx.status` and uses the same slot.

Log work that has to land before plugins are allowed to be noisy:

- Split status dirtiness from log dirtiness.
- Coalesce runner updates onto the frame clock while a task is running.
- Wrap only new log lines and append them to the cache. A following view paints the tail. A paused view keeps its anchor.
- Keep the 2,500-line cap and the per-line length cap.

Probes may be slow. They run off the key path, set a refreshing indicator, yield, and report through the same status slot. `Q`, tab, and cancel keep working during a refresh. One probe's failure surfaces as a notice and leaves the other facts in place.

Frame budget, to be tested:

- A keypress never waits on a plugin or on a log flush.
- While a task runs, at most one paint per frame.
- Idle: no animation work, and an identical status patch does not dirty the frame.
- Snapshot mode prints one frame and does not stream.

### How a repo adapts

The profile is the unit of adaptation. The host loads `releasethis.config.js` from the current working directory.

A declarative profile names:

- Tasks, as argv templates, with requirements and produced facts.
- Artifacts, as paths a file probe can stat.
- Modes, and how tasks skip or gain arguments under each mode.
- Plans, including a confirm gate before a dangerous task.
- Parameters for the form (version, build, presets).

A library that tests, packs, and publishes should fit in that file. So should a CLI that builds, checksums, and calls `gh release create`. Neither mentions notarization. Adding one of them must not require a renderer change, and the host must not branch on profile id.

The HoldThis profile uses the declarative shape where it can, and code probes where it cannot (plist, stapler, streaming checksums).

Plugins are trusted local modules. This plan does not add a sandbox, hot reload, or a version solver.

### Invariants

- One plan runs at a time.
- Resume replays the recorded task list, parameters, and mode, and skips tasks already done.
- Completed tasks are kept after failure or cancellation.
- A release plan and a publish plan stay separate, so packaging never uploads by itself.
- Structural keys stay with the host. Profile commands bind the rest.
- Layout, palette, dialogs, and differential paint stay with the host.
- Task order for a full run comes from the plan. Single-step gating comes from requirements.

## Roadmap

Each phase leaves `bun run tui:demo` and the current tests behaving as they do now, except where the phase explicitly changes output. Check a phase when it has landed.

- [x] **1. Make bursts cheap.** Split status dirtiness from log dirtiness. Coalesce runner updates onto the frame clock while a task is running. Wrap only new log lines. Ignore patches that do not change visible text. Exit when a synthetic flood of lines and status patches still paints once per frame, and a keypress does not wait on that flood. Landed in `src/tui/frame.js`, `src/tui/logs.js`, and `src/tui/runner.js`.
- [x] **2. Add the status slot to the current runner.** Parse the status sentinel in `runner.js`. Point the active pipeline row and the footer at the slot. Teach the demo stages to emit phases. Exit when a demo task shows a phase and, when it has a fraction, a moving bar, and sentinel lines do not appear in the log. Landed in `src/tui/runner.js` and `src/release/view.js`.
- [x] **3. Turn the HoldThis cockpit into an in-repo profile.** Introduce facts, tasks, and plans as data. Move the catalog, artifact paths, release planning, step requirements, publish blockers, signed-only, and the publish gate behind that profile. The view renders tasks and facts. Exit when `view.js` and `app.js` no longer mention HoldThis paths or stage ids, and the existing keyboard, blocker, and pipeline tests pass against the profile. Landed in `src/workflow/model.js`, `src/profiles/holdthis.js`, `src/tui/runner.js`, and `src/release/`.
- [x] **4. Load a profile from the repo being released.** Read the profile from the current working directory. Support command tasks, file artifacts, modes, plans, and confirm gates. A missing profile explains how to add one. Exit when a fixture repo with three declarative steps runs under demo and against a temp script, and the HoldThis demo still passes. Landed in `src/workflow/load.js`, `bin/cli.js`, `src/tui/runner.js`, and `src/release/`.
- [x] **5. Refresh without freezing.** Run independent probes concurrently, isolate a probe failure to its own facts, and stream checksums. Show probe progress through the status slot. Exit when a slow probe does not block `Q` or tab changes, and one failed probe leaves the other facts on screen. Landed in `src/workflow/refresh.js`, `src/workflow/load.js`, `src/profiles/holdthis.js`, and `src/release/`.
- [x] **6. Prove the host is generic.** Add a second fixture profile with different task ids, no Apple steps, and its own publish plan. Exit when adding that fixture does not require a renderer change, and the host has no branch on profile id. Landed in `examples/library` and `test/profile.test.js`.
- [ ] **7. Move HoldThis out, when that repo is migrated.** The profile lives in the HoldThis repo. This package is the host. Keep a reference profile under something like `examples/holdthis` so the cockpit can still be developed here. Exit when a foreign repo can depend on `releasethis` and ship only its profile.

Phase 1 comes before any plugin is allowed to report often. Phase 3 comes before the config format is promised, so HoldThis is the schema's stress test. The declarative path is what foreign repos should use.

### Where today's modules go

| Module | Destination |
|---|---|
| `src/tui/runtime.js`, `frame.js`, `terminal.js`, `format.js`, `dialogs.js` | Stay host. |
| `src/tui/logs.js` | Stay host. Append-only wrap cache landed in phase 1. |
| `src/tui/runner.js` | Host plan runner and status parser. The latest-value slot landed in phase 1. The HoldThis demo table left in phase 3; tasks declare their own lines. A job with a command argv is spawned directly as of phase 4. |
| `src/tui/frame.js` | Frame sampler from phase 1. One paint per 90ms tick for log, status, and animation. |
| `src/release/view.js`, `app.js` | Host chrome and session. They read profile descriptors. A profile may omit a mode and a publish plan. |
| `src/profiles/holdthis.js` | HoldThis profile: tasks, probes, plans, modes. In-process through phase 6. |
| `src/workflow/load.js` | Profile loader. Reads `releasethis.config.js` from the cwd. |
| `src/workflow/refresh.js` | Probe refresh. Disjoint probes run together, a failed probe keeps its previous facts, and checksum archives stream. |
| `src/release/repo.js` | Stay host. |
| `bin/cli.js` | Loads `releasethis.config.js`. Registers HoldThis in-process when this package is the cwd and that file is absent. |

## Decisions

Settled in the planning conversation on 2026-11-08.

| Decision | Notes |
|---|---|
| The host is the cockpit and the plugin interface. Product behavior is plugins. | Skeleton UI stays coherent because plugins return descriptors. |
| The product model is facts, tasks, and plans. | Shared memory is the fact store. |
| A profile is the unit of adaptation. Task plugins are capabilities a profile composes. | Foreign directories do not fall back to HoldThis. This package keeps the in-process profile through phase 6 when `releasethis.config.js` is absent. |
| Zip and package are separate tasks. | Package is today's DMG step. A sidebar group is optional. |
| Publish is its own plan with a confirm gate. | Packaging must not upload by itself. |
| Signed-only is a mode, not a branch in the view. | |
| Version editing is a parameter schema, not a stage. | The host provides semver and integer fields. |
| High-resolution progress is a latest-value status slot, sampled once per frame. | The log remains the transcript. |
| Keypresses paint immediately and never wait on plugin work. | |
| Heavy work runs in a host-spawned child. | Cancel and stream parsing stay in the runner. |
| Foreign repos adapt with a profile in their own tree. | Declarative config is the common path. Code registration is the escape hatch. |
| HoldThis's `script/release.sh` is a backend the profile calls. | Splitting that script is out of scope here. |
| Plugins are trusted local modules. | No sandbox, hot reload, or dependency solver in this plan. |
| The first profile must reproduce today's HoldThis flow. | That is the acceptance test of the host. |
| Phases land in the order in the roadmap. | Burst handling before chatty plugins. In-repo profile before a public config format. |
| Probes that declare disjoint fact keys run concurrently. | Phase 5 default. |
| Status sentinels are `::status key=value` lines. | Double quotes hold spaces. `\"` and `\\` are the escapes. A malformed line is logged and does not fail the task. Sentinels stay out of the transcript. |
| A running status slot is quiet after 15 seconds. | The footer keeps the phase and says work is still going, with the age of the last update. |
| The in-repo HoldThis profile lives at `src/profiles/holdthis.js` through phase 6. | `bin/cli.js` registers it. The cockpit does not import it. |
| Phase 3 keeps today's task ids, with argv stored separately. | Ids stay `notarize-app`, `dmg`, and `checksums`. A later rename does not have to change `script/release.sh` arguments. |
| HoldThis renders six flat pipeline rows. | The host prints a group heading only when a task sets `group`. This profile does not. |
| Structural keys and host chrome win a binding collision. | A profile key that repeats a reserved key, or another profile key, is rejected when the session is constructed. |
| The profile file is `releasethis.config.js`. | ESM default export from the cwd. No JSON or `package.json` form. One profile per repo, with no `--profile` flag. |
| Declarative demo lines are inline `{ text, status }` entries. | Demo playback does not substitute a fake PATH. Command tasks still report only through `::status`. |

## Open questions

3. Stale-status threshold. The host uses 15 seconds. Should a profile be able to override it for long quiet tasks?
4. Task id scheme. Working proposal is short ids inside a profile (`sign`, `zip`) with the profile as the namespace, so two profiles can both have a `build` task.
5. Sidebar grouping. Do zip and package render as a packaging group, or as six flat rows matching today?
6. Declarative status parsing. Is the sentinel the only supported channel for command tasks, or can a profile also name a single line pattern for tools that already print `40%`?
7. Form field set. Semver and integer shipped with phase 3. String, choice, and bool remain the working set. What is the first real field type a second profile needs that this set cannot cover?

## Working notes

Space for the next session. Promote anything that settles into Decisions, and fold implementation detail into the matching roadmap phase.

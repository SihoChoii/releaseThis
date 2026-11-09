# Implementation plan

High-level breakdown of the work required to reach the architecture in [`architecture.md`](architecture.md).

[`architecture.md`](architecture.md) decides what releaseThis becomes. This document lists every body of work required to get there. Each section below will later get its own technical document under `docs/impl/`. Those documents own mechanisms, data shapes, and file-level steps. This one stays at the level of outcomes, scope, dependencies, and completion.

Section order below is a design boundary, not the build order. The build order is in [Sequence](#sequence).

## Status

| Section | Technical document | Build phase | State |
|---|---|---|---|
| [Frame budget](#1-frame-budget) | `docs/impl/frame-budget.md` | 1 | Done |
| [Status channel](#2-status-channel) | `docs/impl/status-channel.md` | 2 | Done |
| [Workflow model](#3-workflow-model) | `docs/impl/workflow-model.md` | 3 | Done |
| [Cockpit](#4-cockpit) | `docs/impl/cockpit.md` | 3 | Done |
| [Plan execution](#5-plan-execution) | `docs/impl/plan-execution.md` | 3 | Done |
| [HoldThis profile](#6-holdthis-profile) | `docs/impl/holdthis-profile.md` | 3 | Done |
| [Profiles](#7-profiles) | `docs/impl/profiles.md` | 4 | Not started |
| [Workspace refresh](#8-workspace-refresh) | `docs/impl/workspace-refresh.md` | 5 | Not started |
| [Host genericity](#9-host-genericity) | `docs/impl/host-genericity.md` | 6–7 | Not started |

Phases match the roadmap in the architecture document. A phase is done only when every section that lists it meets that phase's exit.

## 1. Frame budget

**Technical document:** `docs/impl/frame-budget.md`

The paint path can absorb a flood of log lines and status patches. Plugins are not allowed to report often until this exists.

**Outcome.** The terminal stays responsive while a task produces far more output than a person can read. The sampler paints a running task at most once per frame. A keypress paints on its own turn and does not wait for that flush.

**Scope.**

- Separate dirtiness for status, log text, and animation.
- Coalesce runner updates onto the frame clock while a task is running.
- Append-only log wrapping, so a new line does not rewrap the retained buffer.
- Ignore updates that do not change visible text.
- Keep the existing caps on retained lines and line length.
- Keep idle screens free of animation work.
- Keep snapshot mode as one static frame.

**Depends on.** The current runtime, log viewport, and runner. No profile model.

**Done when.** A synthetic flood of lines and status patches paints once per frame, and a keypress during that flood does not wait on the flush. Existing demo behavior and tests still pass.

**Open questions.** None. Sentinel grammar belongs to the status channel.

## 2. Status channel

**Technical document:** `docs/impl/status-channel.md`

Plugins and child processes report fine-grained progress through one latest-value slot. The log stays the transcript.

**Outcome.** The running pipeline row and the footer detail show the same phase, detail, and progress. The done/total stage bar and count stay. Quiet tasks still look alive. High-frequency patches collapse to the latest value and do not flood the log.

**Scope.**

- One status slot on the running task: phase, detail, optional progress, optional counters, host-stamped heartbeat.
- Updates from JavaScript and from child-process output, into that same slot.
- A line protocol that the runner lifts out of stdout and stderr. Those lines stay out of the transcript. A malformed line is logged as text and does not fail the task.
- Sampling on the frame clock from section 1. Identical patches do not dirty the frame.
- Determinate bar on the running row when progress is known. A null progress leaves the spinner.
- The done/total stage bar and count stay in the footer. The slot supplies the footer detail: phase, detail, and elapsed time read from the host clock during render.
- Stale-status presentation when the process is alive and the slot has gone quiet.
- Reduced motion still updates phase text and the bar.
- Demo stages emit phases through this channel. The HoldThis message table remains until the profile cut, but new progress goes through the slot.

**Depends on.** Frame budget.

**Done when.** A demo task shows a changing phase and, when it reports a fraction, a moving bar. Sentinel lines do not appear in the log. The frame budget test still holds.

**Open questions.** Architecture question 3 (whether a profile may override the 15-second stale threshold) and question 6 (whether a declarative line pattern exists beyond the sentinel).

## 3. Workflow model

**Technical document:** `docs/impl/workflow-model.md`

The host's product model: facts, tasks, plans, and the other descriptors a profile is allowed to contribute. Shared memory is the fact store.

**Outcome.** A workflow can be described without the host knowing the product. Requirements, plan order, modes, parameters, and confirm gates are data.

**Scope.**

- Facts: named observations with state and provenance.
- Tasks: id, label, detail, requirements, produced facts, and a way to run.
- Requirement results: ready, blocked (with the message to show), or skipped.
- Plans: an ordered resolution of tasks for one run, including optional confirm-to-start and confirm-before-next.
- Modes that tasks consult when resolving skip and extra arguments.
- Parameters and presets for the release form. The host's field types cover semver and integer at minimum. Cross-field rules reject at resolve time and return the error to the form.
- Actions: labeled commands a profile contributes, separate from structural keys.
- Artifacts as facts the artifact list can render, carrying path, size, mtime, and the explanation shown in the detail dialog.
- A recorded plan instance: task ids, parameters, mode, and per-task status, kept in session memory on the runner, so resume is uniform.
- Demo declarations on a task: scripted lines and the facts a simulated run produces.

Single-step gating uses requirements against current facts. A full plan run uses plan order. Plugins do not import each other.

**Depends on.** Nothing in the later sections. Can be designed beside the frame work. Lands in the phase 3 cut with the cockpit, the runner, and the HoldThis profile.

**Done when.** The current HoldThis decisions (stage order, blockers, signed-only skip, the conditional version task, version presets, the build constraint, publish as a separate gated plan) can be expressed as data in this model, and tests for those decisions talk to the model.

**Open questions.** Architecture questions 4 (task id scheme) and 7 (which field types ship). Confirm-gate behavior is decided: publish stays a separate plan.

## 4. Cockpit

**Technical document:** `docs/impl/cockpit.md`

The skeleton UI. It renders descriptors from the workflow model and owns every pixel.

**Outcome.** Header, tabs, pipeline, workspace, artifacts, logs, progress, notices, dialogs, and the command palette work for any profile. The renderer no longer carries HoldThis paths, stage ids, header copy, or help text.

**Scope.**

- Chrome and layout already in the cockpit: wide sidebar, narrow single panel, 58×20 floor, palette, differential paint.
- Pipeline rows from the release catalog, with requirement and mode results applied, including a visible skipped row. A single step is one catalog task. During publish, and while the conditional version task runs, the sidebar stays on that catalog.
- Optional sidebar group headings, if the profile asks for them.
- Workspace and readiness from facts and the release catalog.
- Artifact list from artifact facts.
- Log panel from the host transcript.
- Footer detail from the status slot and the host clock. The done/total stage bar and count stay.
- Hint line generated from the commands valid on the current screen. The help dialog is generated from the same command lists.
- Structural keys reserved by the host: Ctrl+C, `Q`, Tab, arrows, Esc, `/`, `?`.
- Host chrome besides those keys: W/A/L, J/K, F, E, R, T, M, Ctrl+P, log paging, and 1–6 on the step screen. F2, cursor editing, and Ctrl+U are host form behavior driven by the parameter schema.
- Profile commands dispatched through one registry. One binding wins. The current profile's actions are home-screen 1, 2/P, 3, and N.
- Header subtitle and mode chip come from the profile.
- Generic confirm, info, and form dialogs. The form is drawn from the plan's parameter schema. Confirm-to-start defaults to Cancel. Escape from release review returns to the edited draft. Resolve errors stay on the form.
- Empty and missing-profile presentation, filled in when the loader exists.
- Snapshot rendering from the same descriptors.

Plugins do not draw and do not receive the screen.

**Depends on.** Workflow model. Status channel for the live row and footer. Frame budget for paint.

**Done when.** `view.js`, `app.js`, and `dialogs.js` no longer carry HoldThis paths, stage ids, or product copy, including the header. Keyboard, layout, and dialog behavior that exists today still works against the HoldThis profile.

**Open questions.** Architecture questions 5 (flat rows versus a packaging group) and 8 (collisions with structural keys).

## 5. Plan execution

**Technical document:** `docs/impl/plan-execution.md`

The host runs one resolved plan, supervises its processes, and records the result.

**Outcome.** Start, cancel, failure, and resume behave the same for every profile. The runner no longer knows `script/release.sh` or HoldThis demo lines.

**Scope.**

- One plan at a time.
- Run a resolved task list in order. Skip tasks the resolution marked skipped.
- Host spawn for every child: streaming, cancellation of the process group, SIGKILL after the grace period, output caps.
- Status lines and log lines split by the status channel.
- Stop the plan on failure or cancel. Keep completed tasks.
- Resume from the recorded session instance, skipping tasks already done. Resume of a publish plan re-runs validation, and toggling the mode clears a finished validation.
- Confirm-to-start holds the plan until the cockpit accepts.
- Confirm-before-next holds the plan between tasks. After publish validation, the cockpit returns to the log with no modal, and the continue command opens the dangerous upload confirm.
- Demo playback from the task's declared lines, then apply the task's produced facts. Demo refresh in this phase keeps those facts.
- Session log export of the transcript, with demo export remaining disabled.

**Depends on.** Workflow model, status channel, frame budget. The cockpit presents gates and notices.

**Done when.** The current release, single-step, publish validation, upload, cancel, and resume flows pass through this runner. A second profile can run without a runner change.

**Open questions.** Architecture question 10 (how declarative tasks describe demo playback).

## 6. HoldThis profile

**Technical document:** `docs/impl/holdthis-profile.md`

The current product, expressed as the first profile. This is the acceptance test of the host.

**Outcome.** `bun run tui` and `bun run tui:demo` reproduce today's HoldThis cockpit: six tasks, version editing, signed-only, artifact checks, and a separate publish plan.

**Scope.**

- Tasks for build, sign, notarize, zip, package (today's DMG), and verify. Visible labels stay: Updater archive, Installer image, Verify checksums. They are invoked as arguments to `script/release.sh`. Those arguments stay `notarize-app`, `dmg`, and `checksums` even if task ids change under architecture question 4.
- A conditional version task, prepended when the version or build differs from source. Arguments are `version` with `--keep-build` or `--build`. The sidebar keeps showing the release catalog while it runs. Resume of an unfinished version task reopens the form.
- Version as plan parameters, including the current presets. The profile owns the suggested default (bump only after a complete matching release), the rule that build is at least the source build, and rejection of `0`, leading zeros, and non-semver text.
- Signed-only as a mode: notarize stays visible and skipped, zip and package flagged.
- Actions bound to home-screen 1, 2/P, 3, and N.
- Publish as its own plan: dry-run validation, then a return to the log, then a dangerous confirm, then upload. Resume re-runs validation.
- Probes for source and built versions, artifact presence, staple check, and checksum verification.
- Artifact paths and readiness copy that today live in `model.js` and `view.js`. Header subtitle (`Apple Silicon`) and the mode chip move here with that copy.
- Demo lines and produced facts for each task. Demo refresh keeps the facts a task applied.
- In-process registration. Phase 3 uses code probes and leaves the declarative file to the loader.

`script/release.sh` stays the backend. Splitting that script is out of scope.

**Depends on.** Workflow model, cockpit, plan execution.

**Done when.** Existing keyboard, blocker, pipeline, checksum, and failure tests pass against this profile, and the renderer has no HoldThis branch.

**Open questions.** Architecture question 9 (directory for the in-repo profile during phases 3–6).

## 7. Profiles

**Technical document:** `docs/impl/profiles.md`

A repo adapts the cockpit by shipping a profile. The declarative file is the common path. Code registration is the escape hatch.

**Outcome.** `releasethis` in a foreign repo loads that repo's workflow. A missing profile explains how to add one. The host does not fall back to HoldThis.

**Scope.**

- Load a profile from the repo being released (the current working directory).
- Declarative description of tasks, artifacts, modes, plans, confirm gates, parameters, and actions.
- Validation errors that name the problem and leave the cockpit usable.
- Code registration through the host surface: tasks, probes, artifacts, plans, actions, modes.
- Host helpers a declarative profile gets without custom code: command tasks, file artifacts, and the field types from the workflow model.
- Trusted local modules only. No sandbox, hot reload, or dependency solver.
- CLI wiring so demo, snapshot, and real runs use the loaded profile.

The checksum probe's streaming and failure isolation belong to workspace refresh. This section includes checksums only as a declarative artifact kind the loader can name.

**Depends on.** The phase 3 cut (model, cockpit, execution, HoldThis profile). HoldThis stays registered in-process until phase 7. This phase proves the loader with other fixtures.

**Done when.** A fixture repo with three declarative steps runs under demo and against a temporary script. A second fixture registers a code probe the declarative helpers cannot express, loads from the working directory, and runs. The HoldThis demo still passes. A repo with no profile does not show the HoldThis pipeline.

**Open questions.** Architecture questions 1 (filename and whether a non-JS form exists), 6 (declarative progress patterns), 10 (demo lines in a declarative task), and 11 (one profile per repo versus a named profile flag).

## 8. Workspace refresh

**Technical document:** `docs/impl/workspace-refresh.md`

Refreshing the workspace observes facts through probes without freezing the cockpit.

**Outcome.** Probes can be slow. Keys still work. One probe's failure does not wipe other facts. Checksum verification streams.

**Scope.**

- A refresh pass over the profile's probes, off the key path.
- A refreshing indicator, using the status channel for probe progress.
- Isolation: a failed probe becomes a notice and leaves sibling facts in place.
- Probes that declare disjoint facts run concurrently.
- Streaming checksum verification for large archives.
- Re-entry rules: no refresh while a plan is running; cancel or quit still works during a refresh.
- After a demo task applies produced facts, refresh runs probes. Demo probes return the scripted facts, so the workspace still shows those facts.

**Depends on.** Workflow model, status channel, HoldThis probes, and the profile loader's probe declarations.

**Done when.** A slow probe does not block `Q` or tab changes. One failed probe leaves the other facts on screen. HoldThis checksum behavior still matches the current tests. A demo refresh still shows the facts the task applied.

**Open questions.** None. Concurrency is decided: probes that declare disjoint facts run concurrently.

## 9. Host genericity

**Technical document:** `docs/impl/host-genericity.md`

Proof that the host is a product other repos can depend on, followed by moving HoldThis out.

**Outcome.** A non-HoldThis workflow runs with no renderer change and no branch on profile id. After extraction, this package is the host, and HoldThis ships only its profile.

**Scope.**

- A second fixture profile with its own task ids, no Apple steps, and its own publish plan.
- A check that adding it did not require a cockpit or runner change.
- Move the HoldThis profile to the HoldThis repo when that migration happens.
- Leave a reference profile in this repo, on the order of `examples/holdthis`, so the cockpit can still be developed here.
- Package boundary: a foreign repo depends on `releasethis` and supplies a profile. The published package does not require HoldThis files at runtime.

**Depends on.** Profiles and workspace refresh. Extraction also depends on the HoldThis repo being ready to own its profile. Phase 6 can land before that migration.

**Done when.** The second fixture satisfies phase 6. Extraction satisfies phase 7: a foreign repo runs with only its profile, and this repo's demo still runs from the reference profile.

**Open questions.** None beyond the loader questions in section 7. The extraction target is decided.

## Sequence

Build in this order. Later technical documents follow it. Sections that share a phase land as one behavior-preserving cut, even though their technical documents stay separate.

| Order | What lands | Phase | Sections |
|---|---|---|---|
| 1 | Bursts become cheap | 1 | Frame budget |
| 2 | Today's runner grows a status slot | 2 | Status channel |
| 3 | HoldThis moves onto the model without a behavior change | 3 | Workflow model, cockpit, plan execution, HoldThis profile |
| 4 | A repo in the working directory supplies the workflow | 4 | Profiles |
| 5 | Refresh stays interactive | 5 | Workspace refresh |
| 6 | A second workflow proves the host | 6 | Host genericity |
| 7 | HoldThis leaves this package | 7 | Host genericity |

Phase 3 is one cut. The cockpit must not keep the old stage list and the new model at the same time. The HoldThis profile is registered in-process in that cut. The file loader in phase 4 is how every other repo registers. HoldThis stays in-process until phase 7, then registers the same way.

Through phase 5, `bun run tui:demo` and the current cockpit tests remain the behavior lock, except where a phase explicitly changes output (status lines, missing-profile screen). Phase 3 keeps the facts a demo task applied across refresh. Phase 5 runs that refresh through probes, and demo probes return the scripted facts, so this lock still holds.

## Out of scope

These stay out of every technical document unless the architecture doc changes:

- Splitting `script/release.sh` into per-task scripts.
- A plugin sandbox, hot reload, or a version solver.
- Plugins drawing their own panels.
- The host knowing GitHub, Apple notarization, or HoldThis paths.
- Running more than one plan at a time.

## Extending this document

- Add a capability to the section that owns it. If no section owns it, add a section and a row in the status table.
- When a technical document is written, link it from the section header and from the status table.
- When a phase lands, update the state column and check the matching roadmap item in [`architecture.md`](architecture.md).
- Resolve open questions in the architecture doc, then drop the pointer here.

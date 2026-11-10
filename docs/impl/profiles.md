# Profiles

The host loads `releasethis.config.js` from the working directory. The file is ESM and default-exports either a declarative object or `host => { ... }`. There is one profile per repo. The loader does not read JSON, `package.json`, or a `--profile` flag.

A missing file opens an empty cockpit that names `releasethis.config.js`. It does not show the HoldThis pipeline. The exception is this package: when its own config file is absent, `bin/cli.js` still registers the in-process HoldThis profile. An invalid file opens the same empty cockpit and names the problem. `Q`, Tab, and `?` still work.

## Declarative object

`tasks` are command tasks. `argv` is a non-empty list of strings. `{version}`, `{build}`, and any other plan parameter are replaced from the plan's params. A missing parameter stops resolution with an error naming the parameter; a single-step action cannot run a parameterized command without its values. `requires` is a list of `{ fact, message }`. `produces` names fact keys the demo run marks present. `demo` is a list of `{ text, status }` lines, the shape the runner already plays. `skip: { when: 'signed-only', message }` skips the task while that mode is on. `catalog: false` keeps a task out of the sidebar.

`artifacts` are `{ key, label, path, kind }`. `kind` is `file`, `dir`, or `checksum`. Paths stay inside the repo. Inspect stats the path and sets `present` or `missing`. A checksum artifact keeps `kind: 'checksum'` and is not hashed. Streaming verification belongs to workspace refresh.

`plans` have `kind` of `run`, `form`, or `gated`. A `run` plan confirms, then starts its steps. A `form` plan names `semver` or `integer` fields and literal presets. Field labels must be text. The host checks field types before any custom `validate(ctx)` rule; errors stay in the editor. If every resolved task is skipped, the form says "Nothing to run" and does not offer a start confirmation.

A step can name a task directly, or use `{ task, confirm, after, pauseNotice }`. These gates work on all three plan kinds. `confirm` holds the next task until its confirmation is accepted, including on the first step. `after: 'pause'` returns to the log after the task completes. Press T, or invoke the same plan action again, to continue; if the next step needs confirmation, that opens its dialog. Cancelling that dialog leaves the plan paused. `pauseNotice` supplies the message shown while reading the log.

A `gated` plan has an initial `confirmStart`, at least two steps, and a confirmation on every step after the first. The validation step can use `after: 'pause'` to give the user time to read its output. Any later confirmed steps execute in order. The runner records the full task list, parameters, mode, and per-task status, and reports `paused` until the remaining steps finish. Validation and continuation belong to that recorded plan: another plan cannot reuse them. A workspace refresh or mode change invalidates continuation; starting the plan again repeats its validation. `resume: 'revalidate'` also restarts the selected gated plan after failure or cancellation.

`actions` bind keys to plans. `mode` supplies the chip, sidebar, and resume text.

Command tasks report progress only through `::status` lines. A profile cannot name a second line pattern.

## Code registration

`export default host => { ... }` receives `host.task`, `host.probe`, `host.artifact`, `host.plan`, `host.action`, and `host.mode`. A probe `run({ root, facts })` may write facts a stat cannot derive. A task may pass `command(ctx)` or `run(ctx)` returning an argv instead of a literal `argv` list. Modules are trusted local imports. There is no sandbox, hot reload, or dependency solver.

The runner spawns `command[0]` with the remaining arguments when a job has a command. Otherwise it spawns the profile script with the task's arguments, which is how HoldThis still runs.

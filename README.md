# releaseThis

Standalone home for the releaseThis release cockpit TUI, lifted here for independent development.

This is a Bun + JavaScript terminal cockpit. A project adapts it with `releasethis.config.js`. A directory with no config opens an empty cockpit. `bun run tui:demo` runs the HoldThis reference profile in [`examples/holdthis`](examples/holdthis). The plan is in [`docs/architecture.md`](docs/architecture.md). The work to get there is listed in [`docs/implementation.md`](docs/implementation.md).

## Requirements

- [Bun](https://bun.sh) 1.3 or later
- No npm dependencies

## Install in a host project

From the project you want to release:

```sh
bun add -d git+https://github.com/SihoChoii/releaseThis.git
bunx releasethis --demo
# or: bunx releasethis
```

The CLI uses the current working directory as the host project root. It reads `git remote get-url origin` for the GitHub `owner/repo` (override with `RELEASETHIS_REPO`).

## Run (this repo)

```sh
bun run tui:demo        # Demo the reference profile in examples/holdthis
bun run tui             # Same profile, real mode
bun run test            # Cockpit tests
```

`./script/release_tui.sh` uses the current directory. This repo's root has no profile, so that command opens the empty cockpit. Real HoldThis releases run in the HoldThis repo, which owns `script/release.sh`.

See [`src/release/README.md`](src/release/README.md) for the full cockpit design and keybindings.

## Layout

- `bin/cli.js` — public entrypoint (`releasethis` bin)
- `src/tui/` — reusable terminal primitives (paint, runner, logs, runtime)
- `src/release/` — cockpit session and views
- `examples/holdthis/` — reference HoldThis profile
- `examples/library/` — a second workflow with no HoldThis steps
- `test/` — cockpit tests

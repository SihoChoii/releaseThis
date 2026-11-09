# releaseThis

Standalone home for the releaseThis release cockpit TUI, lifted here for independent development.

This is a Bun + JavaScript terminal UI that drives a project’s release script. The current code still mirrors HoldThis’s pipeline and `./script/release.sh` backend. The plan for a plugin-based host that other repos adapt with their own profiles is in [`docs/architecture.md`](docs/architecture.md). The work to get there is listed in [`docs/implementation.md`](docs/implementation.md).

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
bun run tui:demo        # Interactive demo (no files changed)
bun run tui             # Real mode (expects a host project’s script/release.sh)
bun run tui --snapshot  # One plain-text frame, then exit
bun run test            # Cockpit tests
```

Or: `./script/release_tui.sh [--demo] [--snapshot] [--no-motion]`

See [`src/release/README.md`](src/release/README.md) for the full cockpit design and keybindings.

## Layout

- `bin/cli.js` — public entrypoint (`releasethis` bin)
- `src/tui/` — reusable terminal primitives (paint, runner, logs, runtime)
- `src/release/` — release cockpit product UI and HoldThis-shaped pipeline model
- `test/` — cockpit tests

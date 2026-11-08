# releaseThis

Standalone home for the HoldThis release cockpit TUI, lifted here for independent development.

This is a Bun + JavaScript terminal UI that drives a project’s release script. The current code still mirrors HoldThis’s pipeline, branding, and `./script/release.sh` backend. Generalizing it into a shared tool for other projects — and migrating HoldThis onto that tool — comes later.

## Requirements

- [Bun](https://bun.sh) 1.3 or later
- No npm dependencies

## Run

```sh
bun run tui:demo        # Interactive demo (no files changed)
bun run tui             # Real mode (expects a host project’s script/release.sh)
bun run tui --snapshot  # One plain-text frame, then exit
bun run test            # Cockpit tests
```

Or: `./script/release_tui.sh [--demo] [--snapshot] [--no-motion]`

See [`script/tui/README.md`](script/tui/README.md) for the full cockpit design and keybindings.

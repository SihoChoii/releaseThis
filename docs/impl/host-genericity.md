# Host genericity

Phase 6 is the proof that a second workflow runs on this cockpit. Phase 7 moves HoldThis out of this package.

## Fixture

[`examples/library/releasethis.config.js`](../../examples/library/releasethis.config.js) is a declarative profile with id `library`. It has no mode. Its tasks are `test`, `pack`, `checksum`, `validate`, and `upload`. Those ids are not HoldThis task ids, and none of the steps notarize or staple. Artifacts are `out/test.txt`, `out/library.tgz`, and `out/library.tgz.sha256`. The package and its checksum gate publish.

`release` is a run of `test`, `pack`, and `checksum`. `publish` is a separate gated plan: a start confirmation, `validate` with `after: 'pause'`, then a dangerous confirmation, then `upload`. `resume` is `revalidate`. `blocked` stays set until every `gatesPublish` fact is `present` or `verified`. A demo release marks those facts `present`, which opens publish. A real checksum probe can still mark the sidecar `verified`.

`1` starts release. `2` and `p` start publish. The log hint still says `P publish`. That string is host chrome, and this profile binds `p`, so the hint matches. Adding the fixture did not change the cockpit or the runner. [`src/release/view.js`](../../src/release/view.js), [`src/release/app.js`](../../src/release/app.js), and [`src/tui/runner.js`](../../src/tui/runner.js) do not branch on profile id.

The fixture includes an executable `release.sh` backed by `release.js` and a small library test suite. Real mode saves test output, creates a gzip tar archive, and generates its SHA-256 sidecar. Validation checks the digest and archive. Upload revalidates and copies both files into the local `out/published/` directory. The integration test copies this complete fixture and runs its backend; it does not substitute a script or create release artifacts itself. See the [example instructions](../../examples/library/README.md).

## Extraction

A default export whose `tasks` and `plans` are objects, not arrays, is a finished profile. [`loadProfile`](../../src/workflow/load.js) checks its runtime fields, descriptor shapes, and key bindings before returning it. An incomplete finished profile opens the error cockpit. Array exports still compile as declarative profiles. Function exports still use the code host.

[`examples/holdthis/profile.js`](../../examples/holdthis/profile.js) is that finished profile, and [`examples/holdthis/releasethis.config.js`](../../examples/holdthis/releasethis.config.js) re-exports it. `bun run tui:demo` runs from that directory. This package has no root config, so running the CLI here opens the empty cockpit.

The published package lists `bin/`, `src/`, and `README.md`. It exports `releasethis/workflow` and `releasethis/refresh` for a code profile that builds facts itself. The reference copy keeps relative imports. The HoldThis repo copy imports those export paths, depends on this package, and points `script/release_tui.sh` at `bin/cli.js`. `script/tui` remains in that repo for its existing tests. The release entrypoint no longer calls it.

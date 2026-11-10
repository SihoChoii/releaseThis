# Host genericity

Phase 6 is the proof that a second workflow runs on this cockpit. Phase 7, moving HoldThis out of this package, is still open.

## Fixture

[`examples/library/releasethis.config.js`](../../examples/library/releasethis.config.js) is a declarative profile with id `library`. It has no mode. Its tasks are `test`, `pack`, `checksum`, `validate`, and `upload`. Those ids are not HoldThis task ids, and none of the steps notarize or staple. Artifacts are `out/test.txt`, `out/library.tgz`, and `out/library.tgz.sha256`. The package and its checksum gate publish.

`release` is a run of `test`, `pack`, and `checksum`. `publish` is a separate gated plan: a start confirmation, `validate` with `after: 'pause'`, then a dangerous confirmation, then `upload`. `resume` is `revalidate`. `blocked` stays set until every `gatesPublish` fact is `present` or `verified`. A demo release marks those facts `present`, which opens publish. A real checksum probe can still mark the sidecar `verified`.

`1` starts release. `2` and `p` start publish. The log hint still says `P publish`. That string is host chrome, and this profile binds `p`, so the hint matches. Adding the fixture did not change the cockpit or the runner. [`src/release/view.js`](../../src/release/view.js), [`src/release/app.js`](../../src/release/app.js), and [`src/tui/runner.js`](../../src/tui/runner.js) do not branch on profile id.

## Still open

Phase 7 moves the HoldThis profile into the HoldThis repo, leaves a reference profile on the order of `examples/holdthis`, and lets a foreign repo depend on `releasethis` without HoldThis files at runtime.

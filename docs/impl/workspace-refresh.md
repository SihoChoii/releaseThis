# Workspace refresh

Refresh reads the workspace through the profile's probes. The key path does not wait on them. `Q` and Ctrl+C abort the pass and quit. Tab changes views while the pass continues. A new plan does not start during a refresh, and a refresh does not start while a plan is running.

## Waves

`profile.probes` run in registration order. A probe with a non-empty `facts` list joins the current wave when none of those keys are already in it. Probes in one wave run together. A probe that omits `facts`, or repeats a key already in the wave, starts a later wave. Overlapping keys are not an error.

Each probe gets a deep clone of the current store. Facts must be structured-cloneable data, including their values, provenance, and other properties. On success the host copies back the keys it declared, or every key it `set` when it declared none. A throw copies nothing, including nested mutations. The notice is `Probe "<id>" failed: …`, and sibling facts from the same pass stay. An abort is not a failure and does not roll back probes that already finished; a probe still running at cancellation cannot publish its result. HoldThis passes the abort signal to its plist and stapler subprocesses. Terminal shutdown also aborts an active refresh.

The pass yields once before the first wave. Probe progress goes through the runner status slot. While that slot is still the placeholder phase `Refreshing`, the footer shows `copy.refreshing`. A numeric `progress` draws the footer bar. The frame clock treats a refresh like a running task, so patches still paint once per tick.

## Demo

Demo refresh does not call `run`. It calls `probe.demo` when that function exists. Otherwise it keeps the current values of the probe's keys, including facts a simulated task just applied.

## Checksums

A file or directory artifact is a presence probe: `present` or `missing`. A checksum artifact streams the archive. The sidecar must be a 64-hex digest and the recorded name must be the archive's basename. A missing sidecar stays `missing`. A present sidecar that fails the check is `mismatch`. A match is `verified`. Abort destroys the stream. Other read errors are a mismatch, not a failed probe.

HoldThis version, staple, file, and checksum observations are probes on this same pass. An invalid source plist fails only that probe. Without a source version, New Release explains how to repair and refresh it; sibling facts remain visible. A missing built plist is a successful `missing` fact.

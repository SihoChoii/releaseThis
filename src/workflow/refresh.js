// Workspace refresh. Probes in one wave share no fact keys and run together.
// A failed probe keeps the previous values of its keys. Checksum archives stream.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { prettyBytes } from '../tui/format.js';
import { factStore } from './model.js';

function yieldTurn() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export function abortError() {
  const error = new Error('Refresh cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbort(error, signal) {
  return !!signal?.aborted || error?.name === 'AbortError';
}

function declaredFacts(probe) {
  return Array.isArray(probe.facts) && probe.facts.length ? probe.facts : null;
}

export function probeWaves(probes) {
  const waves = [];
  let wave = [];
  let keys = new Set();
  const flush = () => {
    if (!wave.length) return;
    waves.push(wave);
    wave = [];
    keys = new Set();
  };
  for (const probe of probes) {
    const owned = declaredFacts(probe);
    if (!owned) {
      flush();
      waves.push([probe]);
      continue;
    }
    if (owned.some(key => keys.has(key))) flush();
    wave.push(probe);
    for (const key of owned) keys.add(key);
  }
  flush();
  return waves;
}

function cloneFact(fact) {
  return structuredClone(fact);
}

function cloneFactStore(facts) {
  return factStore((facts?.all?.() || []).map(cloneFact));
}

function trackingStore(base) {
  const inner = cloneFactStore(base);
  const touched = new Set();
  return {
    touched,
    facts: {
      get: key => inner.get(key),
      all: () => inner.all(),
      set(entry) {
        if (entry?.key) touched.add(entry.key);
        inner.set(entry);
      },
    },
    get: key => inner.get(key),
  };
}

function keysToMerge(probe, scratch, demo) {
  const declared = declaredFacts(probe);
  if (declared) return declared.filter(key => scratch.get(key));
  if (demo && typeof probe.demo !== 'function') return [];
  return [...scratch.touched];
}

async function runProbe(probe, live, ctx) {
  const scratch = trackingStore(live);
  const probeCtx = { root: ctx.root, facts: scratch.facts, status: ctx.status, signal: ctx.signal, demo: !!ctx.demo, env: ctx.env };
  try {
    if (ctx.signal?.aborted) return { aborted: true, id: probe.id };
    if (ctx.demo) {
      if (typeof probe.demo === 'function') await probe.demo(probeCtx);
    } else if (typeof probe.run === 'function') await probe.run(probeCtx);
    if (ctx.signal?.aborted) return { aborted: true, id: probe.id };
    return { ok: true, id: probe.id, keys: keysToMerge(probe, scratch, ctx.demo), scratch: scratch.facts };
  } catch (error) {
    if (isAbort(error, ctx.signal)) return { aborted: true, id: probe.id };
    return { ok: false, id: probe.id, error };
  }
}

export async function refreshFacts({ profile, root, facts, demo = false, status = () => {}, signal, env = process.env } = {}) {
  const seed = facts || (demo && typeof profile?.demoFacts === 'function' ? profile.demoFacts() : factStore());
  const live = cloneFactStore(seed);
  const failures = [];
  let cancelled = false;
  await yieldTurn();
  if (signal?.aborted) return { facts: live, failures, aborted: true };
  for (const wave of probeWaves(profile?.probes || [])) {
    if (signal?.aborted) { cancelled = true; break; }
    const results = await Promise.all(wave.map(probe => runProbe(probe, live, { root, demo, status, signal, env })));
    for (const result of results) {
      if (result.aborted) { cancelled = true; continue; }
      if (!result.ok) { failures.push({ id: result.id, error: result.error }); continue; }
      for (const key of result.keys) {
        const fact = result.scratch.get(key);
        if (fact) live.set(cloneFact(fact));
      }
    }
    if (cancelled) break;
  }
  return { facts: live, failures, aborted: cancelled || !!signal?.aborted };
}

export async function observeFile(root, desc) {
  const info = await stat(join(root, desc.path)).catch(() => null);
  const directory = desc.kind === 'dir';
  const exists = !!info && (directory ? info.isDirectory() : info.isFile());
  return {
    state: exists ? 'present' : 'missing',
    size: exists && !directory ? prettyBytes(info.size) : '',
    modifiedAt: exists ? info.mtimeMs : null,
  };
}

export function fileProbe(desc, createFact) {
  return {
    id: `file:${desc.key}`,
    facts: [desc.key],
    async run({ root, facts }) {
      const observed = await observeFile(root, desc);
      facts.set({ ...createFact(desc), ...observed, provenance: { source: 'probe', id: desc.key } });
    },
  };
}

// Boolean match. A missing archive, a bad sidecar, or a mismatched digest is false.
// Abort rejects; other IO failures do not.
function checksumRecord(text) {
  const line = String(text).trim().split(/\r?\n/, 1)[0] ?? '';
  const match = /^([a-fA-F\d]{64})\s+(.*)$/.exec(line);
  if (!match?.[2]) return null;
  return { digest: match[1], name: match[2] };
}

export async function verifyChecksum(archive, checksum, { status, signal, highWaterMark } = {}) {
  let stream;
  const onAbort = () => stream?.destroy(abortError());
  try {
    const recorded = checksumRecord(await readFile(checksum, 'utf8'));
    if (!recorded || recorded.name !== basename(archive)) return false;
    const info = await stat(archive);
    const hash = createHash('sha256');
    let read = 0;
    const total = info.size;
    if (signal?.aborted) throw abortError();
    stream = createReadStream(archive, highWaterMark ? { highWaterMark } : undefined);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError();
      hash.update(chunk);
      read += chunk.length;
      status?.({
        phase: 'Checksum',
        detail: basename(archive),
        progress: total ? Math.min(1, read / total) : 1,
        completed: read,
        total,
      });
    }
    if (signal?.aborted) throw abortError();
    return hash.digest('hex') === recorded.digest.toLowerCase();
  } catch (error) {
    if (isAbort(error, signal)) throw error?.name === 'AbortError' ? error : abortError();
    return false;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function checksumProbe(desc, archiveDesc, createFact) {
  const archive = archiveDesc?.path || '';
  return {
    id: `checksum:${desc.key}`,
    facts: [desc.key],
    async run({ root, facts, status, signal }) {
      const observed = await observeFile(root, desc);
      let state = 'missing';
      if (observed.state === 'present') {
        const matched = await verifyChecksum(join(root, archive), join(root, desc.path), { status, signal });
        state = matched ? 'verified' : 'mismatch';
      }
      facts.set({
        ...createFact(desc),
        state,
        size: observed.size,
        modifiedAt: observed.modifiedAt,
        provenance: { source: 'probe', id: desc.key },
      });
    },
  };
}

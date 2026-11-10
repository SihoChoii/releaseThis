import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/release/app.js';
import { render } from '../src/release/view.js';
import { checksumOK } from '../src/profiles/holdthis.js';
import { factStore } from '../src/workflow/model.js';
import { abortError, refreshFacts, verifyChecksum } from '../src/workflow/refresh.js';

let temp;
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'releasethis-refresh-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function shell(probes, extra = {}) {
  return {
    id: 'sample',
    problems: extra.problems || [],
    header: { subtitle: 'Sample' },
    commandLine: args => (args || []).join(' '),
    demoFacts: extra.demoFacts || (() => factStore()),
    copy: {
      refreshing: 'Reading workspace…',
      intro: 'Ready.',
      aligned: 'Aligned.',
      drifted: 'Drifted.',
      publishReady: 'Publish.',
      tip: 'Tip',
      demoIdle: 'Simulated',
      checked: 'R refreshes',
      files: 'Files',
      legend: 'Present',
      artifactHint: 'Enter',
      stepsIntro: 'Steps',
      stepsReady: 'Ready',
      stepsBlocked: 'Blocked',
    },
    artifacts: [],
    catalog: [],
    tasks: {},
    plans: {},
    actions: [],
    probes,
  };
}

describe('probe waves', () => {
  test('disjoint probes run together and overlapping probes wait', async () => {
    const gate = deferred();
    const inside = deferred();
    const order = [];
    let started = 0;
    const mark = () => { if (++started === 2) inside.release(); };
    const profile = shell([
      { id: 'a', facts: ['a'], async run() { order.push('a-start'); mark(); await gate.promise; order.push('a-end'); } },
      { id: 'c', facts: ['c'], async run() { order.push('c-start'); mark(); await gate.promise; order.push('c-end'); } },
      { id: 'b', facts: ['a'], async run() { order.push('b-start'); order.push('b-end'); } },
    ]);
    const pending = refreshFacts({ profile, root: temp, demo: false });
    await inside.promise;
    expect(order).toEqual(['a-start', 'c-start']);
    gate.release();
    await pending;
    expect(order).toEqual(['a-start', 'c-start', 'a-end', 'c-end', 'b-start', 'b-end']);
  });

  test('a declared probe cannot publish a key it does not own', async () => {
    const profile = shell([
      {
        id: 'a', facts: ['a'],
        async run({ facts }) {
          facts.set({ key: 'a', state: 'present' });
          facts.set({ key: 'b', state: 'hijack' });
        },
      },
      { id: 'b', facts: ['b'], async run({ facts }) { facts.set({ key: 'b', state: 'present' }); } },
    ]);
    const { facts } = await refreshFacts({ profile, root: temp, demo: false });
    expect(facts.get('a').state).toBe('present');
    expect(facts.get('b').state).toBe('present');
  });

  test('a failed probe leaves its previous fact and keeps a sibling', async () => {
    const facts = factStore([
      { key: 'keep', state: 'present', value: 'old' },
      { key: 'sibling', state: 'missing' },
    ]);
    const profile = shell([
      { id: 'ok', facts: ['sibling'], async run({ facts: store }) { store.set({ key: 'sibling', state: 'present', value: true }); } },
      {
        id: 'bad', facts: ['keep'],
        async run({ facts: store }) {
          store.set({ key: 'keep', state: 'present', value: 'wrong' });
          throw new Error('boom');
        },
      },
    ]);
    const result = await refreshFacts({ profile, root: temp, facts, demo: false });
    expect(result.facts.get('keep').value).toBe('old');
    expect(result.facts.get('sibling')).toMatchObject({ state: 'present', value: true });
    expect(result.failures.map(failure => failure.id)).toEqual(['bad']);
    const app = new App({ root: temp, demo: false, profile });
    app.facts = facts;
    await app.refresh();
    expect(app.notice).toContain('Probe "bad" failed: boom');
    expect(app.facts.get('keep').value).toBe('old');
    expect(render(app, 110, 34, { color: false }).join('\n')).toContain('boom');
  });
});

describe('interactive refresh', () => {
  test('a slow probe does not block tab or quit', async () => {
    const inside = deferred();
    const profile = shell([{
      id: 'slow',
      facts: ['slow'],
      run({ signal, facts }) {
        inside.release();
        return new Promise((resolve, reject) => {
          const cancel = () => reject(abortError());
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
          facts.set({ key: 'slow', state: 'present' });
        });
      },
    }]);
    let quit = false;
    const app = new App({ root: temp, demo: false, profile, onQuit: () => { quit = true; } });
    const pending = app.refresh();
    await inside.promise;
    app.key('', { name: 'tab' });
    expect(app.tab).toBe(1);
    expect(app.refreshing).toBe(true);
    expect(quit).toBe(false);
    app.key('q', { name: 'q' });
    expect(quit).toBe(true);
    await pending;
    expect(app.refreshing).toBe(false);
  });

  test('tab leaves the refresh running until the probe finishes', async () => {
    const gate = deferred();
    const inside = deferred();
    const profile = shell([{
      id: 'slow',
      facts: ['slow'],
      async run({ facts }) {
        inside.release();
        await gate.promise;
        facts.set({ key: 'slow', state: 'present' });
      },
    }]);
    const app = new App({ root: temp, demo: false, profile });
    const pending = app.refresh();
    await inside.promise;
    app.key('', { name: 'tab' });
    expect(app.tab).toBe(1);
    expect(app.refreshing).toBe(true);
    expect(app.facts?.get('slow')).toBeFalsy();
    gate.release();
    await pending;
    expect(app.tab).toBe(1);
    expect(app.facts.get('slow').state).toBe('present');
    expect(app.refreshing).toBe(false);
  });

  test('refresh does not start while a plan is running', async () => {
    let ran = false;
    const profile = shell([{ id: 'x', facts: ['a'], async run() { ran = true; } }]);
    const app = new App({ root: temp, demo: false, profile });
    app.runner.running = true;
    await app.refresh();
    expect(ran).toBe(false);
    expect(app.refreshing).toBe(false);
  });

  test('the footer shows checksum progress from the status slot', () => {
    const app = new App({ root: temp, demo: false, profile: shell([]) });
    app.refreshing = true;
    app.refreshStartedAt = Date.now() - 1500;
    app.runner.status({ phase: 'Refreshing', progress: null });
    expect(render(app, 110, 34, { color: false }).join('\n')).toContain('Reading workspace…');
    app.runner.status({ phase: 'Checksum', detail: 'app.tar', progress: 0.5, completed: 4, total: 8 });
    const frame = render(app, 110, 34, { color: false }).join('\n');
    expect(frame).toContain('Checksum');
    expect(frame).toContain('app.tar');
    expect(frame).toContain('50%');
    expect(frame).toContain('━');
    expect(frame).toContain('Ready');
  });
});

describe('streaming checksums', () => {
  test('progress advances across chunks and matches checksumOK', async () => {
    const archive = join(temp, 'app.tar');
    const bytes = Buffer.from('archive-bytes-that-span-many-small-chunks!!');
    await writeFile(archive, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const sha = join(temp, 'app.tar.sha256');
    await writeFile(sha, `${digest}  app.tar\n`);
    const progress = [];
    expect(await verifyChecksum(archive, sha, { highWaterMark: 4, status: patch => progress.push(patch.progress) })).toBe(true);
    expect(await checksumOK(archive, sha)).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[0]).toBeLessThan(progress.at(-1));
    expect(progress.at(-1)).toBe(1);
    await writeFile(sha, `${digest}  other.tar\n`);
    expect(await verifyChecksum(archive, sha)).toBe(false);
    expect(await checksumOK(archive, sha)).toBe(false);
  });

  test('abort stops the read', async () => {
    const archive = join(temp, 'app.tar');
    const bytes = Buffer.alloc(64, 7);
    await writeFile(archive, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const sha = join(temp, 'app.tar.sha256');
    await writeFile(sha, `${digest}  app.tar\n`);
    const controller = new AbortController();
    let updates = 0;
    const pending = verifyChecksum(archive, sha, {
      highWaterMark: 4,
      signal: controller.signal,
      status() { updates += 1; controller.abort(); },
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(updates).toBe(1);
  });
});

describe('demo probes', () => {
  test('demo refresh keeps the facts a task wrote', async () => {
    const profile = shell([{
      id: 'version.built',
      facts: ['version.built'],
      async run() { throw new Error('should not read the disk'); },
    }], {
      demoFacts: () => factStore([{ key: 'version.built', role: 'built-version', value: { version: '1.0.2', build: '3' }, state: 'present' }]),
    });
    const facts = factStore([{ key: 'version.built', role: 'built-version', value: { version: '1.0.3', build: '4' }, state: 'present' }]);
    const result = await refreshFacts({ profile, root: temp, facts, demo: true });
    expect(result.facts.get('version.built').value).toEqual({ version: '1.0.3', build: '4' });
    expect(result.failures).toEqual([]);
  });
});

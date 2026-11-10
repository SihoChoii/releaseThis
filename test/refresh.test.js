import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/release/app.js';
import { render } from '../src/release/view.js';
import { checksumOK, holdthis } from '../examples/holdthis/profile.js';
import { factStore, resolvePlan } from '../src/workflow/model.js';
import { abortError, refreshFacts, verifyChecksum } from '../src/workflow/refresh.js';

let temp;
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'releasethis-refresh-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function palette(app, query) {
  app.key('/', {});
  app.key(query, {});
  app.key('', { name: 'return' });
}

function holdthisWithEnv(env) {
  return {
    ...holdthis,
    probes: holdthis.probes.map(probe => ({ ...probe, run: ctx => probe.run({ ...ctx, env }) })),
  };
}

async function executable(name, source) {
  const file = join(temp, name);
  await writeFile(file, `#!${process.execPath}\n${source}`);
  await chmod(file, 0o755);
  return file;
}

async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for probe processes.')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
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
  test('abort preserves completed probes and discards a late result', async () => {
    const inside = deferred();
    const gate = deferred();
    const controller = new AbortController();
    const pending = refreshFacts({ signal: controller.signal, profile: shell([
      { id: 'fast', facts: ['fast'], run({ facts }) { facts.set({ key: 'fast', value: true }); } },
      {
        id: 'late', facts: ['late'],
        async run({ facts }) {
          inside.release();
          await gate.promise;
          facts.set({ key: 'late', value: true });
        },
      },
    ]) });
    await inside.promise;
    controller.abort();
    gate.release();
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.facts.get('fast')?.value).toBe(true);
    expect(result.facts.get('late')).toBeNull();
  });

  test('nested mutations by a failed probe cannot reach input facts or a sibling', async () => {
    const entry = {
      key: 'keep', value: { nested: { ok: true }, items: [{ count: 1 }] },
      provenance: { source: 'probe', details: { trusted: true } },
      explain: { present: ['original'] },
    };
    const seed = structuredClone(entry);
    const facts = factStore([entry]);
    const result = await refreshFacts({ facts, profile: shell([
      {
        id: 'bad', facts: ['keep'],
        run({ facts }) {
          const fact = facts.get('keep');
          fact.value.nested.ok = false;
          fact.value.items[0].count = 2;
          fact.provenance.details.trusted = false;
          fact.explain.present.push('wrong');
          throw new Error('boom');
        },
      },
      {
        id: 'sibling', facts: ['observed'],
        run({ facts }) { facts.set({ key: 'observed', value: facts.get('keep') }); },
      },
    ]) });
    expect(result.failures.map(failure => failure.id)).toEqual(['bad']);
    expect(facts.get('keep')).toEqual(seed);
    expect(result.facts.get('keep')).toEqual(seed);
    expect(result.facts.get('observed').value).toEqual(seed);
  });

  test('successful probes can only publish owned nested updates', async () => {
    const facts = factStore([
      { key: 'owned', value: { items: [{ count: 1 }] } },
      { key: 'other', value: { items: [{ count: 1 }] } },
    ]);
    const result = await refreshFacts({ facts, profile: shell([{
      id: 'update', facts: ['owned'],
      run({ facts }) {
        facts.get('owned').value.items[0].count = 2;
        facts.get('other').value.items[0].count = 99;
      },
    }]) });
    expect(result.facts.get('owned').value.items[0].count).toBe(2);
    expect(result.facts.get('other').value.items[0].count).toBe(1);
    expect(facts.get('owned').value.items[0].count).toBe(1);
    expect(facts.get('other').value.items[0].count).toBe(1);
  });

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
  test('palette execution, retries, and previously opened confirmations wait for refresh', async () => {
    const gate = deferred();
    const inside = deferred();
    const app = new App({ root: temp, profile: {
      ...holdthis,
      plans: { ...holdthis.plans, check: {
        id: 'check', kind: 'run', resolve: () => [], review: () => ({ title: 'Check', lines: [], accept: 'Run' }),
      } },
      actions: [...holdthis.actions, { id: 'check', home: true, plan: 'check', palette: 'Check workspace', label: 'Check' }],
      probes: [{ id: 'slow', facts: ['slow'], async run() { inside.release(); await gate.promise; } }],
    } });
    app.facts = holdthis.demoFacts();
    app.selectStep();
    const priorConfirmation = app.modal.callback;
    app.modal = null;
    const pending = app.refresh();
    await inside.promise;
    try {
      for (const query of ['Step: Build app', 'New release', 'Publish release', 'Check workspace', 'Resume interrupted task']) {
        palette(app, query);
        expect(app.modal).toBeNull();
        expect(app.notice).toContain('refresh');
        expect(app.runner.running).toBe(false);
      }
      app.runner.result = 'paused';
      palette(app, 'Continue paused plan');
      expect(app.modal).toBeNull();
      expect(app.notice).toContain('refresh');
      await priorConfirmation();
      expect(app.runner.jobs).toEqual([]);
      expect(app.runner.running).toBe(false);
      palette(app, 'Show artifacts');
      expect(app.tab).toBe(1);
    } finally {
      gate.release();
      await pending;
    }
    palette(app, 'Step: Build app');
    expect(app.modal.type).toBe('confirm');
  });

  test('a form opened before refresh cannot be submitted while probes run', async () => {
    const gate = deferred();
    const inside = deferred();
    const app = new App({ root: temp, profile: {
      ...holdthis,
      probes: [{ id: 'slow', facts: ['slow'], async run() { inside.release(); await gate.promise; } }],
    } });
    app.facts = holdthis.demoFacts();
    app.newRelease();
    const pending = app.refresh();
    await inside.promise;
    try {
      app.reviewRelease();
      expect(app.modal.type).toBe('release');
      expect(app.notice).toContain('refresh');
      expect(app.runner.running).toBe(false);
    } finally { gate.release(); await pending; }
  });

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

describe('HoldThis partial refresh', () => {
  test.each(['missing', 'invalid'])('%s source data blocks the form and recovers after repair', async state => {
    const buddy = await executable('plist-buddy', `
import { readFileSync } from 'node:fs';
const value = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
console.log(process.argv[3].endsWith('CFBundleVersion') ? value.build : value.version);
`);
    await mkdir(join(temp, 'Resources'));
    if (state === 'invalid') await writeFile(join(temp, 'Resources/Info.plist'), JSON.stringify({ version: 'invalid', build: '4' }));
    const app = new App({ root: temp, profile: holdthisWithEnv({ ...process.env, HOLDTHIS_PLIST_BUDDY: buddy }) });
    await app.refresh();
    expect(app.notice).toContain('Probe "version.source" failed');
    expect(app.facts.get('artifact.app.built').state).toBe('missing');
    expect(() => app.key('1', { name: '1' })).not.toThrow();
    expect(app.modal).toBeNull();
    expect(app.notice).toContain('Source version');
    palette(app, 'New release');
    expect(app.modal).toBeNull();
    expect(app.notice).toContain('Source version');
    expect(() => resolvePlan(holdthis.plans.release, app.context({ version: '1.2.3', build: '4' }))).toThrow('Source version');
    expect(render(app, 110, 34, { color: false }).join('\n')).toContain('Source version');
    expect(app.runner.running).toBe(false);
    await writeFile(join(temp, 'Resources/Info.plist'), JSON.stringify({ version: '1.2.3', build: '4' }));
    await app.refresh();
    expect(app.notice).toBe('');
    app.key('1', { name: '1' });
    expect(app.modal).toMatchObject({ type: 'release', version: '1.2.3', build: '4' });
    app.key('', { name: 'escape' });
    palette(app, 'New release');
    expect(app.modal.type).toBe('release');
  });
});

describe('HoldThis subprocess cancellation', () => {
  for (const quit of ['q', 'ctrl+c', 'SIGINT', 'SIGTERM']) {
    test(`${quit} stops plist and stapler children and exits the runtime`, async () => {
      const pidsDir = join(temp, 'pids');
      await mkdir(pidsDir);
      await mkdir(join(temp, 'dist/release/HoldThis.app'), { recursive: true });
      const helper = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.PROBE_PID_DIR, process.pid + '.pid'), String(process.pid));
setInterval(() => {}, 1000);
`;
      const buddy = await executable('plist-buddy', helper);
      await executable('xcrun', helper);
      const runtime = join(temp, 'cockpit.js');
      await writeFile(runtime, `
import { App } from ${JSON.stringify(new URL('../src/release/app.js', import.meta.url).href)};
import { holdthis } from ${JSON.stringify(new URL('../examples/holdthis/profile.js', import.meta.url).href)};
import { runCockpit } from ${JSON.stringify(new URL('../src/tui/runtime.js', import.meta.url).href)};
process.stdin.setRawMode = () => {};
await runCockpit({
  createApp: callbacks => new App({ root: process.cwd(), profile: holdthis, ...callbacks }),
  render: () => ['Workspace'],
});
`);
      const proc = Bun.spawn([process.execPath, runtime], {
        cwd: temp,
        env: { ...process.env, HOLDTHIS_PLIST_BUDDY: buddy, PATH: `${temp}:${process.env.PATH}`, PROBE_PID_DIR: pidsDir },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      try {
        const deadline = Date.now() + 3000;
        while ((await readdir(pidsDir)).length < 5) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting for all five probe processes to start.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (quit === 'q' || quit === 'ctrl+c') proc.stdin.write(quit === 'q' ? 'q' : '\x03');
        else proc.kill(quit);
        expect(await within(proc.exited, 2000)).toBe(quit.startsWith('SIG') ? 130 : 0);
        expect(await new Response(proc.stderr).text()).toBe('');
        const pids = await Promise.all((await readdir(pidsDir)).map(async file => Number(await readFile(join(pidsDir, file), 'utf8'))));
        expect(pids).toHaveLength(5);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
        for (const file of await readdir(pidsDir)) {
          const pid = Number(await readFile(join(pidsDir, file), 'utf8'));
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }
    }, 10000);
  }
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

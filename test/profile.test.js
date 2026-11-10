import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/release/app.js';
import { holdthis } from '../src/profiles/holdthis.js';
import { render } from '../src/release/view.js';
import { requirement, resolvePlan } from '../src/workflow/model.js';
import { loadProfile, profileForDirectory } from '../src/workflow/load.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const key = name => ({ name });

const stepsProfile = `export default {
  id: 'sample',
  header: { subtitle: 'Sample' },
  artifacts: [
    { key: 'artifact.tested', label: 'Test log', path: 'out/test.txt' },
    { key: 'artifact.archive', label: 'Archive', path: 'out/app.tar' },
    { key: 'artifact.archive.sha256', label: 'Checksum', path: 'out/app.tar.sha256', kind: 'checksum', archive: 'artifact.archive' },
  ],
  tasks: [
    { id: 'test', label: 'Test', detail: 'Run tests', argv: ['./release.sh', 'test'], produces: ['artifact.tested'], demo: [{ text: 'tests passed', status: { phase: 'Test' } }] },
    { id: 'pack', label: 'Pack', detail: 'Build the archive', argv: ['./release.sh', 'pack'], requires: [{ fact: 'artifact.tested', message: 'Test first.' }], produces: ['artifact.archive'], demo: [{ text: 'packed', status: { phase: 'Pack' } }] },
    { id: 'checksum', label: 'Checksum', detail: 'Write the checksum', argv: ['./release.sh', 'checksum'], requires: [{ fact: 'artifact.archive', message: 'Pack first.' }], produces: ['artifact.archive.sha256'], demo: [{ text: 'hashed', status: { phase: 'Checksum' } }] },
  ],
  plans: [
    { id: 'release', kind: 'run', title: 'Release', steps: ['test', 'pack', 'checksum'] },
  ],
  actions: [
    { id: 'release', home: true, plan: 'release', bindings: [{ key: '1' }], label: 'Release', detail: 'Run test, pack, and checksum.' },
  ],
};
`;

let temp;
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'releasethis-profile-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

async function writeProfile(source) {
  await writeFile(join(temp, 'releasethis.config.js'), source);
  return loadProfile(temp);
}

async function writeScript(name) {
  const path = join(temp, name);
  await writeFile(path, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> invocations.txt\n');
  await chmod(path, 0o755);
}

function screen(app) {
  return render(app, 110, 34, { color: false }).join('\n');
}

async function loadedApp(spec, { demo = true } = {}) {
  const loaded = await writeProfile(typeof spec === 'string' ? spec : `export default ${JSON.stringify(spec)};`);
  expect(loaded.ok).toBe(true);
  const a = new App({ root: temp, demo, profile: loaded.profile });
  a.runner.demoPace = 0;
  await a.refresh();
  return a;
}

async function accept(a) {
  expect(a.modal?.type).toBe('confirm');
  expect(a.modal.choice).toBe(0);
  const callback = a.modal.callback;
  a.modal = null;
  return callback();
}

const commandTask = id => ({ id, label: id, argv: ['./release.sh', id], catalog: false });
const gate = title => ({ title, lines: [title], accept: 'Continue', danger: true });
const gatedPlan = id => ({
  id, kind: 'gated', resume: 'revalidate', confirmStart: gate(`Validate ${id}`),
  steps: [
    { task: `${id}-check`, after: 'pause', pauseNotice: `Read ${id}'s validation.` },
    { task: `${id}-upload`, confirm: gate(`Upload ${id}`) },
  ],
});

describe('plan gates', () => {
  for (const kind of ['run', 'form']) {
    test(`${kind} keeps confirmations and pauses through every recorded step`, async () => {
      await writeScript('release.sh');
      const a = await loadedApp({
        tasks: ['validate', 'upload', 'verify', 'finish'].map(commandTask),
        plans: [{
          id: 'release', kind, title: 'Release',
          fields: [{ name: 'build', type: 'integer' }], presets: [{ values: { build: '7' } }],
          steps: [
            { task: 'validate', after: 'pause', pauseNotice: 'Read validation.' },
            { task: 'upload', confirm: gate('Upload') },
            { task: 'verify', confirm: gate('Verify'), after: 'pause' },
            'finish',
          ],
        }],
      }, { demo: false });
      const plan = a.profile.plans.release;
      if (kind === 'form') { a.openForm(plan); a.reviewRelease(); }
      else a.openRun(plan);
      await accept(a);
      expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('validate\n');
      expect(a.runner.result).toBe('paused');
      expect(a.modal).toBeNull();
      expect(a.notice).toBe('Read validation.');
      expect(screen(a)).toContain('Task paused');
      expect(a.runner.session.tasks.map(job => job.status)).toEqual(['done', 'pending', 'pending', 'pending']);

      a.retry();
      expect(a.modal.title).toBe('Upload');
      expect(a.modal.danger).toBe(true);
      a.key('', key('escape'));
      expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('validate\n');
      a.retry();
      await accept(a);
      expect(a.modal.title).toBe('Verify');
      expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('validate\nupload\n');
      await accept(a);
      expect(a.runner.result).toBe('paused');
      expect(a.modal).toBeNull();
      expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('validate\nupload\nverify\n');
      await a.retry();
      expect(a.runner.result).toBe('done');
      expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('validate\nupload\nverify\nfinish\n');
      expect(a.runner.session.tasks.map(job => job.status)).toEqual(['done', 'done', 'done', 'done']);
      expect(a.runner.session.params).toEqual(kind === 'form' ? { build: '7' } : {});
    });
  }

  test('a gated plan executes its third step before reporting success', async () => {
    await writeScript('release.sh');
    const plan = gatedPlan('release');
    plan.steps.push({ task: 'verify', confirm: gate('Verify') });
    const a = await loadedApp({ tasks: ['release-check', 'release-upload', 'verify'].map(commandTask), plans: [plan] }, { demo: false });
    a.openGated(a.profile.plans.release);
    await accept(a);
    expect(a.modal).toBeNull();
    a.openGated(a.profile.plans.release);
    await accept(a);
    expect(a.runner.result).toBe('paused');
    expect(a.modal.title).toBe('Verify');
    await accept(a);
    expect(a.runner.result).toBe('done');
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('release-check\nrelease-upload\nverify\n');
    expect(a.runner.jobs.map(job => job.status)).toEqual(['done', 'done', 'done']);
  });

  test('a confirmation on the first step is also enforced', async () => {
    await writeScript('release.sh');
    const a = await loadedApp({ tasks: [commandTask('upload')], plans: [{ id: 'release', kind: 'run', steps: [{ task: 'upload', confirm: gate('Upload') }] }] }, { demo: false });
    a.openRun(a.profile.plans.release);
    await accept(a);
    expect(a.modal.title).toBe('Upload');
    expect(await Bun.file(join(temp, 'invocations.txt')).exists()).toBe(false);
    await accept(a);
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('upload\n');
  });

  test('repeated task IDs each retain their own confirmation', async () => {
    const a = await loadedApp({ tasks: [commandTask('check')], plans: [{ id: 'release', kind: 'run', steps: [{ task: 'check', confirm: gate('First') }, { task: 'check', confirm: gate('Second') }] }] });
    a.openRun(a.profile.plans.release);
    await accept(a);
    expect(a.modal.title).toBe('First');
    await accept(a);
    expect(a.modal.title).toBe('Second');
    expect(a.runner.jobs.map(job => job.status)).toEqual(['done', 'pending']);
    await accept(a);
    expect(a.runner.result).toBe('done');
  });

  test('validation belongs to its plan and reopening the same plan continues it', async () => {
    const a = await loadedApp({ tasks: ['a-check', 'a-upload', 'b-check', 'b-upload'].map(commandTask), plans: [gatedPlan('a'), gatedPlan('b')] });
    a.openGated(a.profile.plans.a);
    await accept(a);
    a.openGated(a.profile.plans.a);
    expect(a.modal.title).toBe('Upload a');
    a.key('', key('escape'));
    a.openGated(a.profile.plans.b);
    expect(a.modal.title).toBe('Validate b');
    await accept(a);
    expect(a.runner.jobs.map(job => job.status)).toEqual(['done', 'pending']);
    expect(a.runner.jobs[0].id).toBe('b-check');
    expect(a.runner.session.planId).toBe('b');
    a.openGated(a.profile.plans.b);
    expect(a.modal.title).toBe('Upload b');
  });

  for (const invalidation of ['refresh', 'mode']) {
    test(`${invalidation} requires validation again even when the original mode is restored`, async () => {
      const a = await loadedApp({ tasks: ['release-check', 'release-upload'].map(commandTask), plans: [gatedPlan('release')] });
      a.openGated(a.profile.plans.release);
      await accept(a);
      if (invalidation === 'refresh') await a.refresh();
      else { a.toggleMode(); a.toggleMode(); }
      a.openGated(a.profile.plans.release);
      expect(a.modal.title).toBe('Validate release');
    });
  }

  test('retry revalidates the selected gated plan after failure', async () => {
    await writeFile(join(temp, 'release.sh'), '#!/bin/sh\nprintf "%s\\n" "$1" >> invocations.txt\nif [ "$1" = b-upload ]; then exit 7; fi\n');
    await chmod(join(temp, 'release.sh'), 0o755);
    const a = await loadedApp({ tasks: ['a-check', 'a-upload', 'b-check', 'b-upload'].map(commandTask), plans: [gatedPlan('a'), gatedPlan('b')] }, { demo: false });
    a.openGated(a.profile.plans.b);
    await accept(a);
    a.openGated(a.profile.plans.b);
    await accept(a);
    expect(a.runner.result).toBe('failed');
    a.retry();
    expect(a.modal.title).toBe('Validate b');
    await accept(a);
    expect(a.runner.jobs[0].id).toBe('b-check');
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('b-check\nb-upload\nb-check\n');
  });

  test('retrying a failed run task preserves gates and completed tasks', async () => {
    await writeFile(join(temp, 'release.sh'), '#!/bin/sh\nprintf "%s\\n" "$1" >> invocations.txt\nif [ "$1" = upload ] && [ ! -f attempted ]; then touch attempted; exit 7; fi\n');
    await chmod(join(temp, 'release.sh'), 0o755);
    const a = await loadedApp({ tasks: ['check', 'upload'].map(commandTask), plans: [{ id: 'release', kind: 'run', steps: ['check', { task: 'upload', confirm: gate('Upload') }] }] }, { demo: false });
    a.openRun(a.profile.plans.release);
    await accept(a);
    await accept(a);
    expect(a.runner.result).toBe('failed');
    a.retry();
    expect(a.modal.title).toBe('Resume interrupted task');
    await accept(a);
    expect(a.modal.title).toBe('Upload');
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('check\nupload\n');
    await accept(a);
    expect(a.runner.result).toBe('done');
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('check\nupload\nupload\n');
  });
});

describe('profile form validation', () => {
  for (const label of [123, {}, [], false]) {
    test(`invalid label ${JSON.stringify(label)} produces a usable error cockpit`, async () => {
      const loaded = await writeProfile(`export default ${JSON.stringify({ tasks: [commandTask('work')], plans: [{ id: 'release', kind: 'form', steps: ['work'], fields: [{ name: 'build', type: 'integer', label }] }] })}`);
      expect(loaded.ok).toBe(false);
      expect(loaded.problems.join(' ')).toContain('Plan "release" field "build" label must be text.');
      let quit = false;
      const a = new App({ root: temp, demo: true, profile: loaded.profile, onQuit: () => { quit = true; } });
      await a.refresh();
      expect(screen(a)).toContain('label must be text');
      a.key('', key('tab'));
      a.key('?', key('?'));
      expect(screen(a)).toContain('Keyboard controls');
      a.key('', key('escape'));
      a.key('q');
      expect(quit).toBe(true);
    });
  }

  test('field types run before custom cross-field validation and errors stay on the form', async () => {
    const a = await loadedApp(`export default {
      tasks: [{ id: 'pack', label: 'Pack', argv: ['./release.sh', '{version}', '{build}'] }],
      plans: [{ id: 'release', kind: 'form', steps: ['pack'],
        fields: [{ name: 'version', type: 'semver' }, { name: 'build', type: 'integer' }],
        presets: [{ values: { version: '1.2.3', build: '10' } }],
        validate: ({params}) => BigInt(params.build) < 10n ? 'Build must be at least 10.' : '',
      }],
    };`);
    const plan = a.profile.plans.release;
    expect(() => resolvePlan(plan, a.context({ version: 'bad', build: '10' }))).toThrow(/major.minor.patch/);
    expect(() => resolvePlan(plan, a.context({ version: '1.2.3', build: '0' }))).toThrow(/positive integer/);
    expect(() => resolvePlan(plan, a.context({ version: '1.2.3', build: 'bad' }))).toThrow(/positive integer/);
    expect(() => resolvePlan(plan, a.context({ version: '1.2.3', build: '9' }))).toThrow('Build must be at least 10.');
    expect(resolvePlan(plan, a.context({ version: '1.2.3', build: '10' }))[0].command).toEqual(['./release.sh', '1.2.3', '10']);
    a.openForm(plan);
    a.modal.build = '0';
    a.reviewRelease();
    expect(a.modal.type).toBe('release');
    expect(a.modal.build).toBe('0');
    expect(a.modal.error).toContain('positive integer');
    a.modal.build = '9';
    a.reviewRelease();
    expect(a.modal.error).toBe('Build must be at least 10.');
  });

  test('missing single-step parameters and unknown placeholders never reach execution', async () => {
    const a = await loadedApp({
      tasks: [{ id: 'pack', label: 'Pack', argv: ['./release.sh', '{version}'] }, { id: 'typo', label: 'Typo', argv: ['./release.sh', '{verison}'] }],
      plans: [{ id: 'release', kind: 'form', steps: ['pack'], fields: [{ name: 'version', type: 'semver' }], presets: [{ values: { version: '1.2.3' } }] }, { id: 'typo', kind: 'run', steps: ['typo'] }],
    });
    a.selectStep();
    expect(a.modal).toBeNull();
    expect(a.notice).toContain('Missing parameter "version"');
    a.commands().find(command => command.label === 'Step: Pack').run();
    expect(a.modal).toBeNull();
    expect(a.runner.jobs).toEqual([]);
    expect(() => resolvePlan(a.profile.plans.typo, a.context({ version: '1.2.3' }))).toThrow('Missing parameter "verison"');
    expect(await Bun.file(join(temp, 'invocations.txt')).exists()).toBe(false);
    a.openForm(a.profile.plans.release);
    a.reviewRelease();
    expect(a.modal.lines.join(' ')).toContain('./release.sh 1.2.3');
    await accept(a);
    expect(a.runner.jobs[0].command).toEqual(['./release.sh', '1.2.3']);
  });

  test('all-skipped form plans stay usable and partially skipped plans still run', async () => {
    const a = await loadedApp({
      tasks: [{ ...commandTask('work'), skip: { when: 'signed-only' } }, commandTask('finish')],
      plans: ['empty', 'partial'].map(id => ({ id, kind: 'form', steps: id === 'empty' ? ['work'] : ['work', 'finish'], fields: [{ name: 'build', type: 'integer' }], presets: [{ values: { build: '1' } }] })),
    });
    a.signedOnly = true;
    a.openForm(a.profile.plans.empty);
    a.reviewRelease();
    expect(a.modal.type).toBe('release');
    expect(a.modal.error).toBe('Nothing to run.');
    expect(a.runner.jobs).toEqual([]);
    await a.start([]);
    expect(a.runner.running).toBe(false);
    a.key('', key('escape'));
    a.openForm(a.profile.plans.partial);
    a.reviewRelease();
    await accept(a);
    expect(a.runner.jobs.map(job => job.id)).toEqual(['finish']);
    expect(a.runner.result).toBe('done');
  });
});

describe('declarative profile', () => {
  test('three steps run under demo and record produced facts', async () => {
    const loaded = await writeProfile(stepsProfile);
    expect(loaded.ok).toBe(true);
    const a = new App({ root: temp, demo: true, profile: loaded.profile });
    await a.refresh();
    expect(requirement(a.profile.tasks.pack, a.context())).toBe('Test first.');
    a.runner.demoPace = 0;
    a.key('1', key('1'));
    expect(a.modal?.lines.join('\n')).toContain('./release.sh test');
    a.modal.choice = 1;
    a.key('', key('return'));
    while (a.runner.running) await Bun.sleep(0);
    expect(a.runner.result).toBe('done');
    const scripted = a.runner.logs.map(line => line.text).filter(text => ['tests passed', 'packed', 'hashed'].includes(text));
    expect(scripted).toEqual(['tests passed', 'packed', 'hashed']);
    expect(a.facts.get('artifact.tested')).toMatchObject({ state: 'present', provenance: { source: 'task', id: 'test' } });
    expect(a.facts.get('artifact.archive').state).toBe('present');
    expect(a.facts.get('artifact.archive.sha256')).toMatchObject({ state: 'present', kind: 'checksum' });
    expect(requirement(a.profile.tasks.pack, a.context())).toBe('');
    expect(screen(a)).toContain('Sample');
    expect(screen(a)).not.toContain('Build app');
  });

  test('three steps run against a temporary script', async () => {
    await writeScript('release.sh');
    await mkdir(join(temp, 'out'), { recursive: true });
    await writeFile(join(temp, 'out/app.tar.sha256'), 'not a hash\n');
    const loaded = await writeProfile(stepsProfile);
    const a = new App({ root: temp, demo: false, profile: loaded.profile });
    await a.refresh();
    expect(a.facts.get('artifact.archive.sha256')).toMatchObject({ state: 'mismatch', kind: 'checksum' });
    expect(a.facts.get('artifact.archive').state).toBe('missing');
    const jobs = resolvePlan(a.profile.plans.release, a.context());
    expect(jobs.map(job => job.command)).toEqual([
      ['./release.sh', 'test'],
      ['./release.sh', 'pack'],
      ['./release.sh', 'checksum'],
    ]);
    await a.start(jobs);
    expect(a.runner.result).toBe('done');
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('test\npack\nchecksum\n');
    expect(a.facts.get('artifact.archive.sha256').state).toBe('mismatch');
  });

  test('a form plan checks field types and fills argv from parameters', async () => {
    const loaded = await writeProfile(`export default {
      id: 'sample',
      tasks: [{ id: 'pack', label: 'Pack', detail: 'Pack', argv: ['./release.sh', '{version}'], demo: [{ text: 'packed' }] }],
      plans: [{
        id: 'release', kind: 'form', title: 'Release', steps: ['pack'],
        fields: [{ name: 'version', type: 'semver', label: 'Version' }],
        presets: [{ name: 'Current', opening: true, values: { version: '1.2.3' } }],
      }],
      actions: [{ id: 'release', home: true, plan: 'release', bindings: [{ key: '1' }], label: 'Release', detail: 'Pack' }],
    };`);
    expect(loaded.ok).toBe(true);
    const a = new App({ root: temp, demo: true, profile: loaded.profile });
    await a.refresh();
    expect(() => resolvePlan(a.profile.plans.release, a.context({ version: 'nope' }))).toThrow(/major\.minor\.patch/);
    expect(resolvePlan(a.profile.plans.release, a.context({ version: '1.2.3' }))[0].command).toEqual(['./release.sh', '1.2.3']);
  });

  test('a gated plan keeps the pause and the confirm', async () => {
    const loaded = await writeProfile(`export default {
      id: 'sample',
      tasks: [
        { id: 'preflight', label: 'Validate', detail: 'Check', argv: ['./release.sh', 'preflight'], catalog: false },
        { id: 'upload', label: 'Upload', detail: 'Upload', argv: ['./release.sh', 'upload'], catalog: false },
      ],
      plans: [{
        id: 'publish', kind: 'gated', title: 'Publish', resume: 'revalidate',
        confirmStart: { title: 'Validate', lines: ['Dry run'], accept: 'Validate' },
        steps: [
          { task: 'preflight', after: 'pause', pauseNotice: 'Read the log, then continue.' },
          { task: 'upload', confirm: { title: 'Upload', danger: true, lines: ['Uploads.'], accept: 'Upload' } },
        ],
      }],
      actions: [{ id: 'publish', home: true, plan: 'publish', bindings: [{ key: '2' }], label: 'Publish', detail: 'Upload' }],
    };`);
    expect(loaded.ok).toBe(true);
    const plan = loaded.profile.plans.publish;
    expect(plan.steps[0]).toMatchObject({ taskId: 'preflight', after: 'pause', pauseNotice: 'Read the log, then continue.' });
    expect(plan.steps[1].confirm({}).danger).toBe(true);
    expect(plan.resume).toBe('revalidate');
    expect(loaded.profile.catalog).toEqual([]);
    const a = new App({ root: temp, demo: true, profile: loaded.profile });
    await a.refresh();
    a.key('2', key('2'));
    expect(a.modal.title).toBe('Validate');
    expect(a.modal.lines).toContain('Dry run');
  });
});

describe('code profile', () => {
  test('a code probe sets a fact a file stat cannot express, then its task runs', async () => {
    await writeFile(join(temp, 'NOTE'), 'READY\n');
    await writeScript('run.sh');
    await writeProfile(`import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export default function register(host) {
  host.artifact({ key: 'note.file', label: 'Note', path: 'NOTE' });
  host.probe({
    id: 'note',
    async run({ root, facts }) {
      const text = await readFile(join(root, 'NOTE'), 'utf8').catch(() => '');
      const ready = text.startsWith('READY');
      facts.set({
        key: 'note.ready', role: 'check', value: ready, state: ready ? 'present' : 'missing',
        whenTrue: 'Note starts with READY', whenFalse: 'Note is not READY',
        provenance: { source: 'probe', id: 'note' },
      });
    },
  });
  host.task({ id: 'check', label: 'Check note', detail: 'Confirm the note', argv: ['./run.sh', 'check'] });
  host.plan({ id: 'release', kind: 'run', title: 'Check', steps: ['check'] });
  host.action({ id: 'release', home: true, plan: 'release', bindings: [{ key: '1' }], label: 'Check', detail: 'Run the check' });
}
`);
    const loaded = await loadProfile(temp);
    expect(loaded.ok).toBe(true);
    const a = new App({ root: temp, demo: false, profile: loaded.profile });
    await a.refresh();
    expect(a.facts.get('note.file').state).toBe('present');
    expect(a.facts.get('note.ready')).toMatchObject({ value: true, provenance: { source: 'probe', id: 'note' } });
    expect(screen(a)).toContain('Note starts with READY');
    await a.start(resolvePlan(a.profile.plans.release, a.context()));
    expect(a.runner.result).toBe('done');
    expect(await readFile(join(temp, 'invocations.txt'), 'utf8')).toBe('check\n');
  });
});

describe('missing and invalid profiles', () => {
  test('a directory with no profile does not show the HoldThis pipeline', async () => {
    const loaded = await loadProfile(temp);
    expect(loaded.found).toBe(false);
    expect(loaded.profile.catalog).toEqual([]);
    let quit = false;
    const a = new App({ root: temp, demo: true, profile: loaded.profile, onQuit: () => { quit = true; } });
    await a.refresh();
    const frame = screen(a);
    expect(frame).toContain('releasethis.config.js');
    expect(frame).not.toContain('Build app');
    expect(frame).not.toContain('Notarize app');
    a.key('', key('down'));
    a.key('', key('return'));
    expect(a.selection).toBe(0);
    expect(Number.isNaN(a.selection)).toBe(false);
    a.key('', key('tab'));
    expect(a.tab).toBe(1);
    expect(screen(a)).toContain('releasethis.config.js');
    a.key('q', key('q'));
    a.key('?', key('?'));
    expect(quit).toBe(true);
  });

  test('a duplicate task id stays on screen', async () => {
    const loaded = await writeProfile(`export default {
      id: 'sample',
      tasks: [
        { id: 'pack', label: 'Pack', detail: 'First', argv: ['./release.sh', 'pack'] },
        { id: 'pack', label: 'Pack again', detail: 'Second', argv: ['./release.sh', 'pack'] },
      ],
      plans: [{ id: 'release', kind: 'run', title: 'Release', steps: ['pack'] }],
      actions: [{ id: 'release', home: true, plan: 'release', bindings: [{ key: '1' }], label: 'Release', detail: 'Pack' }],
    };`);
    expect(loaded.ok).toBe(false);
    expect(loaded.profile.catalog).toEqual([]);
    const a = new App({ root: temp, demo: true, profile: loaded.profile });
    await a.refresh();
    const frame = screen(a);
    expect(frame).toContain('pack');
    expect(frame).toContain('declared more than once');
  });

  test('a path that leaves the repo is rejected', async () => {
    const loaded = await writeProfile(`export default {
      id: 'sample',
      artifacts: [{ key: 'artifact.archive', label: 'Archive', path: '../secret.tar' }],
      tasks: [{ id: 'pack', label: 'Pack', detail: 'Pack', argv: ['./release.sh', 'pack'] }],
      plans: [{ id: 'release', kind: 'run', title: 'Release', steps: ['pack'] }],
    };`);
    expect(loaded.ok).toBe(false);
    expect(loaded.problems.join('\n')).toContain('Artifact "artifact.archive" path must stay inside the repo.');
  });

  test('a reserved binding is rejected', async () => {
    const loaded = await writeProfile(`export default {
      id: 'sample',
      tasks: [{ id: 'pack', label: 'Pack', detail: 'Pack', argv: ['./release.sh', 'pack'] }],
      plans: [{ id: 'release', kind: 'run', title: 'Release', steps: ['pack'] }],
      actions: [{ id: 'quit', bindings: [{ key: 'q' }], label: 'Quit', detail: 'No' }],
    };`);
    expect(loaded.ok).toBe(false);
    expect(loaded.problems.join('\n')).toContain('Command binding "q" is reserved or duplicated.');
  });

  test('an unknown field type names the field', async () => {
    const loaded = await writeProfile(`export default {
      id: 'sample',
      tasks: [{ id: 'pack', label: 'Pack', detail: 'Pack', argv: ['./release.sh', 'pack'] }],
      plans: [{
        id: 'release', kind: 'form', title: 'Release', steps: ['pack'],
        fields: [{ name: 'channel', type: 'choice', label: 'Channel' }],
      }],
    };`);
    expect(loaded.problems.join('\n')).toContain('field "channel" has unknown type "choice"');
  });

  test('HoldThis is the fallback only for this package root', async () => {
    const fallback = { id: 'fallback' };
    expect(await profileForDirectory(temp, { packageRoot: temp, fallback })).toBe(fallback);
    expect((await profileForDirectory(temp, { packageRoot, fallback })).id).toBe('empty');
    await writeProfile(stepsProfile);
    expect((await profileForDirectory(temp, { packageRoot: temp, fallback })).id).toBe('sample');
  });

  test('a snapshot of this package still shows the HoldThis header', async () => {
    const proc = Bun.spawn(['bun', 'bin/cli.js', '--demo', '--snapshot'], {
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    expect(stdout).toContain('Apple Silicon');
    expect(stdout).toContain('Build app');
  });
});

const libraryExample = join(packageRoot, 'examples/library');
const publishBlocked = 'Pack the archive and verify its checksum first.';

async function copyLibrary() {
  await cp(libraryExample, temp, { recursive: true, filter: source => source !== join(libraryExample, 'out') });
  return loadProfile(temp);
}

async function libraryApp({ demo }) {
  const loaded = await copyLibrary();
  expect(loaded.ok).toBe(true);
  const a = new App({ root: temp, demo, profile: loaded.profile });
  a.runner.demoPace = 0;
  await a.refresh();
  return a;
}

describe('library workflow', () => {
  test('loads with its own tasks and no mode chip', async () => {
    const loaded = await loadProfile(libraryExample);
    expect(loaded.ok).toBe(true);
    expect(loaded.profile.id).toBe('library');
    expect(loaded.profile.mode).toBeUndefined();
    expect(Object.keys(loaded.profile.tasks).filter(id => holdthis.tasks[id])).toEqual([]);
    expect(loaded.profile.plans.release.steps.map(step => step.taskId)).toEqual(['test', 'pack', 'checksum']);
    expect(loaded.profile.plans.publish.kind).toBe('gated');
    const a = await libraryApp({ demo: true });
    const frame = screen(a);
    expect(frame).toContain('Library');
    expect(frame).toContain('Test');
    expect(frame).toContain('Pack');
    expect(frame).not.toContain('Apple Silicon');
    expect(frame).not.toContain('Build app');
    expect(frame).not.toContain('Notarize app');
    expect(frame).not.toContain('signed only');
  });

  test('a demo release stays separate from publish', async () => {
    const a = await libraryApp({ demo: true });
    expect(a.profile.plans.publish.blocked(a.context())).toBe(publishBlocked);
    a.key('p', key('p'));
    expect(a.notice).toBe(publishBlocked);
    expect(a.modal).toBeNull();
    a.openRun(a.profile.plans.release);
    await accept(a);
    expect(a.runner.result).toBe('done');
    expect(a.runner.jobs.map(job => job.id)).toEqual(['test', 'pack', 'checksum']);
    const scripted = a.runner.logs.map(line => line.text);
    expect(scripted).toContain('tests passed');
    expect(scripted).toContain('archive packed');
    expect(scripted).toContain('checksum written');
    expect(scripted).not.toContain('package uploaded');
    expect(a.facts.get('artifact.tested')).toMatchObject({ state: 'present', provenance: { source: 'task', id: 'test' } });
    expect(a.facts.get('artifact.archive').state).toBe('present');
    expect(a.facts.get('artifact.archive.sha256').state).toBe('present');
    expect(a.profile.plans.publish.blocked(a.context())).toBe('');
    expect(await Bun.file(join(temp, 'out/library.tgz')).exists()).toBe(false);
    a.openGated(a.profile.plans.publish);
    expect(a.modal.title).toBe('Validate package');
    await accept(a);
    expect(a.runner.result).toBe('paused');
    expect(a.runner.logs.map(line => line.text)).toContain('validation passed');
    expect(a.runner.logs.map(line => line.text)).not.toContain('package uploaded');
    a.openGated(a.profile.plans.publish);
    expect(a.modal.title).toBe('Upload package');
    expect(a.modal.danger).toBe(true);
    await accept(a);
    expect(a.runner.result).toBe('done');
    expect(a.runner.jobs.map(job => job.id)).toEqual(['validate', 'upload']);
    expect(a.runner.logs.map(line => line.text)).toContain('package uploaded');
    expect(await Bun.file(join(temp, 'out/published/library.tgz')).exists()).toBe(false);
  });

  test('packaging does not upload, and a real checksum opens publish', async () => {
    const a = await libraryApp({ demo: false });
    expect(a.profile.plans.publish.blocked(a.context())).toBe(publishBlocked);
    a.openRun(a.profile.plans.release);
    await accept(a);
    expect(a.runner.result).toBe('done');
    expect(await readFile(join(temp, 'out/test.txt'), 'utf8')).toContain('1 pass');
    const archive = await readFile(join(temp, 'out/library.tgz'));
    const digest = createHash('sha256').update(archive).digest('hex');
    const checksum = await readFile(join(temp, 'out/library.tgz.sha256'), 'utf8');
    expect(checksum).toBe(`${digest}  library.tgz\n`);
    const contents = Bun.spawn(['tar', '-tzf', join(temp, 'out/library.tgz')], { stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(contents.stdout).text()).toBe('package.json\nlibrary.js\n');
    expect(await contents.exited).toBe(0);
    expect(await Bun.file(join(temp, 'out/published/library.tgz')).exists()).toBe(false);
    expect(a.facts.get('artifact.archive').state).toBe('present');
    expect(a.facts.get('artifact.archive.sha256')).toMatchObject({ state: 'verified', kind: 'checksum' });
    expect(a.profile.plans.publish.blocked(a.context())).toBe('');
    a.openGated(a.profile.plans.publish);
    await accept(a);
    expect(a.runner.result).toBe('paused');
    expect(a.runner.jobs.map(job => job.status)).toEqual(['done', 'pending']);
    expect(await Bun.file(join(temp, 'out/published/library.tgz')).exists()).toBe(false);
    a.openGated(a.profile.plans.publish);
    expect(a.modal.danger).toBe(true);
    await accept(a);
    expect(a.runner.result).toBe('done');
    expect(a.runner.jobs.map(job => job.id)).toEqual(['validate', 'upload']);
    expect(await readFile(join(temp, 'out/published/library.tgz'))).toEqual(archive);
    expect(await readFile(join(temp, 'out/published/library.tgz.sha256'), 'utf8')).toBe(checksum);
  });

  test('a failing library test stops packaging and keeps publish blocked', async () => {
    const a = await libraryApp({ demo: false });
    await writeFile(join(temp, 'library.js'), 'export const add = () => 0;\n');
    a.openRun(a.profile.plans.release);
    await accept(a);
    expect(a.runner.result).toBe('failed');
    expect(a.runner.jobs.map(job => job.status)).toEqual(['failed', 'pending', 'pending']);
    expect(a.facts.get('artifact.tested').state).toBe('missing');
    expect(a.facts.get('artifact.archive').state).toBe('missing');
    expect(a.profile.plans.publish.blocked(a.context())).toBe(publishBlocked);
    expect(await Bun.file(join(temp, 'out/published/library.tgz')).exists()).toBe(false);
  });

  test('upload rejects a package changed after validation', async () => {
    const a = await libraryApp({ demo: false });
    a.openRun(a.profile.plans.release);
    await accept(a);
    expect(a.runner.result).toBe('done');
    a.openGated(a.profile.plans.publish);
    await accept(a);
    expect(a.runner.result).toBe('paused');
    await writeFile(join(temp, 'out/library.tgz'), 'changed after validation');
    a.openGated(a.profile.plans.publish);
    await accept(a);
    expect(a.runner.result).toBe('failed');
    expect(a.runner.jobs.map(job => job.status)).toEqual(['done', 'failed']);
    expect(a.runner.logs.map(line => line.text).join('\n')).toContain('Package checksum does not match');
    expect(a.facts.get('artifact.archive.sha256').state).toBe('mismatch');
    expect(a.profile.plans.publish.blocked(a.context())).toBe(publishBlocked);
    expect(await Bun.file(join(temp, 'out/published/library.tgz')).exists()).toBe(false);
  });

  test('a snapshot of the example directory shows the library header', async () => {
    const proc = Bun.spawn(['bun', join(packageRoot, 'bin/cli.js'), '--demo', '--snapshot'], {
      cwd: libraryExample,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    expect(stdout).toContain('Library');
    expect(stdout).toContain('Test');
    expect(stdout).toContain('Pack');
    expect(stdout).not.toContain('Apple Silicon');
    expect(stdout).not.toContain('Build app');
    expect(stdout).not.toContain('Notarize app');
  });

  test('the cockpit and runner do not branch on a profile', async () => {
    const sources = await Promise.all(['src/release/view.js', 'src/release/app.js', 'src/tui/runner.js'].map(path => readFile(join(packageRoot, path), 'utf8')));
    expect(sources.join('\n')).not.toMatch(/profile\.id|holdthis|HoldThis|notarize|Apple/);
  });
});

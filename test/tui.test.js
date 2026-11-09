import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { App } from '../src/release/app.js';
import { Runner, cleanOutput, takeStatusLine } from '../src/tui/runner.js';
import { createFrameClock } from '../src/tui/frame.js';
import { visibleLogs } from '../src/tui/logs.js';
import { holdthis, checksumOK } from '../src/profiles/holdthis.js';
import { openingParams, planBlock, requirement, resolvePlan } from '../src/workflow/model.js';
import { render, fit, spinner } from '../src/release/view.js';

let temp;
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'releasethis-tui-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
const key = name => ({ name });
const app = () => { const a = new App({ root: temp, demo: true, profile: holdthis }); a.workspace = holdthis.demoWorkspace(); return a; };
function releaseContext(source, version, build, signedOnly, facts = holdthis.demoFacts()) {
  facts.get('version.source').value = { ...source };
  return { facts, params: { version, build }, mode: { signedOnly }, demo: false, env: process.env, commandLine: holdthis.commandLine };
}
async function script(source) {
  const path = join(temp, 'release.sh');
  await writeFile(path, '#!/bin/bash\nset -eu\n' + source);
  await chmod(path, 0o755);
  return path;
}

describe('release planning and prerequisites', () => {
  const source = { version: '1.0.2', build: '3' };
  const plan = holdthis.plans.release;
  test('rebuilding keeps version and runs all six stages in backend order', () => {
    expect(resolvePlan(plan, releaseContext(source, '1.0.2', '3', false)).map(job => job.args)).toEqual([
      ['build'], ['sign'], ['notarize-app'], ['zip'], ['dmg'], ['checksums'],
    ]);
  });
  test('changed version keeps or increases the build explicitly', () => {
    expect(resolvePlan(plan, releaseContext(source, '1.0.3', '3', false))[0].args).toEqual(['version', '1.0.3', '--keep-build']);
    expect(resolvePlan(plan, releaseContext(source, '1.0.3', '5', false))[0].args).toEqual(['version', '1.0.3', '--build', '5']);
  });
  test('signed-only removes app notarization and flags both archives', () => {
    expect(resolvePlan(plan, releaseContext(source, '1.0.2', '3', true)).map(job => job.args)).toEqual([
      ['build'], ['sign'], ['zip', '--signed-only'], ['dmg', '--signed-only'], ['checksums'],
    ]);
  });
  test('rejects invalid versions, shell payloads, zero and decreasing builds', () => {
    for (const version of ['1.2', '01.0.2', '1.2.3; touch /tmp/no']) expect(() => resolvePlan(plan, releaseContext(source, version, '4', false))).toThrow();
    for (const build of ['0', '2', '4; exit', '01']) expect(() => resolvePlan(plan, releaseContext(source, '1.0.3', build, false))).toThrow();
  });
  test('only advances the default version after a complete matching release', () => {
    const facts = holdthis.demoFacts();
    const sourceFact = () => ({ ...facts.get('version.source').value });
    expect(openingParams(plan, facts)).toEqual(sourceFact());
    facts.get('version.built').value = sourceFact();
    expect(openingParams(plan, facts)).toEqual({ version: '1.0.4', build: '5' });
    facts.all().find(fact => fact.kind === 'checksum').state = 'mismatch';
    expect(openingParams(plan, facts)).toEqual(sourceFact());
  });
  test('checks step prerequisites and publish blockers', () => {
    const facts = holdthis.demoFacts();
    facts.get('notarization.stapled').value = false;
    const ctx = signedOnly => ({ facts, mode: { signedOnly } });
    expect(requirement(holdthis.tasks.zip, ctx(false))).toContain('staple');
    expect(requirement(holdthis.tasks.zip, ctx(true))).toBe('');
    expect(requirement(holdthis.tasks['notarize-app'], ctx(true))).not.toBe('');
    expect(planBlock(holdthis.plans.publish, ctx(true))).not.toBe('');
    facts.all().find(fact => fact.kind === 'checksum').state = 'mismatch';
    expect(planBlock(holdthis.plans.publish, ctx(false))).not.toBe('');
  });
  test('validates checksum bytes and recorded filename', async () => {
    const archive = join(temp, 'app.zip'), sha = archive + '.sha256';
    await writeFile(archive, 'archive bytes');
    const digest = createHash('sha256').update('archive bytes').digest('hex');
    await writeFile(sha, `${digest}  app.zip\n`);
    expect(await checksumOK(archive, sha)).toBe(true);
    await writeFile(sha, `${digest}  other.zip\n`);
    expect(await checksumOK(archive, sha)).toBe(false);
    await writeFile(sha, `${'0'.repeat(64)}  app.zip\n`);
    expect(await checksumOK(archive, sha)).toBe(false);
  });
});

describe('keyboard and review flows', () => {
  test('supports arrows, Vim keys, uppercase shortcuts and tabs', () => {
    const a = app();
    a.key('', key('down')); expect(a.selection).toBe(1);
    a.key('j', key('j')); expect(a.selection).toBe(2);
    a.key('N', { name: 'n', shift: true }); expect(a.signedOnly).toBe(true);
    a.key('', key('tab')); expect(a.tab).toBe(1);
    a.key('', { name: 'tab', shift: true }); expect(a.tab).toBe(0);
    a.key('3', key('3')); expect(a.screen).toBe('steps');
    a.key('', key('escape')); expect(a.screen).toBe('home');
  });
  test('version review does not execute until explicitly selected', () => {
    const a = app();
    a.key('1', key('1'));
    expect(a.modal.type).toBe('release');
    for (let i = 0; i < 3; i++) a.key('', key('return'));
    expect(a.modal.type).toBe('confirm');
    expect(a.modal.choice).toBe(0);
    a.key('', key('return'));
    expect(a.modal).toBeNull();
    expect(a.runner.running).toBe(false);
  });
  test('field editing and validation retain invalid input for correction', () => {
    const a = app(); a.newRelease();
    a.key('', { name: 'u', ctrl: true });
    a.key('1.2', {});
    for (let i = 0; i < 3; i++) a.key('', key('return'));
    expect(a.modal.error).toContain('major.minor.patch');
    expect(a.modal.type).toBe('release');
  });
  test('command palette filters and opens artifacts', () => {
    const a = app(); a.key('/', {}); a.key('artifacts', {}); a.key('', key('return'));
    expect(a.tab).toBe(1); expect(a.modal).toBeNull();
  });
  test('publish validation precedes a separate upload review', () => {
    const a = app(); a.publish();
    expect(a.modal.title).toContain('Validate');
    expect(a.modal.lines.join(' ')).toContain('--dry-run');
    a.modal = null; a.preflightReady = true; a.publish();
    expect(a.modal.title).toBe('Publish to GitHub');
    expect(a.modal.lines.join(' ')).toContain('v1.0.2+3');
    expect(a.modal.lines.join(' ')).toContain('repo unknown');
    expect(a.modal.choice).toBe(0);
  });
  test('active tasks lock release actions and release mode', () => {
    const a = app(); a.runner.running = true;
    a.newRelease(); expect(a.modal).toBeNull();
    a.toggleMode(); expect(a.signedOnly).toBe(false);
    a.key('', { name: 'c', ctrl: true });
    expect(a.modal.title).toBe('Cancel active task?');
    expect(a.modal.choice).toBe(0);
  });
});

describe('terminal layout', () => {
  test('all views and dialogs stay within terminal dimensions', () => {
    const a = app();
    const states = [() => {}, () => { a.tab = 1; }, () => { a.tab = 2; }, () => { a.showSteps(); },
      () => { a.newRelease(); }, () => { a.reviewRelease(); }, () => { a.modal = { type: 'help' }; },
      () => { a.modal = { type: 'palette', query: '', index: 0 }; }];
    for (const state of states) {
      state();
      for (const [cols, rows] of [[40, 12], [58, 20], [80, 24], [96, 24], [110, 34], [160, 50]]) {
        const lines = render(a, cols, rows);
        expect(lines.length).toBeLessThanOrEqual(rows);
        for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols - 1);
      }
    }
  });
  test('compact workspace and steps keep every action visible', () => {
    const a = app();
    expect(render(a, 58, 20, { color: false }).join('\n')).toContain('Run one step');
    a.showSteps();
    expect(render(a, 58, 20, { color: false }).join('\n')).toContain('Verify checksums');
  });
  test('color-free rendering and wide characters fit correctly', () => {
    expect(fit('猫 cat', 4)).toBe('猫 c');
    expect(render(app(), 110, 34, { color: false }).join('\n')).not.toContain('\x1b');
  });
});

describe('real backend process supervision', () => {
  test('passes arguments literally, streams output, and stops on failure', async () => {
    const path = await script('printf "%s\\n" "$@"\nif [ "$1" = fail ]; then exit 7; fi\n');
    const r = new Runner({ root: temp, script: path });
    const result = await r.run([
      { id: 'a', label: 'Literal arguments', args: ['ok', '$(touch should-not-exist)'] },
      { id: 'b', label: 'Failure', args: ['fail'] },
      { id: 'c', label: 'Never runs', args: ['never'] },
    ]);
    expect(result).toBe('failed');
    expect(r.jobs.map(j => j.status)).toEqual(['done', 'failed', 'pending']);
    expect(r.logs.some(l => l.text === '$(touch should-not-exist)')).toBe(true);
    expect(await Bun.file(join(temp, 'should-not-exist')).exists()).toBe(false);
    expect(r.logs.some(l => l.text.includes('code 7'))).toBe(true);
  });
  test('missing executable produces a visible failure', async () => {
    const r = new Runner({ root: temp, script: join(temp, 'missing') });
    expect(await r.run([{ id: 'a', label: 'Missing', args: [] }])).toBe('failed');
    expect(r.running).toBe(false);
  });
  test('cancels a running backend and its child process', async () => {
    const path = await script('sleep 30 &\necho $! > child.pid\nwait\n');
    const r = new Runner({ root: temp, script: path });
    const task = r.run([{ id: 'a', label: 'Waiting', args: [] }]);
    for (let i = 0; i < 100 && !await Bun.file(join(temp, 'child.pid')).exists(); i++) await Bun.sleep(10);
    const pid = Number(await readFile(join(temp, 'child.pid'), 'utf8'));
    r.cancel();
    expect(await task).toBe('cancelled');
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(r.running).toBe(false);
  });
  test('strips terminal control sequences from tool output', () => {
    expect(cleanOutput('\x1b[31mred\x1b[0m\x1b]52;c;secret\x07')).toBe('red');
  });
  test('multiline errors become separate terminal rows', () => {
    const r = new Runner({ root: temp, script: 'unused' });
    r.log('Command failed:\nfirst error\r\nsecond error', 'error');
    expect(r.logs.map(l => l.text)).toEqual(['Command failed:', 'first error', 'second error']);
  });
  test('cancellation escalates when a descendant ignores SIGTERM', async () => {
    const childScript = join(temp, 'stubborn.sh');
    await writeFile(childScript, '#!/bin/bash\ntrap "" TERM\necho $$ > stubborn.pid\nwhile true; do sleep 1; done\n');
    const path = await script('bash ./stubborn.sh > /dev/null 2>&1 &\nwait\n');
    const r = new Runner({ root: temp, script: path });
    const task = r.run([{ id: 'a', label: 'Stubborn child', args: [] }]);
    for (let i = 0; i < 100 && !await Bun.file(join(temp, 'stubborn.pid')).exists(); i++) await Bun.sleep(10);
    const pid = Number(await readFile(join(temp, 'stubborn.pid'), 'utf8'));
    r.cancel();
    expect(await task).toBe('cancelled');
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);
  test('bounds the output buffer', () => {
    const r = new Runner({ root: temp, script: 'unused' });
    for (let i = 0; i < 2600; i++) r.log(String(i));
    expect(r.logs.length).toBe(2500);
    expect(r.logs[0].text).toBe('100');
  });
});

describe('polished workspace flows', () => {
  test('every command is reachable without searching', () => {
    const a = app(); a.key('/', {});
    expect(a.filteredCommands().length).toBeGreaterThan(9);
    a.key('', key('end'));
    const screen = render(a, 58, 20, { color: false }).join('\n');
    expect(screen).toContain('Keyboard help');
    a.key('', key('return'));
    expect(a.modal.type).toBe('help');
  });
  test('version presets produce semver changes and increasing builds', () => {
    const a = app(); a.newRelease();
    for (const expected of ['1.0.4', '1.1.0', '2.0.0']) {
      a.key('', key('f2'));
      expect(a.modal.version).toBe(expected);
      expect(a.modal.build).toBe('5');
    }
    a.key('', key('f2'));
    expect(a.modal.version).toBe('1.0.3');
    expect(a.modal.build).toBe('4');
  });
  test('Escape from release review returns to the edited draft', () => {
    const a = app(); a.newRelease(); a.applyPreset(); a.reviewRelease();
    a.key('', key('escape'));
    expect(a.modal.type).toBe('release'); expect(a.modal.version).toBe('1.0.4');
  });
  test('long confirmation bodies scroll while keeping controls visible', () => {
    const a = app();
    a.confirm('Review release', ['Repository: ' + 'long-name/'.repeat(20), ...Array.from({ length: 20 }, (_, i) => `Stage ${i + 1}`)], 'Start release', () => {});
    let screen = render(a, 58, 20, { color: false }).join('\n');
    expect(screen).toContain('Start release'); expect(screen).toContain('Cancel'); expect(screen).toContain('↑ ↓ scroll');
    a.key('', key('end'));
    screen = render(a, 58, 20, { color: false }).join('\n');
    expect(screen).toContain('Stage 20'); expect(screen).toContain('Start release');
  });
  test('artifact navigation opens the selected file details', () => {
    const a = app(); a.key('a'); a.key('j'); a.key('j'); a.key('', key('return'));
    expect(a.modal.type).toBe('info');
    expect(a.modal.lines.join(' ')).toContain('HoldThis-AppleSilicon.zip');
  });
  test('Enter on the log view does not launch a hidden action', () => {
    const a = app(); a.key('l'); a.key('', key('return'));
    expect(a.modal).toBeNull(); expect(a.runner.running).toBe(false);
  });
  test('filter applies on Enter and Escape clears it', () => {
    const a = app(); a.key('f'); a.key('checksum', {}); a.key('', key('return'));
    expect(a.logFilter).toBe('checksum'); expect(a.tab).toBe(2);
    a.key('', key('escape')); expect(a.logFilter).toBe(''); expect(a.tab).toBe(2);
  });
  test('export saves plain timestamped output with a visible destination', async () => {
    const a = app(); a.demo = false;
    a.runner.log('build completed', 'success'); await a.saveLog();
    expect(a.modal.title).toBe('Session log saved');
    const contents = await readFile(a.modal.lines.at(-1), 'utf8');
    expect(contents).toContain('[success] build completed'); expect(contents).not.toContain('\x1b');
  });
  test('retry retains completed stages and the original release mode', async () => {
    const path = await script('echo "$1" >> commands\nif [ "$1" = sign ] && [ ! -f attempted ]; then touch attempted; exit 7; fi\n');
    const a = app(); a.demo = false; a.runner = new Runner({ root: temp, script: path }); a.refresh = async () => {};
    await a.start([{ id: 'build', label: 'Build', args: ['build'] }, { id: 'sign', label: 'Sign', args: ['sign'] }]);
    expect(a.runner.result).toBe('failed'); a.signedOnly = true;
    a.retry(); expect(a.modal.title).toBe('Resume interrupted task');
    a.modal.callback();
    while (a.runner.running) await Bun.sleep(10);
    expect(a.signedOnly).toBe(false);
    expect(a.runner.jobs.map(j => j.status)).toEqual(['done', 'done']);
    expect(await readFile(join(temp, 'commands'), 'utf8')).toBe('build\nsign\nsign\n');
  });
});

describe('log reading', () => {
  test('new output preserves the paused viewport and End resumes following', async () => {
    const { visibleLogs } = await import('../src/tui/logs.js');
    const a = app();
    for (let i = 0; i < 30; i++) a.runner.log(`line ${i}`);
    a.tab = 2; a.scroll = 10;
    const before = visibleLogs(a, 60, 5).rows.map(r => r.text);
    a.runner.log('new output'); a.runner.log('more output');
    expect(visibleLogs(a, 60, 5).rows.map(r => r.text)).toEqual(before);
    a.key('', key('end'));
    expect(visibleLogs(a, 60, 5).rows.at(-1).text).toBe('more output');
  });
  test('filter returns matching entries with long lines wrapped', async () => {
    const { visibleLogs } = await import('../src/tui/logs.js');
    const a = app(); a.runner.log('compile success'); a.runner.log('ERROR ' + 'detail '.repeat(20));
    a.logFilter = 'error';
    const rows = visibleLogs(a, 40, 100).rows;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(r => r.text).join(' ')).not.toContain('compile');
    expect(rows.every(r => Bun.stringWidth(r.text) <= 30)).toBe(true);
  });
  test('appends wrapped rows and keeps earlier row objects', () => {
    const a = app();
    for (let i = 0; i < 10; i++) a.runner.log(`line ${i}`);
    visibleLogs(a, 80, 5);
    const first = a.logCache.rows[0];
    const count = a.logCache.rows.length;
    a.runner.log('another line');
    visibleLogs(a, 80, 5);
    expect(a.logCache.rows[0]).toBe(first);
    expect(a.logCache.rows.length).toBe(count + 1);
    expect(a.logCache.rows.at(-1).text).toBe('another line');
  });
  test('rollover drops evicted rows and keeps a paused anchor', () => {
    const a = app();
    for (let i = 0; i < 2500; i++) a.runner.log(`line ${i}`);
    visibleLogs(a, 80, 5);
    const evicted = a.logCache.rows[0];
    const survivor = a.logCache.rows.at(-10);
    a.scroll = a.logCache.rows.length - a.logCache.rows.indexOf(survivor) - 1;
    visibleLogs(a, 80, 5);
    expect(a.logAnchor).toBe(survivor.rowId);
    for (let i = 0; i < 40; i++) a.runner.log(`extra ${i}`);
    const view = visibleLogs(a, 80, 5);
    expect(view.rows.at(-1)).toBe(survivor);
    expect(a.logCache.rows).toContain(survivor);
    expect(a.logCache.rows).not.toContain(evicted);
    expect(a.logCache.rows.some(row => row.text === 'line 0')).toBe(false);
  });
});

describe('frame budget', () => {
  function clockFor(a, { running = false, motion = false, paints = [] } = {}) {
    return createFrameClock({
      paint(kind) {
        paints.push(kind);
        a.deferLogIngest = kind === 'input';
        try { visibleLogs(a, 80, 5); }
        finally { a.deferLogIngest = false; }
      },
      isRunning: () => running,
      motion: () => motion,
    });
  }

  test('a flood of logs and status patches paints once per frame', () => {
    const a = app();
    const paints = [];
    const clock = clockFor(a, { running: true, paints });
    a.runner.onChange = reason => clock.mark(reason || 'chrome');
    a.runner.log('ready');
    expect(clock.tick(5_000)).toBe(true);
    paints.length = 0;
    for (let i = 0; i < 400; i++) {
      a.runner.log(`line ${i}`);
      a.runner.status({ phase: 'Linking', progress: i / 400, completed: i, total: 400 });
    }
    expect(clock.tick(5_000)).toBe(true);
    expect(paints).toEqual(['frame']);
    const { heartbeatAt, ...visible } = a.runner.statusSlot;
    expect(visible).toEqual({ phase: 'Linking', detail: null, progress: 399 / 400, completed: 399, total: 400 });
    expect(heartbeatAt).toBeGreaterThan(0);
    expect(a.logCache.rows.some(row => row.text === 'line 399')).toBe(true);
    expect(clock.tick(5_039)).toBe(false);
    expect(paints).toEqual(['frame']);
  });

  test('an identical status patch does not dirty the frame', () => {
    const a = app();
    const paints = [];
    const clock = clockFor(a, { paints });
    let marks = 0;
    a.runner.onChange = reason => { marks++; clock.mark(reason); };
    a.runner.status({ phase: 'Notarizing', detail: 'Waiting for Apple', progress: 0.2 });
    expect(marks).toBe(1);
    expect(clock.tick(1_000)).toBe(true);
    const heartbeat = a.runner.statusSlot.heartbeatAt;
    a.runner.statusSlot.heartbeatAt = heartbeat - 16_000;
    a.runner.status({ phase: 'Notarizing', detail: 'Waiting for Apple', progress: 0.2 });
    expect(marks).toBe(1);
    expect(a.runner.statusSlot.heartbeatAt).toBeGreaterThanOrEqual(heartbeat);
    expect(clock.tick(1_000)).toBe(false);
    a.runner.status({ phase: 'Stapling' });
    expect(a.runner.statusSlot).toMatchObject({ phase: 'Stapling', detail: null, progress: null, completed: null, total: null });
    expect(marks).toBe(2);
  });

  test('a keypress paints without flushing pending log lines', () => {
    const a = app();
    const paints = [];
    const clock = clockFor(a, { running: true, paints });
    a.runner.onChange = reason => clock.mark(reason || 'chrome');
    a.runner.log('first');
    expect(clock.tick(10_000)).toBe(true);
    const first = a.logCache.rows[0];
    const lastId = a.logCache.lastId;
    paints.length = 0;
    for (let i = 0; i < 50; i++) a.runner.log(`flood ${i}`);
    a.runner.status({ phase: 'Pack', progress: 0.4 });
    clock.input();
    expect(paints).toEqual(['input']);
    expect(a.logCache.lastId).toBe(lastId);
    expect(a.logCache.rows[0]).toBe(first);
    expect(a.logCache.rows.some(row => row.text === 'flood 0')).toBe(false);
    expect(clock.tick(10_000)).toBe(true);
    expect(paints).toEqual(['input', 'frame']);
    expect(a.logCache.rows[0]).toBe(first);
    expect(a.logCache.rows.some(row => row.text === 'flood 49')).toBe(true);
  });

  test('motion paints once per spinner frame and idle paints nothing', () => {
    const paints = [];
    let running = false;
    const clock = createFrameClock({
      paint: () => paints.push('paint'),
      isRunning: () => running,
      motion: () => true,
    });
    expect(clock.tick(0)).toBe(false);
    running = true;
    expect(clock.tick(0)).toBe(true);
    expect(clock.tick(89)).toBe(false);
    expect(clock.tick(90)).toBe(true);
    expect(paints).toEqual(['paint', 'paint']);
  });

  test('reduced motion paints when the elapsed second changes', () => {
    const paints = [];
    const clock = createFrameClock({
      paint: () => paints.push('paint'),
      isRunning: () => true,
      motion: () => false,
    });
    expect(clock.tick(1_000)).toBe(true);
    expect(clock.tick(1_500)).toBe(false);
    expect(clock.tick(2_000)).toBe(true);
    expect(paints).toEqual(['paint', 'paint']);
  });
});

describe('status channel', () => {
  const glyphs = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const now = 1_700_000_000_000;
  function running(phase) {
    const a = app();
    a.runner.running = true;
    a.runner.startedAt = now - 20_000;
    a.runner.jobs = [{ id: 'build', label: 'Build app', status: 'running', startedAt: now - 4_000 }];
    if (phase) a.runner.status(phase);
    return a;
  }

  test('parses quoted and unquoted sentinels and rejects a bad line', () => {
    expect(takeStatusLine('::status phase=Linking progress=0.66 completed=2 total=3').patch).toEqual({
      phase: 'Linking', progress: 0.66, completed: 2, total: 3,
    });
    expect(takeStatusLine('  ::status phase=Notarizing detail="Waiting for Apple"').patch).toEqual({
      phase: 'Notarizing', detail: 'Waiting for Apple',
    });
    expect(takeStatusLine('::status phase=Say detail="a \\"b\\" \\\\ c"').patch.detail).toBe('a "b" \\ c');
    expect(takeStatusLine('::status detail="no-end')).toEqual({ malformed: true });
    expect(takeStatusLine('::status nope=1')).toEqual({ malformed: true });
    expect(takeStatusLine('::status progress=2')).toEqual({ malformed: true });
    expect(takeStatusLine('build ::status phase=A')).toBeNull();
    expect(takeStatusLine('::statusphase=A')).toBeNull();
  });

  test('child sentinels update the slot and malformed lines stay in the log', async () => {
    const path = await script(`printf '%s\\n' 'plain line'
printf '%s\\n' '::status phase=Linking progress=0.5 completed=2 total=3'
printf '%s\\n' '::status progress=2'
printf '%s\\n' '::status nope=1'
printf '%s\\n' '::status detail="no-end'
printf '%s\\n' '::status phase=FromErr detail="Waiting for Apple"' >&2
`);
    const r = new Runner({ root: temp, script: path });
    const seen = [];
    r.onChange = reason => { if (reason === 'status') seen.push({ ...r.statusSlot }); };
    expect(await r.run([{ id: 'build', label: 'Build', args: ['build'] }])).toBe('done');
    expect(seen.map(slot => slot.phase)).toContain('Linking');
    expect(seen.find(slot => slot.phase === 'Linking')).toMatchObject({ progress: 0.5, completed: 2, total: 3 });
    expect(seen.find(slot => slot.phase === 'FromErr').detail).toBe('Waiting for Apple');
    expect(r.statusSlot).toBeNull();
    const texts = r.logs.map(line => line.text);
    expect(texts).toContain('plain line');
    expect(texts).toContain('::status progress=2');
    expect(texts).toContain('::status nope=1');
    expect(texts).toContain('::status detail="no-end');
    expect(texts.some(text => text.includes('phase=Linking') || text.includes('phase=FromErr'))).toBe(false);
    r.log('::status phase=Keep');
    expect(r.logs.at(-1).text).toBe('::status phase=Keep');
    expect(r.statusSlot).toBeNull();
  });

  test('truncates phase and detail before comparing snapshots', () => {
    const r = new Runner({ root: temp, script: 'unused' });
    let marks = 0;
    r.onChange = () => { marks++; };
    r.status({ phase: 'p'.repeat(50), detail: 'd'.repeat(130) });
    expect(r.statusSlot.phase).toHaveLength(40);
    expect(r.statusSlot.detail).toHaveLength(120);
    const heartbeat = r.statusSlot.heartbeatAt;
    r.statusSlot.heartbeatAt = heartbeat - 16_000;
    r.status({ phase: 'p'.repeat(80), detail: 'd'.repeat(200) });
    expect(marks).toBe(1);
    expect(r.statusSlot.heartbeatAt).toBeGreaterThanOrEqual(heartbeat);
  });

  test('a progress fraction draws a bar on the running row and in the footer', () => {
    const a = running({ phase: 'Link', detail: 'objects', progress: 2 / 3, completed: 2, total: 3 });
    const screen = render(a, 110, 34, { color: false, now }).join('\n');
    expect(screen).toContain('Link');
    expect(screen).toContain('objects');
    expect(screen).toContain('━');
    expect(screen).toContain('2/3');
    expect(screen).toContain('0/1 stages');
    expect(screen).not.toContain(spinner(Math.floor(now / 90)));
  });

  test('null progress keeps the spinner and the phase', () => {
    const a = running({ phase: 'Notarizing', detail: 'Waiting for Apple' });
    const screen = render(a, 110, 34, { color: false, now }).join('\n');
    expect(screen).toContain('Notarizing');
    expect(screen).toContain('Waiting for Apple');
    expect(screen).toContain(spinner(Math.floor(now / 90)));
  });

  test('reduced motion keeps the phase and the bar', () => {
    const a = running({ phase: 'Link', progress: 0.5 });
    a.motion = false;
    const screen = render(a, 110, 34, { color: false, now }).join('\n');
    expect(screen).toContain('Link');
    expect(screen).toContain('━');
    for (const glyph of glyphs) expect(screen).not.toContain(glyph);
  });

  test('a finished row returns to its duration label', () => {
    const a = running({ phase: 'Link', progress: 1 });
    a.runner.jobs[0].status = 'done';
    a.runner.jobs[0].endedAt = now;
    a.runner.statusSlot = null;
    a.runner.running = false;
    a.runner.result = 'done';
    a.runner.endedAt = now;
    const screen = render(a, 110, 34, { color: false, now }).join('\n');
    expect(screen).toContain('complete  4s');
    expect(screen).not.toContain('Link');
  });

  test('a quiet slot says work is still going', () => {
    const a = running({ phase: 'Notarizing', detail: 'Waiting for Apple', progress: 0.4 });
    a.runner.statusSlot.heartbeatAt = now - 15_000;
    const screen = render(a, 110, 34, { color: false, now }).join('\n');
    expect(screen).toContain('Notarizing');
    expect(screen).toContain('Still working · last update 15s ago');
    expect(screen).toContain('━');
  });

  test('an identical sentinel refreshes the heartbeat without dirtying the frame', () => {
    const a = running();
    const paints = [];
    const clock = createFrameClock({ paint: kind => paints.push(kind), isRunning: () => true, motion: () => false });
    let marks = 0;
    a.runner.onChange = reason => { marks++; clock.mark(reason); };
    const realNow = Date.now;
    Date.now = () => now;
    try {
      a.runner.ingestChildLine('::status phase=Notarizing detail="Waiting for Apple"');
      expect(marks).toBe(1);
      expect(clock.tick(now)).toBe(true);
      const aged = render(a, 110, 34, { color: false, now: now + 16_000 }).join('\n');
      expect(aged).toContain('Still working · last update 16s ago');

      Date.now = () => now + 16_000;
      a.runner.ingestChildLine('::status phase=Notarizing detail="Waiting for Apple"');
      expect(marks).toBe(1);
      expect(a.runner.statusSlot.heartbeatAt).toBe(now + 16_000);
      expect(clock.tick(now)).toBe(false);
      const fresh = render(a, 110, 34, { color: false, now: now + 16_000 }).join('\n');
      expect(fresh).toContain('Notarizing');
      expect(fresh).toContain('Waiting for Apple');
      expect(fresh).not.toContain('last update 16s ago');
      expect(fresh).not.toContain('Still working');
    } finally {
      Date.now = realNow;
    }
  });

  test('normalizes status text onto one row before clipping and dedupe', () => {
    const a = running();
    let marks = 0;
    a.runner.onChange = reason => { if (reason === 'status') marks++; };
    a.runner.status({ phase: 'Compile\nBROKEN', detail: 'one\rtwo' });
    expect(marks).toBe(1);
    expect(a.runner.statusSlot.phase).toBe('Compile BROKEN');
    expect(a.runner.statusSlot.detail).toBe('one two');
    const rows = render(a, 110, 34, { color: false, now });
    expect(rows).toHaveLength(34);
    expect(rows.join('\n').split('\n')).toHaveLength(34);
    const text = rows.join('\n');
    expect(text).toContain('Compile BROKEN');
    expect(text).toContain('one two');
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\t');
    expect(text).not.toContain('\x1b');

    a.runner.statusSlot.heartbeatAt = 1;
    a.runner.status({ phase: 'Compile\rBROKEN\x1b[0m', detail: 'one\ttwo\x1b]52;c;secret\x07' });
    expect(marks).toBe(1);
    expect(a.runner.statusSlot.heartbeatAt).toBeGreaterThan(1);
    expect(a.runner.statusSlot.phase).toBe('Compile BROKEN');
    expect(a.runner.statusSlot.detail).toBe('one two');

    a.runner.status({ phase: 'Compile\tOK', detail: 'see \x1b[31mred\x1b[0m\x1b]52;c;secret\x07 now' });
    expect(marks).toBe(2);
    expect(a.runner.statusSlot.phase).toBe('Compile OK');
    expect(a.runner.statusSlot.detail).toBe('see red now');
    const controlled = render(a, 110, 34, { color: false, now });
    expect(controlled).toHaveLength(34);
    expect(controlled.join('\n').split('\n')).toHaveLength(34);
    const controlledText = controlled.join('\n');
    expect(controlledText).toContain('Compile OK');
    expect(controlledText).toContain('see red now');
    expect(controlledText).not.toContain('\t');
    expect(controlledText).not.toContain('\r');
    expect(controlledText).not.toContain('\x1b');
    expect(controlledText).not.toContain('secret');

    const r = new Runner({ root: temp, script: 'unused' });
    let statusMarks = 0;
    r.onChange = reason => { if (reason === 'status') statusMarks++; };
    r.status({ phase: 'Compile\n' + 'B'.repeat(50), detail: 'one\r' + 'd'.repeat(140) });
    const phase = ('Compile ' + 'B'.repeat(50)).slice(0, 40);
    const detail = ('one ' + 'd'.repeat(140)).slice(0, 120);
    expect(r.statusSlot.phase).toBe(phase);
    expect(r.statusSlot.detail).toBe(detail);
    expect(r.statusSlot.phase).not.toContain('\n');
    expect(statusMarks).toBe(1);
    r.statusSlot.heartbeatAt = 1;
    r.status({ phase: 'Compile\r' + 'B'.repeat(80) + '\x1b[31m', detail: 'one\t' + 'd'.repeat(200) + '\nmore' });
    expect(statusMarks).toBe(1);
    expect(r.statusSlot.heartbeatAt).toBeGreaterThan(1);
    expect(r.statusSlot.phase).toBe(phase);
    expect(r.statusSlot.detail).toBe(detail);
  });

  test('demo build progress moves through the slot and stays out of the log', async () => {
    const steps = holdthis.tasks.build.demo;
    expect(steps.map(step => step.status.progress)).toEqual([1 / 3, 1 / 3, 2 / 3, 1]);
    expect(steps.map(step => step.status.phase)).toEqual(['Compile', 'Compile', 'Link', 'Stage']);
    const r = new Runner({ root: temp, script: 'unused', demo: true });
    r.demoPace = 0;
    const seen = [];
    r.onChange = reason => { if (reason === 'status' && r.statusSlot) seen.push(r.statusSlot.progress); };
    expect(await r.run([{ id: 'build', label: 'Build app', args: ['build'], demo: steps, display: holdthis.commandLine(['build']) }])).toBe('done');
    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
    expect(r.logs.some(line => line.text.includes('Link HoldThis'))).toBe(true);
    expect(r.logs.some(line => line.text.includes('::status'))).toBe(false);
    expect(r.statusSlot).toBeNull();
  });
});

describe('final status sentinels without a trailing newline', () => {
  test('parses valid sentinels and logs malformed or ordinary text on stdout and stderr', async () => {
    const path = await script(`case "$1" in
valid)
  printf '%s\\n' 'plain line'
  printf '%s' '::status phase=Final progress=1'
  printf '%s' '::status phase=ErrFinal' >&2
  ;;
bad)
  printf '%s' '::status nope=1'
  printf '%s' '::status detail="no-end' >&2
  ;;
text)
  printf '%s' 'ordinary tail'
  printf '%s' 'err tail' >&2
  ;;
esac
`);
    const r = new Runner({ root: temp, script: path });
    const seen = [];
    r.onChange = reason => { if (reason === 'status') seen.push({ ...r.statusSlot }); };

    expect(await r.run([{ id: 'valid', label: 'Valid', args: ['valid'] }])).toBe('done');
    expect(seen.map(slot => slot.phase).sort()).toEqual(['ErrFinal', 'Final']);
    expect(seen.find(slot => slot.phase === 'Final')).toMatchObject({ progress: 1 });
    expect(r.statusSlot).toBeNull();
    let texts = r.logs.map(line => line.text);
    expect(texts).toContain('plain line');
    expect(texts.some(text => text.includes('::status') || text.includes('phase=Final') || text.includes('phase=ErrFinal'))).toBe(false);

    seen.length = 0;
    expect(await r.run([{ id: 'bad', label: 'Bad', args: ['bad'] }])).toBe('done');
    expect(seen).toEqual([]);
    texts = r.logs.map(line => line.text);
    expect(texts).toContain('::status nope=1');
    expect(texts).toContain('::status detail="no-end');

    expect(await r.run([{ id: 'text', label: 'Text', args: ['text'] }])).toBe('done');
    texts = r.logs.map(line => line.text);
    expect(texts).toContain('ordinary tail');
    expect(texts).toContain('err tail');
  });

  test('reassembles a valid sentinel split across chunks with no trailing newline', async () => {
    const path = await script(`printf '%s' '::status phase=Spl'
sleep 0.2
printf '%s' 'it progress=1'
`);
    const r = new Runner({ root: temp, script: path });
    const seen = [];
    r.onChange = reason => { if (reason === 'status') seen.push({ ...r.statusSlot }); };
    expect(await r.run([{ id: 'split', label: 'Split', args: [] }])).toBe('done');
    expect(seen.map(slot => slot.phase)).toEqual(['Split']);
    expect(seen[0].progress).toBe(1);
    expect(r.statusSlot).toBeNull();
    expect(r.logs.some(line => line.text.includes('::status') || line.text.includes('phase=Spl') || line.text === 'it progress=1')).toBe(false);
  });
});

describe('cockpit boundary', () => {
  test('the renderer does not name HoldThis paths, stage ids, or product copy', async () => {
    for (const file of ['app.js', 'view.js', 'dialogs.js']) {
      const source = await readFile(new URL(`../src/release/${file}`, import.meta.url), 'utf8');
      for (const word of ['HoldThis', 'notarize-app', 'script/release.sh', 'Apple Silicon']) {
        expect(source.includes(word)).toBe(false);
      }
    }
  });
});

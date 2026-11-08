import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { App } from './app.js';
import { Runner, cleanOutput } from './runner.js';
import { checksumOK, demoWorkspace, planRelease, releaseDefaults, stepBlock, publishBlock } from './model.js';
import { render, fit } from './view.js';

let temp;
beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'holdthis-tui-')); });
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });
const key = name => ({ name });
const app = () => { const a = new App({ root: temp, demo: true }); a.workspace = demoWorkspace(); return a; };
async function script(source) {
  const path = join(temp, 'release.sh');
  await writeFile(path, '#!/bin/bash\nset -eu\n' + source);
  await chmod(path, 0o755);
  return path;
}

describe('release planning and prerequisites', () => {
  const source = { version: '1.0.2', build: '3' };
  test('rebuilding keeps version and runs all six stages in backend order', () => {
    expect(planRelease(source, '1.0.2', '3', false).map(j => j.args)).toEqual([
      ['build'], ['sign'], ['notarize-app'], ['zip'], ['dmg'], ['checksums'],
    ]);
  });
  test('changed version keeps or increases the build explicitly', () => {
    expect(planRelease(source, '1.0.3', '3', false)[0].args).toEqual(['version', '1.0.3', '--keep-build']);
    expect(planRelease(source, '1.0.3', '5', false)[0].args).toEqual(['version', '1.0.3', '--build', '5']);
  });
  test('signed-only removes app notarization and flags both archives', () => {
    expect(planRelease(source, '1.0.2', '3', true).map(j => j.args)).toEqual([
      ['build'], ['sign'], ['zip', '--signed-only'], ['dmg', '--signed-only'], ['checksums'],
    ]);
  });
  test('rejects invalid versions, shell payloads, zero and decreasing builds', () => {
    for (const version of ['1.2', '01.0.2', '1.2.3; touch /tmp/no']) expect(() => planRelease(source, version, '4', false)).toThrow();
    for (const build of ['0', '2', '4; exit', '01']) expect(() => planRelease(source, '1.0.3', build, false)).toThrow();
  });
  test('only advances the default version after a complete matching release', () => {
    const ws = demoWorkspace();
    expect(releaseDefaults(ws)).toEqual(ws.source);
    ws.built = { ...ws.source };
    expect(releaseDefaults(ws)).toEqual({ version: '1.0.4', build: '5' });
    ws.artifacts[4].state = 'mismatch';
    expect(releaseDefaults(ws)).toEqual(ws.source);
  });
  test('checks step prerequisites and publish blockers', () => {
    const ws = demoWorkspace();
    ws.stapled = false;
    expect(stepBlock('zip', ws, false)).toContain('staple');
    expect(stepBlock('zip', ws, true)).toBe('');
    expect(stepBlock('notarize-app', ws, true)).not.toBe('');
    expect(publishBlock(ws, true)).not.toBe('');
    ws.artifacts[4].state = 'mismatch';
    expect(publishBlock(ws, false)).not.toBe('');
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
    const { visibleLogs } = await import('./logs.js');
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
    const { visibleLogs } = await import('./logs.js');
    const a = app(); a.runner.log('compile success'); a.runner.log('ERROR ' + 'detail '.repeat(20));
    a.logFilter = 'error';
    const rows = visibleLogs(a, 40, 100).rows;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(r => r.text).join(' ')).not.toContain('compile');
    expect(rows.every(r => Bun.stringWidth(r.text) <= 30)).toBe(true);
  });
});

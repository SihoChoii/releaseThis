import { duration } from '../tui/format.js';
import { STALE_AFTER_MS } from '../tui/runner.js';
import { painter, fit, box, wrap, plain, bar, spinner, splitLine } from '../tui/terminal.js';
import { dialog } from './dialogs.js';
import { logLines } from '../tui/logs.js';
import { sameVersion } from '../workflow/model.js';
export { fit, painter, palette, bar, spinner } from '../tui/terminal.js';

const version = value => value ? `${value.version} (${value.build})` : 'Not built';
const stamp = time => time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const good = artifact => ['present', 'verified'].includes(artifact.state);

function stageState(app, task, frame, now) {
  const job = app.runner.jobs.find(item => item.id === task.id);
  if (job) {
    if (job.status === 'running' && !app.runner.cancelled && app.runner.statusSlot) {
      const slot = app.runner.statusSlot;
      const caption = [slot.phase, slot.detail].filter(Boolean).join(' · ');
      const determinate = typeof slot.progress === 'number';
      if (caption || determinate) return {
        icon: determinate || !app.motion ? '●' : spinner(frame),
        tone: 'ice',
        label: caption,
        meter: determinate ? slot.progress : null,
      };
    }
    const status = { done: ['✓', 'mint', 'complete'], running: [app.motion ? spinner(frame) : '●', 'ice', app.runner.cancelled ? 'stopping' : 'working'], failed: ['×', 'red', 'failed'], cancelled: ['■', 'amber', 'stopped'], pending: ['○', 'muted', 'queued'] }[job.status];
    return { icon: status[0], tone: status[1], label: job.startedAt ? `${status[2]}  ${duration((job.endedAt || now) - job.startedAt)}` : status[2] };
  }
  const skipped = task.skip?.(app.mode());
  if (skipped) return { icon: '–', tone: 'muted', label: skipped };
  const blocked = app.facts ? task.requires?.(app.context()) || '' : 'Reading workspace';
  return { icon: blocked ? '·' : '○', tone: 'muted', label: blocked ? 'prerequisite needed' : 'ready to run' };
}

function pipeline(app, width, height, c, frame, now) {
  const lines = [];
  const spacious = height >= 22;
  const catalog = app.profile.catalog;
  const mode = app.profile.mode;
  if (spacious) lines.push('');
  let previousGroup = '';
  catalog.forEach((task, index) => {
    if (task.group && task.group !== previousGroup) {
      previousGroup = task.group;
      lines.push(' ' + c(task.group, 'muted'));
    }
    const state = stageState(app, task, frame, now);
    lines.push(' ' + c(`${state.icon}  ${task.label}`, state.tone, state.tone === 'ice'));
    if (height >= 17) lines.push(state.meter == null ? '    ' + c(state.label, 'muted') : '    ' + bar(state.meter, 1, 8, c) + (state.label ? c(' ' + state.label, 'muted') : ''));
    if (spacious && index !== catalog.length - 1) lines.push('    ' + c('│', 'line'));
  });
  if (height >= 25 && mode?.sidebar) lines.push('', ' ' + c('Release mode', 'muted'), ' ' + c(app.signedOnly ? mode.sidebar.on : mode.sidebar.off, app.signedOnly ? 'amber' : 'mint'), ' ' + c(mode.sidebar.hint, 'muted'));
  return box('Pipeline', lines, width, c, height);
}

function overview(app, width, height, c) {
  const ws = app.workspace;
  const copy = app.profile.copy;
  const lines = [];
  if (height >= 18) lines.push('', ' ' + c(copy.intro, 'ink', true));
  lines.push(' ' + c('Source ', 'muted') + c(version(ws?.source), 'ice', true) + c('   Built ', 'muted') + version(ws?.built));
  if (height >= 18) {
    const drifted = !!(ws?.built && !sameVersion(ws.source, ws.built));
    lines.push(' ' + c(drifted ? copy.drifted : copy.aligned, drifted ? 'amber' : 'muted'));
  }
  lines.push('');
  app.homeActions().forEach((action, i) => {
    const label = ` ${app.selection === i ? '❯' : ' '} ${i + 1}  ${action.label}`;
    lines.push(app.selection === i ? c.selected(label, width - 2) : c(label));
    if (height >= 18) lines.push('      ' + c(action.detailFor?.(app) || action.detail, 'muted'));
    if (height >= 25) lines.push('');
  });
  if (height >= 18 && ws) {
    const present = ws.artifacts.filter(good).length;
    const checksums = ws.artifacts.filter(artifact => artifact.kind === 'checksum');
    const verified = checksums.filter(artifact => artifact.state === 'verified').length;
    lines.push('', ' ' + c('Release readiness', 'ink', true));
    lines.push(' ' + c(`${present}/${ws.artifacts.length} files present`, present === ws.artifacts.length ? 'mint' : 'amber') + c('   │   ', 'line') + c(`${verified}/${checksums.length} checksums verified`, verified === checksums.length ? 'mint' : 'amber'));
    for (const check of ws.checks) lines.push(' ' + c(check.value ? check.whenTrue : check.whenFalse, check.value ? 'mint' : 'muted'));
    if (height >= 25) {
      const gated = app.gatedPlan();
      if (gated) {
        const blocked = gated.blocked(app.context());
        lines.push(' ' + c(blocked || copy.publishReady, blocked ? 'amber' : 'ice'));
      }
      if (app.runner.result) lines.push('', ' ' + c(`Last task: ${app.runTitle || 'Release'} · ${app.runner.result}`, app.runner.result === 'done' ? 'mint' : 'amber'));
      else lines.push('', ' ' + c(copy.tip, 'muted'));
    }
  }
  return box('Release workspace', lines, width, c, height);
}

function steps(app, width, height, c, frame, now) {
  const copy = app.profile.copy;
  const catalog = app.profile.catalog;
  const lines = [];
  if (height >= 20) lines.push(' ' + c(copy.stepsIntro, 'muted'), '');
  catalog.forEach((task, i) => {
    const selected = app.selection === i;
    const state = stageState(app, task, frame, now);
    const label = ` ${selected ? '❯' : ' '} ${i + 1}  ${task.label}`;
    lines.push(selected ? c.selected(label, width - 2) : c(label, state.tone));
    if (height >= 24) lines.push('      ' + c(task.detail, 'muted'));
  });
  if (height >= 14 && catalog[app.selection]) {
    const task = catalog[app.selection];
    const skipped = task.skip?.(app.mode()) || '';
    const blocked = skipped || (app.facts ? task.requires?.(app.context()) || '' : 'Reading workspace…');
    lines.push('', ...wrap(blocked || task.detail, width - 4).map(line => ' ' + c(line, blocked ? 'amber' : 'ice')));
    if (height >= 20) lines.push(' ' + c(blocked ? copy.stepsBlocked : copy.stepsReady, 'muted'));
  }
  return box('Run one step', lines, width, c, height);
}

function artifacts(app, width, height, c) {
  const copy = app.profile.copy;
  const lines = [];
  if (height >= 16) lines.push(' ' + c(copy.files, 'ink', true), ' ' + c(copy.legend, 'muted'), '');
  for (const [i, artifact] of (app.workspace?.artifacts || []).entries()) {
    const selected = app.artifactIndex === i;
    const tone = artifact.state === 'verified' ? 'mint' : artifact.state === 'present' ? 'ice' : artifact.state === 'mismatch' ? 'red' : 'muted';
    const label = ` ${selected ? '❯' : ' '} ${artifact.label}`;
    const tail = `${artifact.state === 'verified' ? '✓' : artifact.state === 'mismatch' ? '×' : '·'} ${artifact.state}`;
    const row = splitLine(label, `${tail}  ${artifact.size || '—'} `, width - 2);
    lines.push(selected ? c.selected(row, width - 2) : splitLine(c(label), c(`${tail}  ${artifact.size || '—'} `, tone), width - 2));
    if (height >= 23) lines.push('     ' + c(artifact.short || artifact.path, 'muted'));
  }
  if (height >= 16 && app.workspace && typeof copy.signed === 'function') lines.push('', ' ' + c(copy.signed(version(app.workspace.built), stamp(app.refreshedAt)), 'muted'));
  if (height >= 23) lines.push(' ' + c(copy.artifactHint, 'muted'));
  return box('Artifacts', lines, width, c, height);
}

function output(app, width, height, c) {
  let top = [];
  if (app.runner.jobs.length && height >= 16) {
    const runner = app.runner;
    const title = runner.running ? runner.cancelled ? 'Stopping task…' : app.runTitle || 'Task running' : runner.result === 'done' ? 'Task completed' : runner.result === 'paused' ? 'Task paused' : runner.result === 'failed' ? 'Task failed' : 'Task cancelled';
    top = [' ' + c(title, runner.result === 'failed' ? 'red' : runner.result === 'done' ? 'mint' : 'ice', true)];
    if (!runner.running) top.push(' ' + c(runner.result === 'paused' ? 'T continue plan   E save log' : ['failed', 'cancelled'].includes(runner.result) ? 'T resume remaining stages   E save log' : 'A inspect artifacts   P publish   E save log', 'muted'));
    top.push(' ' + c('─'.repeat(width - 4), 'line'));
  }
  const logs = logLines(app, width - 2, height - 2 - top.length, c);
  const title = app.logFilter ? `Logs · filter: ${app.logFilter}` : app.scroll ? 'Logs · paused · End to follow' : 'Live output · following';
  return box(title, [...top, ...logs], width, c, height);
}

export function render(app, columns, rows, { color = true, now = Date.now() } = {}) {
  const c = painter(color), width = Math.max(1, columns - 1);
  if (columns < 58 || rows < 20) return [c('releaseThis / release cockpit', 'amber', true), '', 'Resize to at least 58 columns × 20 rows.', `${columns} × ${rows} now. Q or Ctrl+C to quit.`].slice(0, rows).map(line => fit(line, width));
  const frame = Math.floor(now / 90), runner = app.runner;
  const live = runner.jobs.find(job => job.status === 'running'), done = runner.jobs.filter(job => job.status === 'done').length;
  const wide = columns >= 100, sideWidth = 30, mainWidth = wide ? width - sideWidth - 2 : width;
  const height = rows - 9;
  const repoLabel = app.repo || 'repo unknown';
  const modeLabel = app.demo ? 'DEMO · simulated' : 'local release';
  const topRight = c(` ${repoLabel} · ${modeLabel} `, app.demo ? 'amber' : 'muted');
  const chip = app.profile.mode?.chip ? (app.signedOnly ? app.profile.mode.chip.on : app.profile.mode.chip.off) : '';
  let lines = [
    splitLine(' ' + c('▗▖ ▗▖', 'amber') + '  ' + c('releaseThis', 'ink', true) + c(' / release cockpit', 'muted'), topRight, width),
    ' ' + c('▐▙▄▟▌', 'amber') + '  ' + c(app.profile.header.subtitle, 'muted') + (chip ? c('  /  ', 'line') + c(chip, app.signedOnly ? 'amber' : 'mint') : ''), '',
    splitLine(' ' + ['Workspace', 'Artifacts', 'Logs'].map((label, i) => c(`${i === app.tab ? '●' : '·'} ${label}  `, i === app.tab ? 'amber' : 'muted', i === app.tab)).join(''), c('/ commands  ? help ', 'muted'), width),
  ];
  const main = app.tab === 2 ? output(app, mainWidth, height, c) : app.tab === 1 ? artifacts(app, mainWidth, height, c) : app.screen === 'steps' ? steps(app, mainWidth, height, c, frame, now) : overview(app, mainWidth, height, c);
  if (wide) {
    const side = pipeline(app, sideWidth, height, c, frame, now);
    lines.push(...side.map((line, i) => line + '  ' + main[i]));
  } else lines.push(...main);
  const progressWidth = Math.min(32, width - 26);
  const taskState = runner.running ? `${runner.cancelled ? 'Stopping' : live?.label || 'Finishing'}  ${duration(now - runner.startedAt)}` : runner.result ? `${runner.result === 'done' ? '✓' : '■'} ${runner.result}  ${duration(runner.endedAt - runner.startedAt)}` : 'No active task';
  const slot = runner.running && !runner.cancelled ? runner.statusSlot : null;
  const stale = slot && now - slot.heartbeatAt >= STALE_AFTER_MS;
  const slotNotice = slot && [slot.phase, stale ? `Still working · last update ${duration(now - slot.heartbeatAt)} ago` : slot.detail, Number.isInteger(slot.completed) && Number.isInteger(slot.total) ? `${slot.completed}/${slot.total}` : null, duration(now - runner.startedAt)].filter(Boolean).join(' · ');
  const taskTone = runner.result === 'failed' ? 'red' : runner.result === 'done' ? 'mint' : 'ice';
  lines.push(splitLine(' ' + bar(done, runner.jobs.length, progressWidth, c) + '  ' + c(runner.jobs.length ? `${done}/${runner.jobs.length} stages` : 'Ready', 'muted'), c(columns >= 100 ? taskState + ' ' : runner.startedAt ? duration((runner.endedAt || now) - runner.startedAt) + ' ' : '', taskTone), width));
  const copy = app.profile.copy;
  const refreshSlot = app.refreshing ? runner.statusSlot : null;
  const refreshPlaceholder = !refreshSlot || (refreshSlot.phase === 'Refreshing' && !refreshSlot.detail && refreshSlot.progress == null);
  const refreshStale = refreshSlot && now - refreshSlot.heartbeatAt >= STALE_AFTER_MS;
  const refreshText = refreshPlaceholder
    ? copy.refreshing
    : [refreshSlot.phase, refreshStale ? `Still working · last update ${duration(now - refreshSlot.heartbeatAt)} ago` : refreshSlot.detail, typeof refreshSlot.progress === 'number' ? `${Math.round(refreshSlot.progress * 100)}%` : null, duration(now - (app.refreshStartedAt || now))].filter(Boolean).join(' · ');
  const refreshBar = !refreshPlaceholder && typeof refreshSlot.progress === 'number' ? bar(refreshSlot.progress, 1, 12, c) + ' ' : '';
  const notice = app.notice || (runner.running ? slotNotice || taskState : app.refreshing ? refreshText : app.tab === 2 ? (app.logFilter ? 'Filtered output · Esc clears the filter' : 'Output is retained for this session.') : `Checked ${stamp(app.refreshedAt)} · ${app.demo ? copy.demoIdle : copy.checked}`);
  const noticePrefix = !app.notice && !runner.running && app.refreshing ? refreshBar : '';
  const noticeWidth = Math.max(1, width - 2 - (noticePrefix ? Bun.stringWidth(plain(noticePrefix)) : 0));
  const noticeRows = wrap(notice, noticeWidth);
  lines.push(...noticeRows.slice(0, 2).map((line, i) => ' ' + (i === 0 ? noticePrefix : '') + c(i === 1 && noticeRows.length > 2 ? fit(line, Math.max(0, noticeWidth - 2)).trimEnd() + '…' : line, app.notice ? 'amber' : 'muted')));
  lines.push(' ' + c(app.hintLine(), 'muted'));
  while (lines.length < rows) lines.push('');
  if (app.modal) {
    const modalWidth = Math.min(78, width - 4), modal = dialog(app, modalWidth, rows - 2, c);
    lines = lines.map(line => c(plain(line), 'line'));
    const top = Math.floor((rows - modal.length) / 2), left = Math.floor((width - modalWidth) / 2);
    modal.forEach((line, i) => { lines[top + i] = ' '.repeat(left) + line; });
  }
  return lines.slice(0, rows).map(line => fit(line, width));
}

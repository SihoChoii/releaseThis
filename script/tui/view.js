import { STAGES, duration, sameVersion, stepBlock, publishBlock } from './model.js';
import { painter, fit, box, wrap, plain, bar, spinner, splitLine } from './terminal.js';
import { dialog } from './dialogs.js';
import { logLines } from './logs.js';
export { fit, painter, palette, bar, spinner } from './terminal.js';

const version = v => v ? `${v.version} (${v.build})` : 'Not built';
const stamp = time => time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const good = a => ['present', 'verified'].includes(a.state);
function stageState(app, stage, frame, now) {
  const job = app.runner.jobs.find(j => j.id === stage.id);
  if (job) {
    const status = { done: ['✓', 'mint', 'complete'], running: [app.motion ? spinner(frame) : '●', 'ice', app.runner.cancelled ? 'stopping' : 'working'], failed: ['×', 'red', 'failed'], cancelled: ['■', 'amber', 'stopped'], pending: ['○', 'muted', 'queued'] }[job.status];
    return { icon: status[0], tone: status[1], label: job.startedAt ? `${status[2]}  ${duration((job.endedAt || now) - job.startedAt)}` : status[2] };
  }
  if (app.signedOnly && stage.id === 'notarize-app') return { icon: '–', tone: 'muted', label: 'skipped in signed-only mode' };
  const blocked = app.workspace ? stepBlock(stage.id, app.workspace, app.signedOnly) : 'Reading workspace';
  return { icon: blocked ? '·' : '○', tone: 'muted', label: blocked ? 'prerequisite needed' : 'ready to run' };
}
function pipeline(app, width, height, c, frame, now) {
  const lines = [];
  const spacious = height >= 22;
  if (spacious) lines.push('');
  for (const stage of STAGES) {
    const state = stageState(app, stage, frame, now);
    lines.push(' ' + c(`${state.icon}  ${stage.label}`, state.tone, state.tone === 'ice'));
    if (height >= 17) lines.push('    ' + c(state.label, 'muted'));
    if (spacious && stage.id !== 'checksums') lines.push('    ' + c('│', 'line'));
  }
  if (height >= 25) lines.push('', ' ' + c('Release mode', 'muted'), ' ' + c(app.signedOnly ? 'Signed only' : 'Notarize & staple', app.signedOnly ? 'amber' : 'mint'), ' ' + c('N to change', 'muted'));
  return box('Pipeline', lines, width, c, height);
}
function overview(app, width, height, c) {
  const ws = app.workspace;
  const lines = [];
  if (height >= 18) lines.push('', ' ' + c('Ready for the next release.', 'ink', true));
  lines.push(' ' + c('Source ', 'muted') + c(version(ws?.source), 'ice', true) + c('   Built ', 'muted') + version(ws?.built));
  if (height >= 18) lines.push(' ' + c(ws?.built && !sameVersion(ws.source, ws.built) ? 'Source has changed. Publishing uses the built app.' : 'Build locally. Review the artifacts. Publish when ready.', ws?.built && !sameVersion(ws.source, ws.built) ? 'amber' : 'muted'));
  lines.push('');
  const actions = [
    ['New release', 'Choose a version, then run the complete pipeline.'],
    ['Publish release', app.preflightReady ? 'Validation passed. Review the public upload.' : 'Check existing archives and review the upload.'],
    ['Run one step', 'Run any available stage on its own.'],
  ];
  actions.forEach(([title, detail], i) => {
    const label = ` ${app.selection === i ? '❯' : ' '} ${i + 1}  ${title}`;
    lines.push(app.selection === i ? c.selected(label, width - 2) : c(label));
    if (height >= 18) lines.push('      ' + c(detail, 'muted'));
    if (height >= 25) lines.push('');
  });
  if (height >= 18 && ws) {
    const present = ws.artifacts.filter(good).length;
    const verified = ws.artifacts.filter(a => a.state === 'verified').length;
    lines.push('', ' ' + c('Release readiness', 'ink', true));
    lines.push(' ' + c(`${present}/6 files present`, present === 6 ? 'mint' : 'amber') + c('   │   ', 'line') + c(`${verified}/2 checksums verified`, verified === 2 ? 'mint' : 'amber'));
    lines.push(' ' + c(ws.stapled ? '✓ App notarization ticket is stapled' : '○ App notarization ticket not verified', ws.stapled ? 'mint' : 'muted'));
    if (height >= 25) {
      const blocked = publishBlock(ws, app.signedOnly);
      lines.push(' ' + c(blocked || 'P to validate the release for publishing', blocked ? 'amber' : 'ice'));
      if (app.runner.result) lines.push('', ' ' + c(`Last task: ${app.runTitle || 'Release'} · ${app.runner.result}`, app.runner.result === 'done' ? 'mint' : 'amber'));
      else lines.push('', ' ' + c('Tip: press / to find any command.', 'muted'));
    }
  }
  return box('Release workspace', lines, width, c, height);
}
function steps(app, width, height, c, frame, now) {
  const lines = [];
  if (height >= 20) lines.push(' ' + c('Choose a stage to inspect and run.', 'muted'), '');
  STAGES.forEach((stage, i) => {
    const selected = app.selection === i;
    const state = stageState(app, stage, frame, now);
    const label = ` ${selected ? '❯' : ' '} ${i + 1}  ${stage.label}`;
    lines.push(selected ? c.selected(label, width - 2) : c(label, state.tone));
    if (height >= 24) lines.push('      ' + c(stage.detail, 'muted'));
  });
  if (height >= 14) {
    const stage = STAGES[app.selection];
    const blocked = app.workspace ? stepBlock(stage.id, app.workspace, app.signedOnly) : 'Reading workspace…';
    lines.push('', ...wrap(blocked || stage.detail, width - 4).map(l => ' ' + c(l, blocked ? 'amber' : 'ice')));
    if (height >= 20) lines.push(' ' + c(blocked ? 'Complete the prerequisite, then refresh with R.' : 'Enter to review this step before running it.', 'muted'));
  }
  return box('Run one step', lines, width, c, height);
}
function artifacts(app, width, height, c) {
  const lines = [];
  if (height >= 16) lines.push(' ' + c('Files in dist/', 'ink', true), ' ' + c('Present = on disk. Verified = SHA-256 matches.', 'muted'), '');
  for (const [i, a] of (app.workspace?.artifacts || []).entries()) {
    const selected = app.artifactIndex === i;
    const tone = a.state === 'verified' ? 'mint' : a.state === 'present' ? 'ice' : a.state === 'mismatch' ? 'red' : 'muted';
    const label = ` ${selected ? '❯' : ' '} ${a.label}`;
    const tail = `${a.state === 'verified' ? '✓' : a.state === 'mismatch' ? '×' : '·'} ${a.state}`;
    const row = splitLine(label, `${tail}  ${a.size || '—'} `, width - 2);
    lines.push(selected ? c.selected(row, width - 2) : splitLine(c(label), c(`${tail}  ${a.size || '—'} `, tone), width - 2));
    if (height >= 23) lines.push('     ' + c(a.path.replace('dist/', ''), 'muted'));
  }
  if (height >= 16 && app.workspace) lines.push('', ' ' + c(`Signed app: ${version(app.workspace.built)}  •  checked ${stamp(app.refreshedAt)}`, 'muted'));
  if (height >= 23) lines.push(' ' + c('Enter shows full path, timestamp, and verification details.', 'muted'));
  return box('Artifacts', lines, width, c, height);
}
function output(app, width, height, c) {
  let top = [];
  if (app.runner.jobs.length && height >= 16) {
    const r = app.runner;
    const title = r.running ? r.cancelled ? 'Stopping task…' : app.runTitle || 'Task running' : r.result === 'done' ? 'Task completed' : r.result === 'failed' ? 'Task failed' : 'Task cancelled';
    top = [' ' + c(title, r.result === 'failed' ? 'red' : r.result === 'done' ? 'mint' : 'ice', true)];
    if (!r.running) top.push(' ' + c(app.preflightReady ? 'P review upload   E save log' : ['failed', 'cancelled'].includes(r.result) ? 'T resume remaining stages   E save log' : 'A inspect artifacts   P publish   E save log', 'muted'));
    top.push(' ' + c('─'.repeat(width - 4), 'line'));
  }
  const logs = logLines(app, width - 2, height - 2 - top.length, c);
  const title = app.logFilter ? `Logs · filter: ${app.logFilter}` : app.scroll ? 'Logs · paused · End to follow' : 'Live output · following';
  return box(title, [...top, ...logs], width, c, height);
}
export function render(app, columns, rows, { color = true, now = Date.now() } = {}) {
  const c = painter(color), width = Math.max(1, columns - 1);
  if (columns < 58 || rows < 20) return [c('HoldThis / release cockpit', 'amber', true), '', 'Resize to at least 58 columns × 20 rows.', `${columns} × ${rows} now. Q or Ctrl+C to quit.`].slice(0, rows).map(l => fit(l, width));
  const frame = Math.floor(now / 90), r = app.runner;
  const live = r.jobs.find(j => j.status === 'running'), done = r.jobs.filter(j => j.status === 'done').length;
  const wide = columns >= 100, sideWidth = 30, mainWidth = wide ? width - sideWidth - 2 : width;
  const height = rows - 9;
  const topRight = app.demo ? c(' DEMO · simulated ', 'amber') : c(' local release ', 'muted');
  let lines = [
    splitLine(' ' + c('▗▖ ▗▖', 'amber') + '  ' + c('HoldThis', 'ink', true) + c(' / release cockpit', 'muted'), topRight, width),
    ' ' + c('▐▙▄▟▌', 'amber') + '  ' + c('Apple Silicon', 'muted') + c('  /  ', 'line') + c(app.signedOnly ? 'signed only' : 'notarize & staple', app.signedOnly ? 'amber' : 'mint'), '',
    splitLine(' ' + ['Workspace', 'Artifacts', 'Logs'].map((label, i) => c(`${i === app.tab ? '●' : '·'} ${label}  `, i === app.tab ? 'amber' : 'muted', i === app.tab)).join(''), c('/ commands  ? help ', 'muted'), width),
  ];
  const main = app.tab === 2 ? output(app, mainWidth, height, c) : app.tab === 1 ? artifacts(app, mainWidth, height, c) : app.screen === 'steps' ? steps(app, mainWidth, height, c, frame, now) : overview(app, mainWidth, height, c);
  if (wide) {
    const side = pipeline(app, sideWidth, height, c, frame, now);
    lines.push(...side.map((line, i) => line + '  ' + main[i]));
  } else lines.push(...main);
  const progressWidth = Math.min(32, width - 26);
  const taskState = r.running ? `${r.cancelled ? 'Stopping' : live?.label || 'Finishing'}  ${duration(now - r.startedAt)}` : r.result ? `${r.result === 'done' ? '✓' : '■'} ${r.result}  ${duration(r.endedAt - r.startedAt)}` : 'No active task';
  const taskTone = r.result === 'failed' ? 'red' : r.result === 'done' ? 'mint' : 'ice';
  lines.push(splitLine(' ' + bar(done, r.jobs.length, progressWidth, c) + '  ' + c(r.jobs.length ? `${done}/${r.jobs.length} stages` : 'Ready', 'muted'), c(columns >= 100 ? taskState + ' ' : r.startedAt ? duration((r.endedAt || now) - r.startedAt) + ' ' : '', taskTone), width));
  const notice = app.notice || (r.running ? taskState : app.refreshing ? 'Reading workspace and verifying checksums…' : app.tab === 2 ? (app.logFilter ? 'Filtered output · Esc clears the filter' : 'Output is retained for this session.') : `Checked ${stamp(app.refreshedAt)} · ${app.demo ? 'All release actions are simulated' : 'R refreshes files and checksums'}`);
  const noticeRows = wrap(notice, width - 2);
  lines.push(...noticeRows.slice(0, 2).map((l, i) => ' ' + c(i === 1 && noticeRows.length > 2 ? fit(l, width - 4).trimEnd() + '…' : l, app.notice ? 'amber' : 'muted')));
  const hints = app.tab === 2 ? '↑↓ scroll  F filter  E save  End follow  Tab views' : app.tab === 1 ? '↑↓ select  Enter details  R refresh  Tab views' : app.screen === 'steps' ? '↑↓ select  Enter review  1–6 step  Esc back' : '↑↓ select  Enter review  Tab views  N mode  Q quit';
  lines.push(' ' + c(hints, 'muted'));
  while (lines.length < rows) lines.push('');
  if (app.modal) {
    const modalWidth = Math.min(78, width - 4), modal = dialog(app, modalWidth, rows - 2, c);
    lines = lines.map(line => c(plain(line), 'line'));
    const top = Math.floor((rows - modal.length) / 2), left = Math.floor((width - modalWidth) / 2);
    modal.forEach((line, i) => { lines[top + i] = ' '.repeat(left) + line; });
  }
  return lines.slice(0, rows).map(l => fit(l, width));
}

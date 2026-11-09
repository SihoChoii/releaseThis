import { STAGES, ARTIFACTS, inspectWorkspace, releaseDefaults, planRelease, stepBlock, publishBlock, nextBuild, sameVersion, demoWorkspace } from './model.js';
import { Runner } from '../tui/runner.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class App {
  constructor({ root, repo = null, demo = false, motion = true, onChange = () => {}, onQuit = () => {}, script }) {
    Object.assign(this, { root, repo, demo, motion, onChange, onQuit });
    this.workspace = null;
    this.refreshing = false;
    this.screen = 'home';
    this.tab = 0;
    this.selection = 0;
    this.signedOnly = false;
    this.scroll = 0;
    this.logFilter = '';
    this.artifactIndex = 0;
    this.modal = null;
    this.notice = '';
    this.preflightReady = false;
    this.runner = new Runner({ root, script: script || `${root}/script/release.sh`, demo, repo, onChange: reason => this.onChange(reason) });
  }

  async refresh() {
    if (this.refreshing || this.runner.running) return;
    this.preflightReady = false;
    this.refreshing = true;
    this.onChange();
    try {
      this.workspace = this.demo ? this.workspace || demoWorkspace() : await inspectWorkspace(this.root);
      this.notice = '';
      this.refreshedAt = Date.now();
    } catch (error) {
      this.notice = `Could not inspect workspace: ${error.message.split('\n')[0]}`;
      this.runner.log(error.message, 'error');
    } finally { this.refreshing = false; this.onChange(); }
  }

  notify(text) { this.notice = text; this.onChange(); }
  confirm(title, lines, action, callback, danger = false) {
    this.modal = { type: 'confirm', title, lines, action, callback, danger, choice: 0, scroll: 0 };
  }

  newRelease() {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    if (!this.workspace) return this.notify('Workspace is not ready. Press R to retry.');
    const defaults = releaseDefaults(this.workspace);
    this.modal = { type: 'release', ...defaults, field: 0, cursor: defaults.version.length, error: '', preset: 0 };
  }

  reviewRelease() {
    const draft = { ...this.modal };
    const { version, build } = draft;
    try {
      const jobs = planRelease(this.workspace.source, version.trim(), build.trim(), this.signedOnly);
      this.confirm('Review release', [
        `Source  ${this.workspace.source.version} (build ${this.workspace.source.build})`,
        `Target  ${version.trim()} (build ${build.trim()})`, '',
        `${jobs.length} stages: ${this.signedOnly ? 'build, sign, ZIP, DMG, checksums' : 'build, sign, notarize, ZIP, DMG, checksums'}`,
        `Notary profile: ${process.env.NOTARY_PROFILE || 'memomo-notary'}`,
        ...(build.trim() === this.workspace.source.build ? ['Build stays the same. Existing users will not receive an update.'] : []),
        ...(this.signedOnly ? ['Signed only: this is not a Gatekeeper-ready release.'] : []),
        '', 'Publishing is a separate action after the build.',
      ], this.demo ? 'Simulate release' : 'Start release', () => this.start(jobs));
      this.modal.back = () => { this.modal = draft; };
    } catch (error) { this.modal.error = error.message; }
  }

  async start(jobs, after, completed = []) {
    if (this.runner.running) return;
    this.preflightReady = false;
    this.modal = null;
    this.tab = 2;
    this.scroll = 0;
    this.notice = '';
    this.logFilter = '';
    this.runSignedOnly = this.signedOnly;
    this.runTitle = jobs.some(j => j.id === 'checksums') && jobs.length > 1 ? 'Release pipeline' : jobs[0].label;
    if (this.workspace?.built) this.runner.demoTag = `v${this.workspace.built.version}+${this.workspace.built.build}`;
    const result = await this.runner.run(jobs, { completed });
    if (this.demo) {
      const finished = this.runner.jobs.filter(j => j.status === 'done' && jobs.some(next => next.id === j.id));
      const versionJob = finished.find(j => j.id === 'version');
      if (versionJob) this.workspace.source = { version: versionJob.args[1], build: versionJob.args.includes('--build') ? versionJob.args.at(-1) : this.workspace.source.build };
      if (finished.some(j => j.id === 'sign')) {
        this.workspace.built = { ...this.workspace.source };
        this.workspace.stapled = false;
      }
      if (finished.some(j => j.id === 'notarize-app')) this.workspace.stapled = true;
    }
    await this.refresh();
    if (['failed', 'cancelled'].includes(result)) this.notify('Completed stages are kept. T reviews remaining stages; E saves the session log.');
    if (result === 'done' && after) after();
    if (result === 'done' && jobs.some(j => j.id === 'checksums')) this.notify(this.signedOnly ? 'Signed archives created. Enable notarization for a public release.' : 'Release packaged. Press P to validate and review publishing.');
    this.onChange();
  }

  selectStep() {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    const stage = STAGES[this.selection];
    if (!this.workspace) return this.notify('Workspace is not ready. Press R to retry.');
    const blocked = stepBlock(stage.id, this.workspace, this.signedOnly);
    if (blocked) return this.notify(blocked);
    const args = [stage.id, ...(this.signedOnly && ['zip', 'dmg'].includes(stage.id) ? ['--signed-only'] : [])];
    this.confirm(stage.label, [stage.detail, '', `./script/release.sh ${args.join(' ')}`], this.demo ? 'Simulate step' : 'Run step', () => this.start([{ ...stage, args }]));
  }

  publish() {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    if (!this.workspace) return this.notify('Workspace is not ready. Press R to retry.');
    const blocked = publishBlock(this.workspace, this.signedOnly);
    if (blocked) return this.notify(blocked);
    if (this.preflightReady) return this.reviewUpload();
    this.confirm('Validate release for publishing', [
      `Built app: ${this.workspace.built.version} (build ${this.workspace.built.build})`,
      ...(!sameVersion(this.workspace.source, this.workspace.built) ? ['Built app differs from source. Publishing ships the built app.'] : []), '',
      './script/release.sh publish --dry-run',
      'Checks archives, Gatekeeper, GitHub tag, and latest build.',
      'Review the output before choosing to upload.',
    ], this.demo ? 'Simulate validation' : 'Validate release', () => this.start([
      { id: 'preflight', label: 'Publish validation', args: ['publish', '--dry-run'] },
    ], () => {
      this.preflightReady = true;
      this.notify('Validation passed. Read the log, then press P to review the upload.');
    }));
  }

  reviewUpload() {
    const built = this.workspace.built;
    this.confirm('Publish to GitHub', [
      `Tag: v${built.version}+${built.build}`,
      `Repo: ${this.repo || 'repo unknown'}`, '',
      ...ARTIFACTS.slice(2).map(([, path]) => path.replace('dist/', '')),
      '', 'Creates a public release and marks it latest.',
      'The release script revalidates the files before upload.',
    ], this.demo ? 'Simulate upload' : 'Publish release', () => this.start([
      { id: 'publish', label: 'Publish release', args: ['publish'] },
    ]), true);
  }

  applyPreset() {
    const m = this.modal, source = this.workspace.source;
    m.preset = ((m.preset ?? 0) + 1) % 5;
    const parts = source.version.split('.').map(BigInt);
    if (m.preset === 0) Object.assign(m, releaseDefaults(this.workspace));
    else if (m.preset === 4) Object.assign(m, source);
    else {
      const index = 3 - m.preset;
      parts[index]++;
      for (let i = index + 1; i < 3; i++) parts[i] = 0n;
      m.version = parts.join('.'); m.build = nextBuild(source.build);
    }
    m.cursor = (m.field === 0 ? m.version : m.build).length;
    m.error = '';
  }

  retry() {
    if (this.runner.running || !['failed', 'cancelled'].includes(this.runner.result)) return this.notify('No interrupted task to resume.');
    const jobs = this.runner.jobs.filter(j => j.status !== 'done').map(({ id, label, args, detail }) => ({ id, label, args, detail }));
    if (!jobs.length) return;
    if (jobs.some(j => ['publish', 'preflight'].includes(j.id))) { this.preflightReady = false; return this.publish(); }
    if (jobs[0].id === 'version') return this.newRelease();
    const signedOnly = this.runSignedOnly;
    const completed = this.runner.jobs.filter(j => j.status === 'done');
    this.confirm('Resume interrupted task', [
      'Completed stages will be kept.',
      `Mode: ${signedOnly ? 'signed only' : 'notarized release'}`, '',
      ...jobs.map(j => `./script/release.sh ${j.args.join(' ')}`),
    ], 'Resume stages', () => { this.signedOnly = signedOnly; this.start(jobs, undefined, completed); });
  }

  inspectArtifact() {
    const artifact = this.workspace?.artifacts[this.artifactIndex];
    if (!artifact) return;
    const explanation = { present: 'Present on disk. Publishing performs signature and Gatekeeper validation.',
      verified: 'SHA-256 matches the corresponding archive.', missing: 'This artifact has not been created.',
      mismatch: 'The checksum does not match the archive. Rebuild the archive and regenerate checksums.' }[artifact.state];
    this.modal = { type: 'info', title: artifact.label, scroll: 0, lines: [
      `Status: ${artifact.state}`, ...(artifact.size ? [`Size: ${artifact.size}`] : []),
      ...(artifact.modifiedAt ? [`Modified: ${new Date(artifact.modifiedAt).toLocaleString()}`] : []),
      '', join(this.root, artifact.path), '', explanation,
    ] };
  }

  async saveLog() {
    if (this.demo) return this.notify('Log export is available in the real workspace. Demo stays read-only.');
    if (!this.runner.logs.length) return this.notify('No log output to save yet.');
    try {
      const dir = join(this.root, 'dist', 'tui-logs');
      const name = `release-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      const contents = this.runner.logs.map(l => `${new Date(l.at).toISOString()} [${l.kind}] ${l.text}`).join('\n') + '\n';
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), contents, { flag: 'wx', mode: 0o600 });
      this.modal = { type: 'info', title: 'Session log saved', scroll: 0, lines: ['Saved the retained session output to:', '', join(dir, name)] };
      this.onChange();
    } catch (error) { this.notify(`Could not save log: ${error.message}`); }
  }

  commands() {
    return [
      { label: 'New release', hint: '1', detail: 'Choose a version and build the full pipeline', run: () => this.newRelease() },
      { label: 'Publish release', hint: 'P', detail: 'Validate artifacts and review the upload', run: () => this.publish() },
      { label: 'Run one pipeline step', hint: '3', run: () => this.showSteps() },
      ...STAGES.map((stage, index) => ({ label: `Step: ${stage.label}`, detail: stage.detail, run: () => { this.selection = index; this.selectStep(); } })),
      { label: 'Show workspace', hint: 'W', run: () => { this.tab = 0; this.screen = 'home'; this.selection = 0; } },
      { label: 'Show artifacts', hint: 'A', run: () => { this.tab = 1; } },
      { label: 'Show live logs', hint: 'L', run: () => { this.tab = 2; } },
      { label: 'Filter log output', hint: 'F', run: () => this.filterLogs() },
      { label: 'Save session log', hint: 'E', run: () => this.saveLog() },
      { label: 'Resume interrupted task', hint: 'T', run: () => this.retry() },
      { label: 'Refresh workspace', hint: 'R', run: () => this.refresh() },
      { label: 'Toggle notarization', hint: 'N', run: () => this.toggleMode() },
      { label: 'Toggle animations', hint: 'M', run: () => { this.motion = !this.motion; } },
      { label: 'Keyboard help', hint: '?', run: () => { this.modal = { type: 'help', scroll: 0 }; } },
    ];
  }
  filteredCommands() {
    const words = (this.modal?.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const inLabel = cmd => words.every(word => cmd.label.toLowerCase().includes(word));
    return this.commands().filter(cmd => words.every(word => `${cmd.label} ${cmd.detail || ''}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(inLabel(b)) - Number(inLabel(a)));
  }
  filterLogs() { this.tab = 2; this.modal = { type: 'filter', query: this.logFilter }; }
  showSteps() { this.screen = 'steps'; this.tab = 0; this.selection = 0; }
  toggleMode() { if (this.runner.running) return this.notify('Release mode is locked while a task runs.'); this.signedOnly = !this.signedOnly; this.preflightReady = false; }
  requestQuit() {
    if (this.runner.running) this.confirm('Cancel active task?', ['Stops the active release process and its children.', 'Completed artifacts and version edits remain on disk.'], 'Stop task', () => this.runner.cancel(), true);
    else this.onQuit();
  }

  handleModal(text, key) {
    const m = this.modal;
    if (key.name === 'escape') { this.modal = null; m.back?.(); return; }
    if (['confirm', 'info', 'help'].includes(m.type)) {
      if (['down', 'pageup', 'up', 'pagedown'].includes(key.name)) m.scroll = Math.max(0, (m.scroll || 0) + (['up', 'pageup'].includes(key.name) ? -1 : 1) * (key.name.startsWith('page') ? 5 : 1));
      if (key.name === 'home') m.scroll = 0;
      if (key.name === 'end') m.scroll = Number.MAX_SAFE_INTEGER;
    }
    if (m.type === 'info') { if (key.name === 'return') this.modal = null; return; }
    if (m.type === 'help') { if (key.name === 'return' || text === '?') this.modal = null; return; }
    if (m.type === 'confirm') {
      if (['left', 'right', 'tab'].includes(key.name)) m.choice = 1 - m.choice;
      if (key.name === 'return') { this.modal = null; if (m.choice === 1) m.callback(); }
      return;
    }
    if (m.type === 'filter') {
      if (key.name === 'return') { this.logFilter = m.query; this.scroll = 0; this.modal = null; }
      else if (key.name === 'backspace') m.query = m.query.slice(0, -1);
      else if (key.ctrl && key.name === 'u') m.query = '';
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) m.query = (m.query + text).slice(0, 80);
      return;
    }
    if (m.type === 'palette') {
      const count = this.filteredCommands().length;
      if (key.name === 'up') m.index = (m.index - 1 + Math.max(1, count)) % Math.max(1, count);
      else if (key.name === 'down') m.index = (m.index + 1) % Math.max(1, count);
      else if (key.name === 'home') m.index = 0;
      else if (key.name === 'end') m.index = Math.max(0, count - 1);
      else if (key.ctrl && key.name === 'u') { m.query = ''; m.index = 0; }
      else if (key.name === 'return') { const cmd = this.filteredCommands()[m.index]; this.modal = null; cmd?.run(); }
      else if (key.name === 'backspace') { m.query = m.query.slice(0, -1); m.index = 0; }
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) { m.query = (m.query + text).slice(0, 50); m.index = 0; }
      return;
    }
    if (m.type === 'release') {
      if (key.name === 'f2') return this.applyPreset();
      const field = m.field === 0 ? 'version' : 'build';
      const moveField = next => { m.field = (next + 3) % 3; m.cursor = (m.field === 0 ? m.version : m.build).length; };
      if (key.name === 'tab') return moveField(m.field + (key.shift ? -1 : 1));
      if (key.name === 'return') return m.field === 2 ? this.reviewRelease() : moveField(m.field + 1);
      if (key.name === 'up') return moveField(m.field - 1);
      if (key.name === 'down') return moveField(m.field + 1);
      if (m.field === 2) return;
      m.error = '';
      if (key.ctrl && key.name === 'u') { m[field] = ''; m.cursor = 0; m.preset = -1; }
      else if (key.name === 'left') m.cursor = Math.max(0, m.cursor - 1);
      else if (key.name === 'right') m.cursor = Math.min(m[field].length, m.cursor + 1);
      else if (key.name === 'home') m.cursor = 0;
      else if (key.name === 'end') m.cursor = m[field].length;
      else if (key.name === 'backspace' && m.cursor > 0) { m[field] = m[field].slice(0, m.cursor - 1) + m[field].slice(m.cursor); m.cursor--; m.preset = -1; }
      else if (key.name === 'delete') { m[field] = m[field].slice(0, m.cursor) + m[field].slice(m.cursor + 1); m.preset = -1; }
      else if (!key.ctrl && !key.meta && text && /^[\d.]+$/.test(text) && m[field].length + text.length <= 40) { m[field] = m[field].slice(0, m.cursor) + text + m[field].slice(m.cursor); m.cursor += text.length; m.preset = -1; }
    }
  }

  key(text = '', key = {}) {
    if (!this.modal) text = text.toLowerCase();
    if (key.ctrl && key.name === 'c') { this.modal = null; this.requestQuit(); }
    else if (this.modal) this.handleModal(text, key);
    else if (text === 'q') this.requestQuit();
    else if (key.name === 'escape') {
      if (this.tab === 2 && this.logFilter) { this.logFilter = ''; this.scroll = 0; }
      else { this.screen = 'home'; this.tab = 0; this.selection = 0; }
    }
    else if (text === '?') this.modal = { type: 'help', scroll: 0 };
    else if (text === 'm') this.motion = !this.motion;
    else if (text === '/' || key.ctrl && key.name === 'p') this.modal = { type: 'palette', query: '', index: 0 };
    else if (key.name === 'tab') this.tab = (this.tab + (key.shift ? 2 : 1)) % 3;
    else if (text === 'w') { this.tab = 0; this.screen = 'home'; this.selection = 0; }
    else if (text === 'a') this.tab = 1;
    else if (text === 'l') this.tab = 2;
    else if (text === 'f') this.filterLogs();
    else if (text === 'e') this.saveLog();
    else if (this.tab === 2 && ['pageup', 'pagedown', 'home', 'end', 'up', 'down'].includes(key.name) || this.tab === 2 && ['j', 'k'].includes(text)) {
      if (key.name === 'home') this.scroll = Number.MAX_SAFE_INTEGER;
      else if (key.name === 'end') this.scroll = 0;
      else this.scroll = Math.max(0, this.scroll + (['up', 'pageup'].includes(key.name) || text === 'k' ? 1 : -1) * (key.name?.startsWith('page') ? 8 : 1));
    }
    else if (['up', 'down'].includes(key.name) || ['j', 'k'].includes(text)) {
      const direction = key.name === 'up' || text === 'k' ? -1 : 1;
      if (this.tab === 1) this.artifactIndex = (this.artifactIndex + direction + 6) % 6;
      else {
        const count = this.screen === 'steps' ? 6 : 3;
        this.selection = (this.selection + direction + count) % count;
      }
    }
    else if (key.name === 'return' && this.tab === 1) this.inspectArtifact();
    else if (!this.runner.running) {
      if (text === 'n') this.toggleMode();
      else if (text === 'r') this.refresh();
      else if (text === 't') this.retry();
      else if (this.screen === 'steps' && this.tab === 0 && /^[1-6]$/.test(text)) { this.selection = Number(text) - 1; this.selectStep(); }
      else if (text === '1') this.newRelease();
      else if (text === '2' || text === 'p') this.publish();
      else if (text === '3') this.showSteps();
      else if (key.name === 'return' && this.tab === 0) {
        if (this.screen === 'steps') this.selectStep();
        else [() => this.newRelease(), () => this.publish(), () => this.showSteps()][this.selection]();
      }
    }
    this.onChange();
  }
}

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Runner } from '../tui/runner.js';
import { assertProfileBindings, factsFromWorkspace, materialize, openingParams, project, resolvePlan } from '../workflow/model.js';

export class App {
  constructor({ root, repo = null, demo = false, motion = true, onChange = () => {}, onQuit = () => {}, script, profile }) {
    if (!profile) throw new Error('A profile is required.');
    assertProfileBindings(profile);
    Object.assign(this, { root, repo, demo, motion, onChange, onQuit, profile });
    this.facts = null;
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
    this.runner = new Runner({
      root,
      script: script || (profile.script ? join(root, profile.script) : ''),
      demo,
      repo,
      onChange: reason => this.onChange(reason),
    });
  }

  get workspace() { return project(this.facts); }
  set workspace(value) { this.facts = value ? factsFromWorkspace(this.profile, value) : null; }

  mode() { return { signedOnly: this.signedOnly }; }
  context(params = {}) {
    return {
      facts: this.facts,
      params,
      mode: this.mode(),
      demo: this.demo,
      repo: this.repo,
      env: process.env,
      root: this.root,
      preflightReady: this.preflightReady,
      commandLine: args => this.profile.commandLine(args),
    };
  }
  formPlan() { return Object.values(this.profile.plans).find(plan => plan.kind === 'form'); }
  activeFormPlan(modal = this.modal) {
    const plan = modal?.planId ? this.profile.plans[modal.planId] : null;
    return plan?.kind === 'form' ? plan : this.formPlan();
  }
  gatedPlan() { return Object.values(this.profile.plans).find(plan => plan.kind === 'gated'); }
  homeActions() { return this.profile.actions.filter(action => action.home); }

  canContinue(plan) {
    const session = this.runner.session;
    return this.runner.result === 'paused' && !!session && session.valid !== false &&
      (!plan || session.planId === plan.id) && session.mode?.signedOnly === this.signedOnly;
  }
  get preflightReady() {
    const plan = this.gatedPlan();
    return !!plan && this.canContinue(plan) && this.runner.jobs.some(job => job.status === 'done');
  }
  invalidatePlan() { if (this.runner.session) this.runner.session.valid = false; }

  async refresh({ keepPlan = false } = {}) {
    if (this.refreshing || this.runner.running) return;
    if (!keepPlan) this.invalidatePlan();
    this.refreshing = true;
    this.onChange();
    try {
      this.facts = this.demo ? this.facts || this.profile.demoFacts() : await this.profile.inspect(this.root);
      const problems = this.profile.problems?.filter(Boolean) || [];
      this.notice = problems.length ? problems.join(' ') : '';
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

  newRelease() { return this.openForm(this.formPlan()); }
  openRun(plan) {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    if (!plan) return;
    if (!this.facts) return this.notify('Workspace is not ready. Press R to retry.');
    if (this.canContinue(plan)) return this.continuePlan();
    const blocked = plan.blocked?.(this.context()) || '';
    if (blocked) return this.notify(blocked);
    try {
      const jobs = resolvePlan(plan, this.context());
      if (!jobs.length) return this.notify('Nothing to run.');
      const review = plan.review(this.context(), jobs);
      this.confirm(review.title, review.lines, review.accept, () => this.start(jobs, undefined, [], {
        planId: plan.id, params: {}, resume: plan.resume || null,
      }));
    } catch (error) { this.notify(error.message); }
  }
  openForm(plan) {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    if (!plan) return;
    if (!this.facts) return this.notify('Workspace is not ready. Press R to retry.');
    if (this.canContinue(plan)) return this.continuePlan();
    const defaults = openingParams(plan, this.facts);
    const first = plan.fields[0];
    this.modal = { type: 'release', planId: plan.id, ...defaults, field: 0, cursor: String(defaults[first.name] ?? '').length, error: '', preset: 0 };
  }

  reviewRelease() {
    const draft = { ...this.modal };
    const plan = this.activeFormPlan(draft);
    const params = {};
    for (const field of plan.fields) params[field.name] = String(draft[field.name] ?? '').trim();
    const ctx = this.context(params);
    try {
      const jobs = resolvePlan(plan, ctx);
      if (!jobs.length) {
        this.modal.error = 'Nothing to run.';
        return this.notify('Nothing to run.');
      }
      const review = plan.review(ctx, jobs);
      this.confirm(review.title, review.lines, review.accept, () => this.start(jobs, undefined, [], {
        planId: plan.id, params, resume: plan.resume || null,
      }));
      this.modal.back = () => { this.modal = draft; };
    } catch (error) { this.modal.error = error.message; }
  }

  async start(jobs, after, completed = [], session = null) {
    if (this.runner.running) return;
    if (!jobs.length) return this.notify('Nothing to run.');
    this.modal = null;
    this.tab = 2;
    this.scroll = 0;
    this.notice = '';
    this.logFilter = '';
    this.runSignedOnly = this.signedOnly;
    const plan = session?.planId ? this.profile.plans[session.planId] : null;
    this.runTitle = plan?.title && jobs.length > 1 ? plan.title : jobs[0].label;
    if (this.facts) {
      const tag = this.profile.demoTag?.(this.facts);
      if (tag) this.runner.demoTag = tag;
    }
    const recorded = { ...session, params: session?.params || {}, mode: this.mode(), valid: true };
    const result = await this.runner.run(jobs, { completed, session: recorded });
    if (this.demo) {
      const finished = this.runner.jobs.slice(completed.length).filter(job => job.status === 'done');
      for (const job of finished) job.applyDemo?.(this.facts, { job });
    }
    await this.refresh({ keepPlan: true });
    if (['failed', 'cancelled'].includes(result)) this.notify('Completed stages are kept. T reviews remaining stages; E saves the session log.');
    if (result === 'paused') {
      if (this.runner.pause.reason === 'after') this.notify(this.runner.pause.notice || 'Step passed. Read the log, then press T to continue.');
      else this.continuePlan();
    }
    if (result === 'done' && after) after();
    if (result === 'done') {
      let notice = '';
      for (const job of this.runner.jobs) {
        const message = job.onDone?.(this.context(recorded.params));
        if (message) notice = message;
      }
      if (notice) this.notify(notice);
    }
    this.onChange();
    return result;
  }

  selectStep() {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    const task = this.profile.catalog[this.selection];
    if (!task) return;
    if (!this.facts) return this.notify('Workspace is not ready. Press R to retry.');
    const skipped = task.skip?.(this.mode()) || '';
    if (skipped) return this.notify(skipped);
    const blocked = task.requires?.(this.context()) || '';
    if (blocked) return this.notify(blocked);
    try {
      const job = materialize(task, this.context());
      this.confirm(task.label, [task.detail, '', job.display], this.demo ? 'Simulate step' : 'Run step', () => this.start([job]));
    } catch (error) { this.notify(error.message); }
  }

  publish() { return this.openGated(this.gatedPlan()); }
  openGated(plan) {
    if (this.runner.running) return this.notify('Wait for the active task, or cancel it with Ctrl+C.');
    if (!plan) return;
    if (!this.facts) return this.notify('Workspace is not ready. Press R to retry.');
    const blocked = plan.blocked(this.context());
    if (blocked) return this.notify(blocked);
    if (this.canContinue(plan)) return this.continuePlan();
    try {
      const ctx = this.context();
      const jobs = resolvePlan(plan, ctx);
      if (!jobs.length) return this.notify('Nothing to run.');
      const gate = plan.confirmStart(ctx);
      this.confirm(gate.title, gate.lines, gate.accept, () => this.start(jobs, undefined, [], {
        planId: plan.id, params: {}, resume: plan.resume || null,
      }), !!gate.danger);
    } catch (error) { this.notify(error.message); }
  }

  continuePlan() {
    const session = this.runner.session;
    const plan = this.profile.plans[session?.planId];
    if (!this.canContinue()) {
      if (plan?.kind === 'gated') return this.openGated(plan);
      if (plan?.kind === 'form') return this.openForm(plan);
      if (plan?.kind === 'run') return this.openRun(plan);
      return this.notify('This plan needs to be started again.');
    }
    const completed = this.runner.jobs.filter(job => job.status === 'done');
    const jobs = this.runner.jobs.filter(job => job.status !== 'done');
    const next = jobs[0];
    if (!next) return this.notify('Nothing to run.');
    if (next.confirm && !next.confirmed) {
      try {
        const gate = next.confirm(this.context(session.params));
        this.confirm(gate.title, gate.lines, gate.accept, () => {
          // A refresh, a mode change, or a different run invalidates this review.
          if (this.runner.session !== session || !this.canContinue()) return this.notify('This plan needs to be reviewed again.');
          return this.start([{ ...next, confirmed: true }, ...jobs.slice(1)], undefined, completed, session);
        }, !!gate.danger);
      } catch (error) { this.notify(error.message); }
      return;
    }
    return this.start(jobs, undefined, completed, session);
  }

  applyPreset() {
    const plan = this.activeFormPlan();
    const modal = this.modal;
    modal.preset = ((modal.preset ?? 0) + 1) % plan.presets.length;
    const next = plan.presets[modal.preset].apply(this.facts) || {};
    for (const field of plan.fields) if (Object.hasOwn(next, field.name)) modal[field.name] = next[field.name];
    const field = plan.fields[modal.field] || plan.fields[0];
    modal.cursor = String(modal[field.name] ?? '').length;
    modal.error = '';
  }

  retry() {
    if (this.runner.result === 'paused') return this.continuePlan();
    if (this.runner.running || !['failed', 'cancelled'].includes(this.runner.result)) return this.notify('No interrupted task to resume.');
    const jobs = this.runner.jobs.filter(job => job.status !== 'done').map(job => ({
      id: job.id, label: job.label, args: job.args, ...(job.command ? { command: job.command } : {}),
      detail: job.detail, display: job.display,
      demo: job.demo, applyDemo: job.applyDemo, onDone: job.onDone, resume: job.resume,
      confirm: job.confirm, after: job.after, pauseNotice: job.pauseNotice,
    }));
    if (!jobs.length) return;
    const session = this.runner.session;
    const plan = session?.planId ? this.profile.plans[session.planId] : null;
    if (plan?.resume === 'revalidate' || session?.resume === 'revalidate') {
      this.invalidatePlan();
      return this.openGated(plan);
    }
    if (jobs[0].resume === 'reopen-form') return this.openForm(plan || this.formPlan());
    const signedOnly = this.runSignedOnly;
    const completed = this.runner.jobs.filter(job => job.status === 'done');
    const mode = this.profile.mode;
    this.confirm('Resume interrupted task', [
      'Completed stages are kept.',
      ...(mode ? [`Mode: ${signedOnly ? mode.resume.on : mode.resume.off}`, ''] : ['']),
      ...jobs.map(job => job.display || this.profile.commandLine?.(job.args) || (job.args || []).join(' ')),
    ], 'Resume stages', () => {
      this.signedOnly = signedOnly;
      return this.start(jobs, undefined, completed, session ? { ...session, resume: session.resume || null } : null);
    });
  }

  inspectArtifact() {
    const artifact = this.workspace?.artifacts[this.artifactIndex];
    if (!artifact) return;
    this.modal = { type: 'info', title: artifact.label, scroll: 0, lines: [
      `Status: ${artifact.state}`, ...(artifact.size ? [`Size: ${artifact.size}`] : []),
      ...(artifact.modifiedAt ? [`Modified: ${new Date(artifact.modifiedAt).toLocaleString()}`] : []),
      '', join(this.root, artifact.path), '', artifact.explain?.[artifact.state] || '',
    ] };
  }

  async saveLog() {
    if (this.demo) return this.notify('Log export is available in the real workspace. Demo stays read-only.');
    if (!this.runner.logs.length) return this.notify('No log output to save yet.');
    try {
      const dir = join(this.root, 'dist', 'tui-logs');
      const name = `release-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      const contents = this.runner.logs.map(line => `${new Date(line.at).toISOString()} [${line.kind}] ${line.text}`).join('\n') + '\n';
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), contents, { flag: 'wx', mode: 0o600 });
      this.modal = { type: 'info', title: 'Session log saved', scroll: 0, lines: ['Saved the retained session output to:', '', join(dir, name)] };
      this.onChange();
    } catch (error) { this.notify(`Could not save log: ${error.message}`); }
  }

  runAction(action) {
    if (!action) return;
    if (action.toggle) return this.toggleMode();
    if (action.screen === 'steps') return this.showSteps();
    if (action.plan) {
      const plan = this.profile.plans[action.plan];
      if (!plan) return;
      if (plan.kind === 'form') return this.openForm(plan);
      if (plan.kind === 'gated') return this.openGated(plan);
      if (plan.kind === 'run') return this.openRun(plan);
    }
  }

  commands() {
    const home = this.homeActions();
    const mode = this.profile.actions.find(action => action.toggle);
    return [
      ...home.map(action => ({
        label: action.palette, hint: action.paletteHint, detail: action.paletteDetail, run: () => this.runAction(action),
      })),
      ...this.profile.catalog.map((task, index) => ({
        label: `Step: ${task.label}`, detail: task.detail, run: () => { this.selection = index; this.selectStep(); },
      })),
      { label: 'Show workspace', hint: 'W', run: () => { this.tab = 0; this.screen = 'home'; this.selection = 0; } },
      { label: 'Show artifacts', hint: 'A', run: () => { this.tab = 1; } },
      { label: 'Show live logs', hint: 'L', run: () => { this.tab = 2; } },
      { label: 'Filter log output', hint: 'F', run: () => this.filterLogs() },
      { label: 'Save session log', hint: 'E', run: () => this.saveLog() },
      { label: this.runner.result === 'paused' ? 'Continue paused plan' : 'Resume interrupted task', hint: 'T', run: () => this.retry() },
      { label: 'Refresh workspace', hint: 'R', run: () => this.refresh() },
      ...(mode ? [{ label: mode.palette, hint: mode.paletteHint, detail: mode.paletteDetail, run: () => this.runAction(mode) }] : []),
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
  helpLines() {
    const entries = [
      ['Navigate', '↑ ↓ or J K', 'Move through actions, artifacts, or steps'],
      ['Navigate', 'Enter', 'Review action / inspect artifact'],
      ['Navigate', 'Tab / Shift+Tab', 'Next / previous view'],
      ['Navigate', 'W / A / L', 'Workspace / artifacts / logs'],
      ['Navigate', '/ or Ctrl+P', 'Search all commands'],
      ...this.profile.actions.filter(action => action.help).map(action => ['Release', action.helpKey, action.help]),
      ['Release', 'F2', 'Cycle version presets in the editor'],
      ['Release', 'T', 'Continue a paused plan / review remaining stages'],
      ['Release', 'R', 'Refresh files and checksums'],
      ['Logs', 'F', 'Filter output (Esc clears the filter)'],
      ['Logs', 'E', 'Save retained output to dist/tui-logs/'],
      ['Logs', 'PgUp / PgDn', 'Scroll a page'],
      ['Logs', 'Home / End', 'Oldest output / follow live output'],
      ['Session', 'M', 'Toggle animations'],
      ['Session', 'Ctrl+C', 'Stop active task / quit when idle'],
      ['Session', 'Esc', 'Back / close dialog'],
      ['Session', 'Q', 'Quit (reviews cancellation while running)'],
    ];
    const lines = [];
    let group = '';
    for (const [name, key, text] of entries) {
      if (name !== group) { if (group) lines.push(''); lines.push(name); group = name; }
      lines.push(`${key.padEnd(14)}${text}`);
    }
    return lines;
  }
  hintLine() {
    const fragments = [
      { surface: 'home', order: 0, text: '↑↓ select' },
      { surface: 'home', order: 1, text: 'Enter review' },
      { surface: 'home', order: 2, text: 'Tab views' },
      { surface: 'home', order: 4, text: 'Q quit' },
      { surface: 'steps', order: 0, text: '↑↓ select' },
      { surface: 'steps', order: 1, text: 'Enter review' },
      { surface: 'steps', order: 2, text: `1–${this.profile.catalog.length} step` },
      { surface: 'steps', order: 3, text: 'Esc back' },
      { surface: 'artifacts', order: 0, text: '↑↓ select' },
      { surface: 'artifacts', order: 1, text: 'Enter details' },
      { surface: 'artifacts', order: 2, text: 'R refresh' },
      { surface: 'artifacts', order: 3, text: 'Tab views' },
      { surface: 'logs', order: 0, text: '↑↓ scroll' },
      { surface: 'logs', order: 1, text: 'F filter' },
      { surface: 'logs', order: 2, text: 'E save' },
      { surface: 'logs', order: 3, text: 'End follow' },
      { surface: 'logs', order: 4, text: 'Tab views' },
    ];
    if (this.runner.result === 'paused') fragments.push({ surface: 'logs', order: 5, text: 'T continue' });
    for (const action of this.profile.actions) {
      if (!action.hint) continue;
      for (const [surface, order] of Object.entries(action.hintOrder || {})) fragments.push({ surface, order, text: action.hint });
    }
    const surface = this.tab === 2 ? 'logs' : this.tab === 1 ? 'artifacts' : this.screen === 'steps' ? 'steps' : 'home';
    return fragments.filter(item => item.surface === surface).sort((a, b) => a.order - b.order).map(item => item.text).join('  ');
  }
  filterLogs() { this.tab = 2; this.modal = { type: 'filter', query: this.logFilter }; }
  showSteps() { this.screen = 'steps'; this.tab = 0; this.selection = 0; }
  toggleMode() {
    if (this.runner.running) return this.notify('Release mode is locked while a task runs.');
    this.signedOnly = !this.signedOnly;
    this.invalidatePlan();
  }
  requestQuit() {
    if (this.runner.running) this.confirm('Cancel active task?', ['Stops the active release process and its children.', 'Completed artifacts and version edits remain on disk.'], 'Stop task', () => this.runner.cancel(), true);
    else this.onQuit();
  }
  actionFor(text) {
    return this.profile.actions.find(action => action.bindings?.some(binding => binding.key === text));
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
      const fields = this.activeFormPlan().fields;
      const count = fields.length + 1;
      const moveField = next => {
        m.field = (next % count + count) % count;
        const descriptor = fields[m.field];
        if (descriptor) m.cursor = String(m[descriptor.name] ?? '').length;
      };
      if (key.name === 'tab') return moveField(m.field + (key.shift ? -1 : 1));
      if (key.name === 'return') return m.field === fields.length ? this.reviewRelease() : moveField(m.field + 1);
      if (key.name === 'up') return moveField(m.field - 1);
      if (key.name === 'down') return moveField(m.field + 1);
      const descriptor = fields[m.field];
      if (!descriptor) return;
      const name = descriptor.name;
      const value = () => String(m[name] ?? '');
      m.error = '';
      if (key.ctrl && key.name === 'u') { m[name] = ''; m.cursor = 0; m.preset = -1; }
      else if (key.name === 'left') m.cursor = Math.max(0, m.cursor - 1);
      else if (key.name === 'right') m.cursor = Math.min(value().length, m.cursor + 1);
      else if (key.name === 'home') m.cursor = 0;
      else if (key.name === 'end') m.cursor = value().length;
      else if (key.name === 'backspace' && m.cursor > 0) { m[name] = value().slice(0, m.cursor - 1) + value().slice(m.cursor); m.cursor--; m.preset = -1; }
      else if (key.name === 'delete') { m[name] = value().slice(0, m.cursor) + value().slice(m.cursor + 1); m.preset = -1; }
      else if (!key.ctrl && !key.meta && text && /^[\d.]+$/.test(text) && value().length + text.length <= 40) { m[name] = value().slice(0, m.cursor) + text + value().slice(m.cursor); m.cursor += text.length; m.preset = -1; }
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
      if (this.tab === 1) {
        const count = this.profile.artifacts.length;
        if (count) this.artifactIndex = (this.artifactIndex + direction + count) % count;
      } else {
        const count = this.screen === 'steps' ? this.profile.catalog.length : this.homeActions().length;
        if (count) this.selection = (this.selection + direction + count) % count;
      }
    }
    else if (key.name === 'return' && this.tab === 1) this.inspectArtifact();
    else if (!this.runner.running) {
      const stepIndex = this.screen === 'steps' && this.tab === 0 && /^[1-9]$/.test(text) ? Number(text) - 1 : -1;
      if (stepIndex >= 0 && stepIndex < this.profile.catalog.length) { this.selection = stepIndex; this.selectStep(); }
      else if (text === 'r') this.refresh();
      else if (text === 't') this.retry();
      else if (this.actionFor(text)) this.runAction(this.actionFor(text));
      else if (key.name === 'return' && this.tab === 0) {
        if (this.screen === 'steps') this.selectStep();
        else this.runAction(this.homeActions()[this.selection]);
      }
    }
    this.onChange();
  }
}

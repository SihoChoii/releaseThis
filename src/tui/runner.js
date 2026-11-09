import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { cleanOutput } from './terminal.js';

export { cleanOutput };

export class Runner {
  constructor({ root, script, onChange = () => {}, demo = false, repo = null, env = process.env }) {
    Object.assign(this, { root, script, onChange, demo, repo, env });
    this.logs = [];
    this.jobs = [];
    this.running = false;
    this.cancelled = false;
    this.child = null;
    this.result = null;
    this.logRevision = 0;
    this.statusSlot = null;
  }

  log(text, kind = 'output') {
    for (const line of cleanOutput(text).split(/\r\n|[\r\n]/)) {
      this.logs.push({ id: ++this.logRevision, text: line.slice(0, 4000), kind, at: Date.now(), runStartedAt: this.startedAt });
    }
    if (this.logs.length > 2500) this.logs.splice(0, this.logs.length - 2500);
    this.onChange('log');
  }

  // Latest visible snapshot. Omitted fields clear. An unchanged snapshot does not notify.
  status(patch) {
    const source = patch ?? {};
    const next = {
      phase: source.phase ?? null,
      detail: source.detail ?? null,
      progress: source.progress ?? null,
      completed: source.completed ?? null,
      total: source.total ?? null,
    };
    const slot = this.statusSlot;
    if (slot && slot.phase === next.phase && slot.detail === next.detail && slot.progress === next.progress && slot.completed === next.completed && slot.total === next.total) return;
    this.statusSlot = { ...next, heartbeatAt: Date.now() };
    this.onChange('status');
  }

  async run(jobs, { completed = [] } = {}) {
    if (this.running) throw new Error('A release task is already running.');
    this.jobs = [...completed.map(job => ({ ...job })), ...jobs.map(job => ({ ...job, status: 'pending' }))];
    this.running = true;
    this.cancelled = false;
    this.result = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.log(this.demo ? 'Demo session · release actions are simulated.' : 'Starting release task.', 'notice');
    this.onChange('chrome');
    try {
      for (const job of this.jobs) {
        if (job.status === 'done') continue;
        if (this.cancelled) break;
        job.status = 'running';
        job.startedAt = Date.now();
        this.log(`$ ./script/release.sh ${job.args.join(' ')}`, 'command');
        const code = this.demo ? await this.simulate(job) : await this.execute(job);
        job.endedAt = Date.now();
        job.status = this.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
        this.onChange('chrome');
        if (code !== 0 || this.cancelled) {
          this.result = this.cancelled ? 'cancelled' : 'failed';
          this.log(this.cancelled ? 'Task cancelled. Completed steps remain on disk.' : `${job.label} exited with code ${code}. Fix the error above, then rerun this step.`, 'error');
          break;
        }
        this.log(`${job.label} completed.`, 'success');
      }
      this.result ||= this.cancelled ? 'cancelled' : 'done';
      return this.result;
    } catch (error) {
      const active = this.jobs.find(j => j.status === 'running');
      if (active) active.status = 'failed';
      this.result = 'failed';
      this.log(error.message, 'error');
      return this.result;
    } finally {
      this.running = false;
      this.endedAt = Date.now();
      this.onChange('chrome');
    }
  }

  execute(job) {
    return new Promise(resolve => {
      const child = spawn(this.script, job.args, { cwd: this.root, env: { ...this.env, NO_COLOR: '1', TERM: 'dumb' },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        const consume = value => {
          buffer += value;
          const lines = buffer.split(/\r\n|[\r\n]/);
          buffer = lines.pop();
          for (const line of lines) if (line) this.log(line);
          if (buffer.length > 8000) { this.log(buffer.slice(0, 4000)); buffer = buffer.slice(-4000); }
        };
        stream.on('data', chunk => consume(decoder.write(chunk)));
        stream.on('end', () => { consume(decoder.end()); if (buffer) this.log(buffer); });
      }
      child.on('error', error => this.log(error.message, 'error'));
      child.on('close', async (code, signal) => {
        await child.cancelPromise;
        if (this.child === child) this.child = null;
        if (signal && !this.cancelled) this.log(`Process stopped by ${signal}.`, 'error');
        resolve(code ?? 1);
      });
    });
  }

  cancel() {
    this.cancelled = true;
    const child = this.child;
    if (child && !child.cancelPromise) {
      const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
      // Keep supervising the group even if the shell exits before its children.
      child.cancelPromise = (async () => {
        kill('SIGTERM');
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(-child.pid, 0); } catch { return; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        kill('SIGKILL');
      })();
    }
    this.onChange('chrome');
  }

  async simulate(job) {
    const messages = {
      build: ['Compiling HoldThis for arm64…', '[1/3] Compile Swift sources', '[2/3] Link HoldThis', '[3/3] Stage resources and app icon'],
      sign: ['Signing holdthis-remux', 'Signing HoldThis.app with Developer ID', 'Verifying hardened runtime'],
      'notarize-app': ['Submitting app to Apple…', 'Waiting for Apple notarization…', 'Accepted. Stapling ticket.'],
      zip: ['Creating updater ZIP', 'Verifying archive and app signature'],
      dmg: ['Composing illustrated installer', 'Signing and notarizing disk image'],
      checksums: ['SHA-256: updater ZIP verified', 'SHA-256: installer DMG verified'],
      preflight: [`Tag: ${this.demoTag || 'v1.0.2+3'}`, `Repo: ${this.repo || 'repo unknown'}`, 'Files: installer DMG, updater ZIP, two SHA-256 files'],
      publish: ['Simulating GitHub upload', 'Simulating release digest verification'],
    };
    for (const text of messages[job.id] || ['Version updated (simulation)']) {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (this.cancelled) return 1;
      this.log(text);
    }
    return 0;
  }
}

// Load a repo profile from releasethis.config.js. The cockpit renders the compiled profile.

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProfileBindings, factStore, fieldTypes, materialize } from './model.js';
import { checksumProbe, fileProbe, refreshFacts } from './refresh.js';

export const PROFILE_FILE = 'releasethis.config.js';

const MISSING_PROFILE = `Add ${PROFILE_FILE} to describe this repo's release.`;

const defaultCopy = {
  refreshing: 'Reading workspace…',
  checked: 'R refreshes files',
  demoIdle: 'All release actions are simulated',
  intro: 'Ready.',
  aligned: 'Review the artifacts, then run a plan.',
  drifted: 'Source has changed.',
  publishReady: 'Publish when ready.',
  files: 'Files',
  legend: 'Present = on disk.',
  artifactHint: 'Enter shows the full path.',
  stepsIntro: 'Choose a step to inspect and run.',
  stepsReady: 'Enter to review this step before running it.',
  stepsBlocked: 'Complete the prerequisite, then refresh with R.',
  tip: 'Tip: press / to find any command.',
};

const artifactExplain = {
  present: 'Present on disk.',
  verified: 'Checksum matches.',
  missing: 'This artifact has not been created.',
  mismatch: 'The checksum does not match the archive.',
};

const fieldMessages = {
  semver: label => `Use major.minor.patch for ${label}.`,
  integer: label => `${label} must be a positive integer.`,
};

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

function relativeInside(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return false;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.includes('..')) return false;
  const normalized = normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('../')) return false;
  return true;
}

function fillArg(part, params) {
  const values = params || {};
  return String(part).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (!Object.hasOwn(values, name) || values[name] == null) {
      throw new Error(`Missing parameter "${name}". Open a form plan to supply it.`);
    }
    return String(values[name]);
  });
}

function list(value, label, problem) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  problem(`${label} must be a list.`);
  return [];
}

function artifactFact(desc, extra = {}) {
  return {
    key: desc.key,
    role: 'artifact',
    kind: desc.kind,
    label: desc.label,
    path: desc.path,
    short: desc.path,
    state: 'missing',
    size: '',
    modifiedAt: null,
    gatesPublish: !!desc.gatesPublish,
    archive: desc.archive || null,
    explain: artifactExplain,
    provenance: { source: 'probe', id: desc.key },
    ...extra,
  };
}

function artifactProbes(descriptions) {
  const byKey = new Map(descriptions.map(desc => [desc.key, desc]));
  return descriptions.map(desc => desc.kind === 'checksum'
    ? checksumProbe(desc, byKey.get(desc.archive), artifactFact)
    : fileProbe(desc, artifactFact));
}

export function emptyProfile(problems = [], { missing = false } = {}) {
  const lines = problems.length ? problems : [MISSING_PROFILE];
  const profile = {
    id: 'empty',
    problems: lines,
    header: { subtitle: missing ? 'no profile' : 'profile problem' },
    commandLine: args => (args || []).join(' '),
    demoFacts: () => factStore(),
    probes: [],
    copy: {
      ...defaultCopy,
      intro: lines.join(' '),
      aligned: 'This cockpit has no workflow until a profile loads.',
      tip: 'Q quits. ? lists keys.',
    },
    artifacts: [],
    catalog: [],
    tasks: {},
    plans: {},
    actions: [],
  };
  profile.inspect = async root => (await refreshFacts({ profile, root, demo: false })).facts;
  return profile;
}

function failed(problems, found = true) {
  return { found, ok: false, problems, profile: emptyProfile(problems, { missing: !found }) };
}

function taskCommand(spec) {
  if (typeof spec.command === 'function') return spec.command;
  if (typeof spec.run === 'function') {
    return ctx => {
      const result = spec.run(ctx);
      if (Array.isArray(result)) return result;
      return result?.argv || [];
    };
  }
  if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(part => typeof part !== 'string' || !part)) return null;
  return ctx => spec.argv.map(part => fillArg(part, ctx?.params));
}

function compileSkip(spec) {
  if (typeof spec.skip === 'function') return spec.skip;
  if (!spec.skip) return () => '';
  const skip = spec.skip;
  return mode => skip.when === 'signed-only' && mode?.signedOnly ? (skip.message || 'skipped') : '';
}

function compileRequires(spec) {
  if (typeof spec.requires === 'function') return ctx => spec.requires(ctx) || '';
  const items = Array.isArray(spec.requires) ? spec.requires : [];
  return ctx => {
    for (const item of items) {
      const fact = ctx.facts?.get(item.fact);
      if (!fact || !['present', 'verified'].includes(fact.state)) return item.message || `Needs ${item.fact}.`;
    }
    return '';
  };
}

function compileApply(spec) {
  if (typeof spec.applyDemo === 'function') return spec.applyDemo;
  const keys = Array.isArray(spec.produces) ? spec.produces : [];
  return facts => {
    for (const key of keys) {
      const fact = facts.get(key);
      if (!fact) continue;
      fact.state = 'present';
      fact.provenance = { source: 'task', id: spec.id };
    }
  };
}

function compileConfirm(confirm) {
  if (typeof confirm === 'function') return confirm;
  return ctx => ({
    title: confirm.title || 'Confirm',
    danger: !!confirm.danger,
    lines: (confirm.lines || []).map(String),
    accept: ctx?.demo && confirm.demoAccept ? confirm.demoAccept : (confirm.accept || (ctx?.demo ? 'Simulate' : 'Continue')),
  });
}

class ProfileHost {
  constructor() {
    this.problems = [];
    this.id = 'profile';
    this.header = null;
    this.script = null;
    this.copy = null;
    this.modeSpec = null;
    this.artifactSpecs = [];
    this.taskSpecs = [];
    this.probeSpecs = [];
    this.planSpecs = [];
    this.actionSpecs = [];
  }

  problem(message) { this.problems.push(message); }
  task(spec) { this.taskSpecs.push(spec); }
  probe(spec) { this.probeSpecs.push(spec); }
  artifact(spec) { this.artifactSpecs.push(spec); }
  plan(spec) { this.planSpecs.push(spec); }
  action(spec) { this.actionSpecs.push(spec); }
  mode(spec) {
    if (this.modeSpec) this.problem('Mode is declared more than once.');
    else this.modeSpec = spec;
  }

  apply(spec) {
    if (spec.id != null) this.id = spec.id;
    if (spec.header != null) this.header = spec.header;
    if (spec.script != null) this.script = spec.script;
    if (spec.copy != null) this.copy = spec.copy;
    if (spec.mode) this.mode(spec.mode);
    if (spec.probes != null) this.problem('Register probes with the function form: export default host => host.probe(...).');
    for (const item of list(spec.artifacts, 'artifacts', message => this.problem(message))) this.artifact(item);
    for (const item of list(spec.tasks, 'tasks', message => this.problem(message))) this.task(item);
    for (const item of list(spec.plans, 'plans', message => this.problem(message))) this.plan(item);
    for (const item of list(spec.actions, 'actions', message => this.problem(message))) this.action(item);
  }

  facade() {
    return {
      task: spec => this.task(spec),
      probe: spec => this.probe(spec),
      artifact: spec => this.artifact(spec),
      plan: spec => this.plan(spec),
      action: spec => this.action(spec),
      mode: spec => this.mode(spec),
    };
  }

  result() {
    try {
      const profile = this.compile();
      if (this.problems.length) return failed(this.problems);
      assertProfileBindings(profile);
      return { found: true, ok: true, problems: [], profile };
    } catch (error) {
      const message = error?.message?.split('\n')[0] || 'Could not compile profile.';
      return failed([...this.problems, message]);
    }
  }

  compile() {
    const id = this.identity();
    const artifacts = this.artifacts();
    const codeProbes = this.probes();
    const tasks = this.tasks();
    const plans = this.plans(tasks);
    const actions = this.actions(plans);
    const mode = this.modeValue();
    if (this.problems.length) return null;
    const taskList = [...tasks.values()];
    const descriptions = [...artifacts.values()];
    const probes = [...artifactProbes(descriptions), ...codeProbes];
    const profile = {
      id,
      ...(this.script ? { script: this.script } : {}),
      problems: [],
      header: { subtitle: this.header?.subtitle || id },
      ...(mode ? { mode } : {}),
      commandLine: args => (args || []).join(' '),
      demoFacts: () => factStore(descriptions.map(desc => artifactFact(desc))),
      probes,
      async inspect(root) {
        const { facts } = await refreshFacts({ profile, root, demo: false });
        return facts;
      },
      copy: { ...defaultCopy, ...(this.copy || {}) },
      artifacts: descriptions,
      catalog: taskList.filter(task => task.catalog),
      tasks: Object.fromEntries(taskList.map(task => [task.id, task])),
      plans: Object.fromEntries([...plans.entries()]),
      actions,
    };
    return profile;
  }

  identity() {
    if (this.id != null && this.id !== 'profile' && !token(this.id)) this.problem('Profile id must be a short token.');
    if (this.header != null && !isObject(this.header)) this.problem('header must be an object.');
    else if (this.header && this.header.subtitle != null && typeof this.header.subtitle !== 'string') this.problem('header.subtitle must be text.');
    if (this.script != null && !relativeInside(this.script)) this.problem('script must stay inside the repo.');
    if (this.copy != null && !isObject(this.copy)) this.problem('copy must be an object.');
    return token(this.id) ? this.id : 'profile';
  }

  artifacts() {
    const artifacts = new Map();
    for (const spec of this.artifactSpecs) {
      if (!isObject(spec) || !token(spec.key)) { this.problem('An artifact is missing a key.'); continue; }
      if (artifacts.has(spec.key)) this.problem(`Artifact "${spec.key}" is declared more than once.`);
      if (typeof spec.label !== 'string' || !spec.label) this.problem(`Artifact "${spec.key}" needs a label.`);
      if (!relativeInside(spec.path)) this.problem(`Artifact "${spec.key}" path must stay inside the repo.`);
      const kind = spec.kind || 'file';
      if (!['file', 'dir', 'checksum'].includes(kind)) this.problem(`Artifact "${spec.key}" has unknown kind "${kind}".`);
      artifacts.set(spec.key, {
        key: spec.key, label: spec.label, path: spec.path, kind,
        gatesPublish: !!spec.gatesPublish, archive: spec.archive || null,
      });
    }
    for (const desc of artifacts.values()) {
      if (desc.kind === 'checksum' && desc.archive && !artifacts.has(desc.archive)) {
        this.problem(`Artifact "${desc.key}" names unknown archive "${desc.archive}".`);
      }
    }
    return artifacts;
  }

  probes() {
    const probes = [];
    const seen = new Set();
    for (const spec of this.probeSpecs) {
      if (!isObject(spec) || !token(spec.id)) { this.problem('A probe is missing an id.'); continue; }
      if (seen.has(spec.id)) this.problem(`Probe "${spec.id}" is declared more than once.`);
      seen.add(spec.id);
      if (typeof spec.run !== 'function') { this.problem(`Probe "${spec.id}" needs a run function.`); continue; }
      if (spec.facts != null && (!Array.isArray(spec.facts) || spec.facts.some(key => !token(key)))) {
        this.problem(`Probe "${spec.id}" facts must be a list of fact keys.`);
      }
      if (spec.demo != null && typeof spec.demo !== 'function') this.problem(`Probe "${spec.id}" demo must be a function.`);
      const owned = Array.isArray(spec.facts) && spec.facts.length && spec.facts.every(key => token(key)) ? spec.facts : null;
      probes.push({
        id: spec.id,
        run: spec.run,
        ...(owned ? { facts: owned } : {}),
        ...(typeof spec.demo === 'function' ? { demo: spec.demo } : {}),
      });
    }
    return probes;
  }

  tasks() {
    const tasks = new Map();
    for (const spec of this.taskSpecs) {
      if (!isObject(spec) || !token(spec.id)) { this.problem('A task is missing an id.'); continue; }
      if (tasks.has(spec.id)) this.problem(`Task "${spec.id}" is declared more than once.`);
      if (typeof spec.label !== 'string' || !spec.label) this.problem(`Task "${spec.id}" needs a label.`);
      const command = taskCommand(spec);
      if (!command) this.problem(`Task "${spec.id}" needs a non-empty argv.`);
      if (spec.requires != null && typeof spec.requires !== 'function' && !Array.isArray(spec.requires)) {
        this.problem(`Task "${spec.id}" requires must be a list of { fact, message }.`);
      }
      if (Array.isArray(spec.requires)) {
        for (const item of spec.requires) {
          if (!isObject(item) || typeof item.fact !== 'string' || !item.fact) this.problem(`Task "${spec.id}" requirements need a fact.`);
        }
      }
      if (spec.skip != null && typeof spec.skip !== 'function' && !isObject(spec.skip)) this.problem(`Task "${spec.id}" skip must be { when, message }.`);
      if (spec.produces != null && (!Array.isArray(spec.produces) || spec.produces.some(key => typeof key !== 'string' || !key))) {
        this.problem(`Task "${spec.id}" produces must be a list of fact keys.`);
      }
      if (spec.demo != null && typeof spec.demo !== 'function' && !Array.isArray(spec.demo)) this.problem(`Task "${spec.id}" demo must be a list of lines.`);
      tasks.set(spec.id, {
        id: spec.id,
        label: spec.label,
        detail: typeof spec.detail === 'string' ? spec.detail : '',
        ...(typeof spec.group === 'string' && spec.group ? { group: spec.group } : {}),
        catalog: spec.catalog !== false,
        command,
        requires: compileRequires(spec),
        skip: compileSkip(spec),
        demo: spec.demo,
        applyDemo: compileApply(spec),
        ...(typeof spec.onDone === 'function' ? { onDone: spec.onDone } : {}),
        resume: spec.resume || null,
      });
    }
    return tasks;
  }

  plans(tasks) {
    const plans = new Map();
    for (const spec of this.planSpecs) {
      if (!isObject(spec) || !token(spec.id)) { this.problem('A plan is missing an id.'); continue; }
      if (plans.has(spec.id)) this.problem(`Plan "${spec.id}" is declared more than once.`);
      if (!['run', 'form', 'gated'].includes(spec.kind)) this.problem(`Plan "${spec.id}" kind must be run, form, or gated.`);
      const steps = this.planSteps(spec, tasks);
      if (spec.kind === 'gated' && steps.length < 2) this.problem(`Plan "${spec.id}" needs a validation step and a confirmed step.`);
      if ((spec.kind === 'run' || spec.kind === 'form') && !steps.length && typeof spec.resolve !== 'function') this.problem(`Plan "${spec.id}" needs at least one step.`);
      const fields = spec.kind === 'form' ? this.fields(spec) : [];
      if (spec.kind === 'form' && (spec.fields == null || (Array.isArray(spec.fields) && !spec.fields.length))) {
        this.problem(`Plan "${spec.id}" needs at least one field.`);
      }
      plans.set(spec.id, this.runtimePlan(spec, steps, fields, tasks));
    }
    return plans;
  }

  planSteps(spec, tasks) {
    return list(spec.steps, `Plan "${spec.id}" steps`, message => this.problem(message)).map((step, index) => {
      const taskId = typeof step === 'string' ? step : step?.task || step?.taskId;
      const where = `Plan "${spec.id}" step ${index + 1}`;
      if (typeof taskId !== 'string' || !taskId) this.problem(`${where} is missing a task.`);
      else if (!tasks.has(taskId)) this.problem(`${where} names unknown task "${taskId}".`);
      const after = isObject(step) ? step.after : undefined;
      if (after != null && after !== 'pause') this.problem(`${where} has unknown after "${after}".`);
      let confirm = null;
      if (isObject(step) && step.confirm != null) {
        if (typeof step.confirm !== 'function' && (!isObject(step.confirm) || (step.confirm.lines != null && !Array.isArray(step.confirm.lines)))) {
          this.problem(`${where} confirm must be { title, lines, accept }.`);
        } else confirm = compileConfirm(step.confirm);
      } else if (spec.kind === 'gated' && index > 0) this.problem(`${where} needs a confirm.`);
      return {
        taskId,
        ...(after ? { after } : {}),
        ...(after === 'pause' ? { pauseNotice: isObject(step) && step.pauseNotice || 'Step passed. Review the log, then continue.' } : {}),
        ...(confirm ? { confirm } : {}),
      };
    });
  }

  fields(spec) {
    return list(spec.fields, `Plan "${spec.id}" fields`, message => this.problem(message)).map(field => {
      if (!isObject(field) || !token(field.name)) { this.problem(`Plan "${spec.id}" has a field without a name.`); return null; }
      if (!Object.hasOwn(fieldTypes, field.type)) this.problem(`Plan "${spec.id}" field "${field.name}" has unknown type "${field.type}".`);
      if (field.label != null && typeof field.label !== 'string') this.problem(`Plan "${spec.id}" field "${field.name}" label must be text.`);
      return { name: field.name, type: field.type, label: field.label || field.name };
    }).filter(Boolean);
  }

  runtimePlan(spec, steps, fields, tasks) {
    const presets = this.presets(spec);
    const plan = {
      id: spec.id,
      kind: spec.kind,
      title: spec.title || spec.id,
      steps,
      ...(spec.kind === 'form' ? { fields, presets, help: spec.help || '', submit: spec.submit || 'Review →' } : {}),
      resume: spec.resume || null,
      blocked: ctx => typeof spec.blocked === 'function' ? (spec.blocked(ctx) || '') : (spec.blocked || ''),
    };
    if (spec.kind === 'form') {
      plan.hint = ctx => typeof spec.hint === 'function' ? spec.hint(ctx) : (spec.hint || '');
      plan.validate = ctx => {
        for (const field of fields) {
          const value = String(ctx.params?.[field.name] ?? '');
          if (!fieldTypes[field.type]?.(value)) return fieldMessages[field.type]?.(field.label) || `Enter a valid ${field.label}.`;
        }
        return typeof spec.validate === 'function' ? spec.validate(ctx) || '' : '';
      };
    }
    if (spec.kind === 'gated') {
      plan.confirmStart = ctx => {
        if (typeof spec.confirmStart === 'function') return spec.confirmStart(ctx);
        const start = isObject(spec.confirmStart) ? spec.confirmStart : {};
        return {
          title: start.title || plan.title,
          danger: !!start.danger,
          lines: Array.isArray(start.lines) ? start.lines.map(String) : [],
          accept: ctx?.demo && start.demoAccept ? start.demoAccept : (start.accept || (ctx?.demo ? 'Simulate' : 'Continue')),
        };
      };
    }
    if (spec.kind === 'run' || spec.kind === 'form') {
      plan.review = (ctx, jobs) => {
        if (typeof spec.review === 'function') return spec.review(ctx, jobs);
        return {
          title: spec.title || 'Review',
          lines: [
            ...(fields || []).map(field => `${field.label}  ${ctx.params?.[field.name] ?? ''}`),
            ...((fields || []).length ? [''] : []),
            ...(jobs || []).map(job => job.display),
          ],
          accept: ctx.demo ? 'Simulate' : (spec.accept || 'Start'),
        };
      };
    }
    plan.resolve = ctx => {
      if (typeof spec.resolve === 'function') return spec.resolve(ctx);
      const jobs = [];
      for (const step of steps) {
        const task = tasks.get(step.taskId);
        if (!task || task.skip?.(ctx.mode)) continue;
        jobs.push({ ...materialize(task, ctx),
          ...(step.confirm ? { confirm: step.confirm } : {}),
          ...(step.after ? { after: step.after, pauseNotice: step.pauseNotice } : {}),
        });
      }
      return jobs;
    };
    return plan;
  }

  presets(spec) {
    if (spec.kind !== 'form') return [];
    const presets = list(spec.presets, `Plan "${spec.id}" presets`, message => this.problem(message)).map((preset, index) => {
      if (!isObject(preset)) { this.problem(`Plan "${spec.id}" has an invalid preset.`); return null; }
      if (preset.values != null && !isObject(preset.values)) this.problem(`Plan "${spec.id}" preset "${preset.name || index + 1}" values must be an object.`);
      return {
        name: preset.name || `Preset ${index + 1}`,
        opening: !!preset.opening,
        apply: typeof preset.apply === 'function' ? preset.apply : () => ({ ...(preset.values || {}) }),
      };
    }).filter(Boolean);
    if (!presets.length) presets.push({ name: 'Current', opening: true, apply: () => ({}) });
    else if (!presets.some(preset => preset.opening)) presets[0].opening = true;
    return presets;
  }

  actions(plans) {
    const actions = [];
    const seen = new Set();
    for (const spec of this.actionSpecs) {
      if (!isObject(spec) || !token(spec.id)) { this.problem('An action is missing an id.'); continue; }
      if (seen.has(spec.id)) this.problem(`Action "${spec.id}" is declared more than once.`);
      seen.add(spec.id);
      if (spec.plan != null && !plans.has(spec.plan)) this.problem(`Action "${spec.id}" names unknown plan "${spec.plan}".`);
      if (spec.bindings != null && !Array.isArray(spec.bindings)) this.problem(`Action "${spec.id}" bindings must be a list.`);
      const bindings = (Array.isArray(spec.bindings) ? spec.bindings : []).map(binding => ({
        key: String(typeof binding === 'string' ? binding : binding?.key || '').toLowerCase(),
      })).filter(binding => binding.key);
      actions.push({
        id: spec.id,
        ...(spec.home ? { home: true } : {}),
        ...(spec.plan ? { plan: spec.plan } : {}),
        ...(spec.screen ? { screen: spec.screen } : {}),
        ...(spec.toggle ? { toggle: true } : {}),
        bindings,
        label: spec.label || '',
        detail: spec.detail || '',
        ...(typeof spec.detailFor === 'function' ? { detailFor: spec.detailFor } : {}),
        palette: spec.palette || spec.label || spec.id,
        paletteHint: spec.paletteHint || '',
        paletteDetail: spec.paletteDetail || spec.detail || '',
        ...(spec.helpKey ? { helpKey: spec.helpKey } : {}),
        ...(spec.help ? { help: spec.help } : {}),
        ...(spec.hint ? { hint: spec.hint } : {}),
        ...(spec.hintOrder ? { hintOrder: spec.hintOrder } : {}),
      });
    }
    return actions;
  }

  modeValue() {
    const spec = this.modeSpec;
    if (!spec) return null;
    if (!isObject(spec)) { this.problem('Mode must be an object.'); return null; }
    const chip = spec.chip || {};
    const sidebar = spec.sidebar || {};
    const resume = spec.resume || {};
    const text = [chip.on, chip.off, sidebar.on, sidebar.off, sidebar.hint, resume.on, resume.off];
    if (!text.every(item => typeof item === 'string' && item)) {
      this.problem('Mode is missing chip, sidebar, or resume text.');
      return null;
    }
    return {
      id: spec.id || 'mode',
      chip: { on: chip.on, off: chip.off },
      sidebar: { on: sidebar.on, off: sidebar.off, hint: sidebar.hint },
      resume: { on: resume.on, off: resume.off },
    };
  }
}

export async function loadProfile(root) {
  const file = join(root, PROFILE_FILE);
  let info;
  try { info = await stat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return failed([MISSING_PROFILE], false);
    return failed([error.message.split('\n')[0]], false);
  }
  if (!info.isFile()) return failed([`${PROFILE_FILE} is not a file.`]);
  try {
    const imported = await import(pathToFileURL(file).href);
    const exported = imported.default;
    const host = new ProfileHost();
    if (typeof exported === 'function') await exported(host.facade());
    else if (isObject(exported)) host.apply(exported);
    else host.problem(`${PROFILE_FILE} must default-export a profile object or a register function.`);
    return host.result();
  } catch (error) {
    const message = error?.message?.split('\n')[0] || `Could not load ${PROFILE_FILE}.`;
    return failed([`Could not load ${PROFILE_FILE}: ${message}`]);
  }
}

async function sameDirectory(left, right) {
  try { return await realpath(left) === await realpath(right); }
  catch { return false; }
}

// HoldThis is the fallback only for this package. Every other directory gets the loaded profile or the empty cockpit.
export async function profileForDirectory(root, { packageRoot, fallback } = {}) {
  const loaded = await loadProfile(root);
  if (loaded.ok) return loaded.profile;
  if (!loaded.found && packageRoot && fallback && await sameDirectory(root, packageRoot)) return fallback;
  return loaded.profile;
}

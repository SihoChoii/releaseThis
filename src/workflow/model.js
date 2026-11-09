// Host product model. Profiles contribute facts, tasks, plans, modes, and actions.
// The cockpit and runner never name a product.

export const fieldTypes = {
  semver: value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
  integer: value => /^[1-9]\d*$/.test(value),
};

const RESERVED_KEYS = new Set([
  'q', '/', '?', 'w', 'a', 'l', 'j', 'k', 'f', 'e', 'r', 't', 'm',
  'escape', 'tab', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'return', 'backspace', 'delete',
]);

export function factStore(entries = []) {
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  return {
    get: key => byKey.get(key) || null,
    set(entry) { byKey.set(entry.key, entry); },
    all: () => [...byKey.values()],
  };
}

export function sameVersion(a, b) {
  return !!a && !!b && a.version === b.version && a.build === b.build;
}

export function project(facts) {
  if (!facts) return null;
  const all = facts.all();
  return {
    source: all.find(fact => fact.role === 'source-version')?.value ?? null,
    built: all.find(fact => fact.role === 'built-version')?.value ?? null,
    stapled: !!all.find(fact => fact.role === 'check')?.value,
    checks: all.filter(fact => fact.role === 'check'),
    artifacts: all.filter(fact => fact.role === 'artifact'),
  };
}

// Rebuild a fact store from the workspace projection tests and the view share.
export function factsFromWorkspace(profile, workspace) {
  const facts = profile.demoFacts();
  const source = facts.all().find(fact => fact.role === 'source-version');
  if (source) source.value = workspace.source ? { ...workspace.source } : null;
  const built = facts.all().find(fact => fact.role === 'built-version');
  if (built) {
    built.value = workspace.built ? { ...workspace.built } : null;
    built.state = workspace.built ? 'present' : 'missing';
  }
  const stapled = facts.all().find(fact => fact.role === 'check');
  if (stapled) {
    stapled.value = !!workspace.stapled;
    stapled.state = workspace.stapled ? 'present' : 'missing';
  }
  profile.artifacts.forEach((artifact, index) => {
    const from = workspace.artifacts?.[index];
    const fact = facts.get(artifact.key);
    if (!from || !fact) return;
    fact.state = from.state;
    fact.size = from.size || '';
    fact.modifiedAt = from.modifiedAt ?? null;
    if (from.path) fact.path = from.path;
    if (from.label) fact.label = from.label;
  });
  return facts;
}

export function materialize(task, ctx) {
  const args = task.args(ctx);
  return {
    id: task.id,
    label: task.label,
    detail: task.detail,
    args,
    display: ctx.commandLine ? ctx.commandLine(args) : args.join(' '),
    demo: task.demo,
    applyDemo: task.applyDemo,
    onDone: task.onDone,
    resume: task.resume || null,
  };
}

export function resolvePlan(plan, ctx) {
  const error = plan.validate?.(ctx) || '';
  if (error) throw new Error(error);
  return plan.resolve(ctx);
}

export function openingParams(plan, facts) {
  const preset = plan.presets.find(item => item.opening) || plan.presets[0];
  return preset.apply(facts);
}

export function requirement(task, ctx) {
  return task.requires?.(ctx) || '';
}

export function planBlock(plan, ctx) {
  return plan.blocked?.(ctx) || '';
}

// Structural keys and host chrome win. A profile binding that collides is rejected.
export function assertProfileBindings(profile) {
  const seen = new Set();
  for (const action of profile.actions || []) {
    for (const binding of action.bindings || []) {
      if (RESERVED_KEYS.has(binding.key) || seen.has(binding.key)) {
        throw new Error(`Command binding "${binding.key}" is reserved or duplicated.`);
      }
      seen.add(binding.key);
    }
  }
}

export default {
  id: 'library',
  header: { subtitle: 'Library' },
  artifacts: [
    { key: 'artifact.tested', label: 'Test log', path: 'out/test.txt' },
    { key: 'artifact.archive', label: 'Package', path: 'out/library.tgz', kind: 'file', gatesPublish: true },
    { key: 'artifact.archive.sha256', label: 'Checksum', path: 'out/library.tgz.sha256', kind: 'checksum', archive: 'artifact.archive', gatesPublish: true },
  ],
  tasks: [
    { id: 'test', label: 'Test', detail: 'Run the test suite', argv: ['./release.sh', 'test'], produces: ['artifact.tested'], demo: [{ text: 'tests passed', status: { phase: 'Test' } }] },
    { id: 'pack', label: 'Pack', detail: 'Build the package', argv: ['./release.sh', 'pack'], requires: [{ fact: 'artifact.tested', message: 'Test first.' }], produces: ['artifact.archive'], demo: [{ text: 'archive packed', status: { phase: 'Pack' } }] },
    { id: 'checksum', label: 'Checksum', detail: 'Write the checksum', argv: ['./release.sh', 'checksum'], requires: [{ fact: 'artifact.archive', message: 'Pack first.' }], produces: ['artifact.archive.sha256'], demo: [{ text: 'checksum written', status: { phase: 'Checksum' } }] },
    { id: 'validate', label: 'Validate', detail: 'Check the package', argv: ['./release.sh', 'validate'], catalog: false, demo: [{ text: 'validation passed', status: { phase: 'Validate' } }] },
    { id: 'upload', label: 'Upload', detail: 'Copy the package to out/published/', argv: ['./release.sh', 'upload'], catalog: false, demo: [{ text: 'package uploaded', status: { phase: 'Upload' } }] },
  ],
  plans: [
    { id: 'release', kind: 'run', title: 'Release', steps: ['test', 'pack', 'checksum'] },
    {
      id: 'publish', kind: 'gated', title: 'Publish', resume: 'revalidate',
      confirmStart: { title: 'Validate package', lines: ['Dry-run the package before upload.'], accept: 'Validate' },
      blocked(ctx) {
        const ready = fact => fact && ['present', 'verified'].includes(fact.state);
        const needed = ctx.facts.all().filter(fact => fact.gatesPublish);
        if (!needed.length || needed.some(fact => !ready(fact))) return 'Pack the archive and verify its checksum first.';
        return '';
      },
      steps: [
        { task: 'validate', after: 'pause', pauseNotice: 'Validation passed. Read the log, then continue.' },
        { task: 'upload', confirm: { title: 'Upload package', danger: true, lines: ['Copies the verified package and checksum to out/published/.'], accept: 'Copy package' } },
      ],
    },
  ],
  actions: [
    { id: 'release', home: true, plan: 'release', bindings: [{ key: '1' }], label: 'Release', detail: 'Test, pack, and checksum.' },
    { id: 'publish', home: true, plan: 'publish', bindings: [{ key: '2' }, { key: 'p' }], label: 'Publish', detail: 'Validate, then copy to out/published/.' },
  ],
};

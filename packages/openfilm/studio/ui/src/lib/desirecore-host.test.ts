import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectorBridgeError, DirectorHost, boundedStudioRef, directorSelection, installDesirecoreHost, type DesirecoreAppBridge, type DirectorContext, type DirectorProposal } from './desirecore-host.ts';

const context: DirectorContext = {
  projectId: 'project-123', projectPath: '/work/My film', filmRevision: 'actual-film-revision', time: 4.5,
  refs: [{ kind: 'clip', id: 's1', loc: 'film.html#0.0', label: 'Title', clipKind: 'mg', src: 'title.html', start: 0, end: 5, image: { src: 'data:image/png;base64,PRIVATE' } }],
};
const connection = { capabilities: ['publishSelection', 'requestWork'], application: { sourceId: 'source', appId: 'video-creation', installationId: 'real-installation' } };
const unbound = async () => ({ directorAgentId: null });

function fixture(options: { agentId?: string | null; connected?: unknown; failOnce?: boolean } = {}) {
  const calls: Array<{ method: string; payload?: unknown }> = [];
  let nextId = 0, failed = false;
  const bridge: DesirecoreAppBridge = { call: async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'connect') return options.connected ?? connection;
    if (method === 'prepareWork') {
      if (options.failOnce && !failed) { failed = true; throw new Error('app_bridge_result_unknown'); }
      return { status: 'prepared', clientRequestId: (payload as DirectorProposal).clientRequestId };
    }
    return {};
  } };
  const host = new DirectorHost({ bridge: () => bridge, context: async () => ({ directorAgentId: options.agentId === undefined ? 'installed-agent-7d5c' : options.agentId }), uuid: () => `request-${++nextId}` });
  return { host, calls, bridge };
}

test('selection stays bounded JSON and never advertises invented platform objects or image data', () => {
  const refs = Array.from({ length: 100 }, () => ({ kind: 'subtitle' as const, start: 0, end: 1, text: 'A'.repeat(30_000), image: { src: 'data:image/png;base64,PRIVATE' } }));
  const selection = directorSelection({ ...context, refs }, () => 'selection-revision');
  assert.equal(selection.schemaVersion, 1);
  assert.equal(selection.selectionRevision, 'selection-revision');
  assert.deepEqual(selection.objects, []);
  assert.ok(selection.summary.length <= 16_000);
  assert.ok(!selection.summary.includes('PRIVATE'));
  const parsed = JSON.parse(selection.summary);
  assert.equal(parsed.projectPath, context.projectPath);
  assert.equal(parsed.filmRevision, 'actual-film-revision');
  assert.ok(parsed.omittedReferences > 0);
  assert.ok(parsed.refs.every((ref: { text: string }) => ref.text.length <= 1024));
  assert.deepEqual(boundedStudioRef({ kind: 'time', time: Infinity }), { kind: 'time' });
});

test('prepares for the real configured Agent and leaves final execution to the platform', async () => {
  const { host, calls } = fixture();
  const receipt = await host.prepare(context, 'Make this title shorter.');
  assert.deepEqual(calls.map((call) => call.method), ['connect', 'publishSelection', 'prepareWork']);
  const proposal = calls[2].payload as DirectorProposal;
  assert.equal(proposal.agentId, 'installed-agent-7d5c');
  assert.equal(proposal.operation, 'video-creation.discuss-selection');
  assert.ok(proposal.prompt.includes('Make this title shorter.'));
  assert.ok(proposal.prompt.includes('/work/My film'));
  assert.equal(receipt.clientRequestId, proposal.clientRequestId);
  assert.deepEqual(calls[1].payload, proposal.selection);
  assert.ok(!JSON.stringify(proposal).includes('PRIVATE'));
});

test('unknown preparation results preserve request and message identities for the same retry', async () => {
  const { host, calls } = fixture({ failOnce: true });
  await assert.rejects(host.prepare(context, 'Change only this clip'), (cause) => cause instanceof DirectorBridgeError && cause.code === 'prepare-failed');
  await host.prepare(context, 'Change only this clip');
  const proposals = calls.filter((call) => call.method === 'prepareWork').map((call) => call.payload);
  assert.deepEqual(proposals[0], proposals[1]);
  await host.prepare(context, 'Change the selected caption instead');
  const changed = calls.filter((call) => call.method === 'prepareWork').at(-1)!.payload as DirectorProposal;
  assert.notEqual(changed.clientRequestId, (proposals[0] as DirectorProposal).clientRequestId);
});

test('browser editing and missing bindings fail readably without preparing work', async () => {
  const missing = new DirectorHost({ bridge: () => undefined, context: unbound });
  await assert.rejects(missing.prepare(context, 'Edit'), (cause) => cause instanceof DirectorBridgeError && cause.code === 'host-unavailable');
  const { host, calls } = fixture({ agentId: null });
  await assert.rejects(host.prepare(context, 'Edit'), (cause) => cause instanceof DirectorBridgeError && cause.code === 'unbound');
  assert.equal(calls.length, 0);
});

test('requires the host verified installation identity and granted collaboration methods', async () => {
  const noIdentity = fixture({ connected: { capabilities: ['publishSelection', 'requestWork'] } });
  await assert.rejects(noIdentity.host.prepare(context, 'Edit'), (cause) => cause instanceof DirectorBridgeError && cause.code === 'host-identity-unavailable');
  assert.deepEqual(noIdentity.calls.map((call) => call.method), ['connect']);
  const noGrant = fixture({ connected: { ...connection, capabilities: ['publishSelection'] } });
  await assert.rejects(noGrant.host.prepare(context, 'Edit'), (cause) => cause instanceof DirectorBridgeError && cause.code === 'permission-unavailable');
});

test('native adapter installs only in the trusted top document and preserves an existing host', () => {
  const { host, bridge } = fixture();
  const nested = { desirecoreApp: bridge };
  assert.equal(installDesirecoreHost(nested, false, host), false);
  assert.equal('openfilmHost' in nested, false);
  const browser = {};
  assert.equal(installDesirecoreHost(browser, true, host), false);
  const native: Parameters<typeof installDesirecoreHost>[0] = { desirecoreApp: bridge };
  assert.equal(installDesirecoreHost(native, true, host), true);
  assert.deepEqual(Object.keys(native.openfilmHost!).sort(), ['name', 'onSelection', 'refer', 'version']);
  const original = native.openfilmHost;
  assert.equal(installDesirecoreHost(native, true, host), false);
  assert.equal(native.openfilmHost, original);
});

test('references freeze the source project and close cleanly when that project leaves', () => {
  const { host } = fixture();
  const stop = host.registerContext(() => context);
  host.refer(context.refs[0]);
  assert.equal(host.get().open, true);
  assert.equal(host.get().context?.projectPath, '/work/My film');
  context.refs[0].image!.src = 'changed-thumbnail';
  assert.notEqual(host.get().context?.refs[0].image?.src, 'changed-thumbnail');
  stop();
  assert.equal(host.get().open, false);
});

test('renaming the source keeps an open director draft and its references, but prepares the current path', async () => {
  const { host, calls } = fixture();
  host.open(context);
  await host.prepare(host.get().context!, 'Keep this instruction');
  const before = host.get();
  const firstProposal = calls.filter((call) => call.method === 'prepareWork').at(-1)!.payload as DirectorProposal;
  host.relocate('another-project', '/work/Other');
  assert.equal(host.get(), before, 'another project does not change the source-bound draft');
  host.relocate(context.projectId, '/work/Renamed film');
  const after = host.get();
  assert.equal(after.open, true);
  assert.equal(after.context?.projectPath, '/work/Renamed film');
  assert.deepEqual(after.context?.refs, before.context?.refs);
  assert.equal(after.context?.time, before.context?.time);
  assert.equal(after.context?.filmRevision, before.context?.filmRevision);
  assert.equal(after.generation, before.generation + 1, 'the previous prepared result is stale');
  host.relocate(context.projectId, '/work/Renamed film');
  assert.equal(host.get(), after, 'repeated metadata is not a new draft');
  await host.prepare(after.context!, 'Keep this instruction');
  const proposal = calls.filter((call) => call.method === 'prepareWork').at(-1)!.payload as DirectorProposal;
  assert.notEqual(proposal.clientRequestId, firstProposal.clientRequestId);
  assert.equal(JSON.parse(proposal.selection.summary).projectPath, '/work/Renamed film');
  assert.ok(proposal.prompt.startsWith('Keep this instruction'));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const phase of ['context', 'connect', 'publishSelection', 'prepareWork'] as const) {
  test(`rename during ${phase} invalidates the stale preparation before it proceeds`, async () => {
    const reached = deferred(), release = deferred();
    const calls: Array<{ method: string; payload?: unknown }> = [];
    let blocked = false, nextId = 0, current = structuredClone(context);
    const pauseAt = async (step: string) => {
      if (step !== phase || blocked) return;
      blocked = true; reached.resolve(); await release.promise;
    };
    const bridge: DesirecoreAppBridge = { call: async (method, payload) => {
      calls.push({ method, payload });
      await pauseAt(method);
      if (method === 'connect') return connection;
      if (method === 'prepareWork') return { status: 'prepared', clientRequestId: (payload as DirectorProposal).clientRequestId };
      return {};
    } };
    const host = new DirectorHost({ bridge: () => bridge, context: async () => {
      await pauseAt('context'); return { directorAgentId: 'video-director' };
    }, uuid: () => `deferred-${++nextId}` });
    host.registerContext(() => current);
    host.open(current);
    const rejected = assert.rejects(host.prepare(host.get().context!, 'Preserve this draft'),
      (cause) => cause instanceof DirectorBridgeError && cause.code === 'context-unavailable');
    await reached.promise;
    current = { ...current, projectPath: '/work/After rename' };
    host.relocate(current.projectId, current.projectPath);
    release.resolve();
    await rejected;
    assert.deepEqual(calls.map((call) => call.method), phase === 'context' ? [] : phase === 'connect' ? ['connect']
      : phase === 'publishSelection' ? ['connect', 'publishSelection'] : ['connect', 'publishSelection', 'prepareWork']);
    assert.equal(host.get().context?.projectPath, current.projectPath);
    if (phase === 'publishSelection' || phase === 'prepareWork') {
      assert.equal(JSON.parse((calls[1].payload as { summary: string }).summary).projectPath, context.projectPath,
        'an already-published selection remains an observable fact');
    }
    if (phase === 'prepareWork') {
      assert.equal(calls.filter((call) => call.method === 'prepareWork').length, 1,
        'a preparation already sent remains auditable; invalidation does not cancel or repeat it');
    }
    await host.prepare(host.get().context!, 'Preserve this draft');
    const proposal = calls.filter((call) => call.method === 'prepareWork').at(-1)!.payload as DirectorProposal;
    assert.equal(JSON.parse(proposal.selection.summary).projectPath, current.projectPath, 'the person can prepare the retained draft from the renamed source');
  });
}

test('a path change visible to the context reader invalidates preparation before the relocate effect runs', async () => {
  const reached = deferred(), release = deferred(), calls: string[] = [];
  let current = structuredClone(context);
  const host = new DirectorHost({ context: async () => ({ directorAgentId: 'video-director' }), bridge: () => ({ call: async (method, payload) => {
    calls.push(method);
    if (method === 'connect') { reached.resolve(); await release.promise; return connection; }
    if (method === 'prepareWork') return { status: 'prepared', clientRequestId: (payload as DirectorProposal).clientRequestId };
    return {};
  } }) });
  host.registerContext(() => current);
  host.open(current);
  const rejected = assert.rejects(host.prepare(host.get().context!, 'Edit'), (cause) => cause instanceof DirectorBridgeError && cause.code === 'context-unavailable');
  await reached.promise;
  current = { ...current, projectPath: '/work/Current path from render' };
  release.resolve();
  await rejected;
  assert.deepEqual(calls, ['connect']);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../renderer/engine.js', import.meta.url), 'utf8');
const ROOT = '01900000-0000-7000-8000-000000000001';
const CHILD = '01900000-0000-7000-8000-000000000002';
const GRANDCHILD = '01900000-0000-7000-8000-000000000003';
const OTHER = '01900000-0000-7000-8000-000000000004';
const clone = value => structuredClone(value);

function thread(id, overrides = {}) {
  return {
    id, name: `Chat ${id.slice(-1)}`, preview: 'Initial message', createdAt: 100, updatedAt: 200,
    parentThreadId: null, sessionId: id, ephemeral: false, status: { type: 'notLoaded' },
    historyMode: 'legacy', cwd: 'C:\\workspace', path: `C:\\isolated\\${id}.jsonl`, turns: [],
    ...overrides,
  };
}

function harness(initial = [thread(ROOT)], options = {}) {
  const context = vm.createContext({ Date, Map, Set });
  vm.runInContext(source, context);
  const store = new Map(initial.map(entry => [entry.id, clone(entry)]));
  const calls = [];
  let current = null;
  let timestamp = 1000;
  const state = { store, calls, setCurrent: value => { current = value; },
    advance: value => { timestamp += value; } };
  async function rpc(method, params) {
    calls.push({ method, params: clone(params) });
    if (options.beforeRpc) await options.beforeRpc(method, params, state);
    if (options.rpc) {
      const custom = await options.rpc(method, params, state);
      if (custom !== undefined) return clone(custom);
    }
    if (method === 'thread/read') {
      const value = store.get(params.threadId);
      if (!value) throw new Error('thread not found');
      return { thread: { ...clone(value), turns: params.includeTurns ? clone(value.turns) : [] } };
    }
    if (method === 'thread/list') {
      return { data: Array.from(store.values()).filter(entry => entry.id !== params.ancestorThreadId &&
        Boolean(entry.archived) === params.archived).map(clone), nextCursor: null };
    }
    if (method === 'thread/delete') {
      if (options.deleteFailure) throw options.deleteFailure;
      store.clear();
      return {};
    }
    throw new Error(`Unexpected RPC ${method}`);
  }
  const engine = context.CodexDeleteEngine.create({
    rpc, currentThreadId: () => current, now: () => timestamp,
  });
  return { ...state, engine };
}

const countDeletes = state => state.calls.filter(call => call.method === 'thread/delete').length;
const rejectedCode = code => error => error.code === code;

test('deletes root and verified archived descendants after metadata recheck without reading history', async () => {
  const h = harness([
    thread(ROOT), thread(CHILD, { parentThreadId: ROOT }),
    thread(GRANDCHILD, { parentThreadId: CHILD, archived: true }),
  ]);
  const preview = await h.engine.preview(ROOT);
  assert.equal(preview.title, 'Chat 1');
  assert.equal(preview.threadId, ROOT);
  assert.deepEqual(Array.from(preview.targets, target => target.id), [ROOT, CHILD, GRANDCHILD]);
  const result = await h.engine.remove(preview.token);
  assert.deepEqual(Array.from(result.deletedIds), [ROOT, CHILD, GRANDCHILD]);
  assert.equal(countDeletes(h), 1);
  assert.deepEqual(h.calls.at(-1), { method: 'thread/delete', params: { threadId: ROOT } });
  assert.ok(h.calls.every(call => ['thread/read', 'thread/list', 'thread/delete'].includes(call.method)));
  assert.ok(h.calls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === false));
  for (const list of h.calls.filter(call => call.method === 'thread/list')) {
    assert.equal(list.params.ancestorThreadId, ROOT);
    assert.equal(list.params.sourceKinds.length, 10);
    assert.ok(list.params.sourceKinds.includes('subAgentThreadSpawn'));
    assert.ok(list.params.sourceKinds.includes('unknown'));
    assert.deepEqual(list.params.modelProviders, []);
  }
  assert.ok(h.calls.some(call => call.method === 'thread/list' && call.params.archived));
});

test('rejects invalid IDs without sending any RPC', async () => {
  const h = harness();
  for (const id of ['../sessions', ROOT + '/suffix', '00000000-0000-0000-0000-000000000000', null]) {
    await assert.rejects(h.engine.preview(id), rejectedCode('INVALID_ID'));
  }
  assert.equal(h.calls.length, 0);
});

for (const status of ['active', 'systemError', 'unknown']) {
  test(`rejects ${status} root and descendant status`, async () => {
    for (const descendant of [false, true]) {
      const h = harness(descendant
        ? [thread(ROOT), thread(CHILD, { parentThreadId: ROOT, status: { type: status } })]
        : [thread(ROOT, { status: { type: status } })]);
      await assert.rejects(h.engine.preview(ROOT), rejectedCode('UNSAFE_STATUS'));
      assert.equal(countDeletes(h), 0);
    }
  });
}

test('rejects ephemeral or missing runtime status', async () => {
  for (const overrides of [{ ephemeral: true }, { ephemeral: undefined }, { status: null }]) {
    const h = harness([thread(ROOT, overrides)]);
    await assert.rejects(h.engine.preview(ROOT));
    assert.equal(countDeletes(h), 0);
  }
});

test('protects the current root or descendant, including a route change after preview', async () => {
  const h = harness([thread(ROOT), thread(CHILD, { parentThreadId: ROOT })]);
  h.setCurrent(ROOT);
  await assert.rejects(h.engine.preview(ROOT), rejectedCode('CURRENT_THREAD'));
  h.setCurrent(null);
  const preview = await h.engine.preview(ROOT);
  h.setCurrent(CHILD);
  await assert.rejects(h.engine.remove(preview.token), rejectedCode('CURRENT_THREAD'));
  assert.equal(countDeletes(h), 0);
});

test('rejects unrelated threads, ancestry cycles and identity mismatch', async () => {
  for (const entries of [
    [thread(ROOT), thread(CHILD, { parentThreadId: OTHER })],
    [thread(ROOT), thread(CHILD, { parentThreadId: GRANDCHILD }), thread(GRANDCHILD, { parentThreadId: CHILD })],
  ]) {
    await assert.rejects(harness(entries).engine.preview(ROOT), rejectedCode('INVALID_SUBTREE'));
  }
  const h = harness([thread(ROOT)], { rpc: method => method === 'thread/read' ? { thread: thread(OTHER) } : undefined });
  await assert.rejects(h.engine.preview(ROOT), rejectedCode('INVALID_RESPONSE'));
});

test('changes to contents or subtree invalidate the preview', async () => {
  for (const change of [
    h => { h.store.get(ROOT).updatedAt++; },
    h => { h.store.get(ROOT).name = 'renamed'; },
    h => { h.store.set(CHILD, thread(CHILD, { parentThreadId: ROOT })); },
  ]) {
    const h = harness();
    const preview = await h.engine.preview(ROOT);
    change(h);
    await assert.rejects(h.engine.remove(preview.token), rejectedCode('THREAD_CHANGED'));
    assert.equal(countDeletes(h), 0);
  }
});

test('an RPC failure during the confirmation recheck prevents delete', async () => {
  let failRead = false;
  const h = harness([thread(ROOT)], { beforeRpc: async method => {
    if (failRead && method === 'thread/read') throw new Error('connection closed');
  } });
  const preview = await h.engine.preview(ROOT);
  failRead = true;
  await assert.rejects(h.engine.remove(preview.token), /connection closed/);
  assert.equal(countDeletes(h), 0);
});

test('tokens are unforgeable, expire in five minutes and cannot be replayed', async () => {
  const h = harness();
  const preview = await h.engine.preview(ROOT);
  await assert.rejects(h.engine.remove({}), rejectedCode('INVALID_TOKEN'));
  h.advance(300000);
  await assert.rejects(h.engine.remove(preview.token), rejectedCode('EXPIRED_TOKEN'));
  await assert.rejects(h.engine.remove(preview.token), rejectedCode('INVALID_TOKEN'));
  const fresh = await h.engine.preview(ROOT);
  await h.engine.remove(fresh.token);
  await assert.rejects(h.engine.remove(fresh.token), rejectedCode('INVALID_TOKEN'));
  assert.equal(countDeletes(h), 1);
});

test('duplicate clicks cannot send concurrent deletes', async () => {
  let release;
  let waitForRead = false;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = harness([thread(ROOT)], { beforeRpc: async method => {
    if (waitForRead && method === 'thread/read') await waiting;
  } });
  const preview = await h.engine.preview(ROOT);
  waitForRead = true;
  const first = h.engine.remove(preview.token);
  await assert.rejects(h.engine.remove(preview.token), rejectedCode('BUSY'));
  release();
  await first;
  assert.equal(countDeletes(h), 1);
});

test('delete failure or timeout is never retried', async () => {
  const h = harness([thread(ROOT)], { deleteFailure: new Error('RPC timed out') });
  const preview = await h.engine.preview(ROOT);
  await assert.rejects(h.engine.remove(preview.token), error =>
    error.code === 'DELETE_UNCONFIRMED' && error.unknownResult);
  await assert.rejects(h.engine.remove(preview.token), rejectedCode('INVALID_TOKEN'));
  assert.equal(countDeletes(h), 1);
});

test('reads all subtree pages and rejects repeated cursors or missing pagination metadata', async () => {
  const child = thread(CHILD, { parentThreadId: ROOT });
  const grandchild = thread(GRANDCHILD, { parentThreadId: CHILD });
  const h = harness([thread(ROOT), child, grandchild], { rpc: (method, params) => {
    if (method !== 'thread/list' || params.archived) return undefined;
    return { data: [params.cursor === null ? child : grandchild], nextCursor: params.cursor === null ? 'page-2' : null };
  } });
  assert.equal((await h.engine.preview(ROOT)).targets.length, 3);
  for (const response of [{ data: [], nextCursor: 'repeated' }, { data: [] }]) {
    const invalid = harness([thread(ROOT)], { rpc: method => method === 'thread/list' ? response : undefined });
    await assert.rejects(invalid.engine.preview(ROOT), rejectedCode('INVALID_RESPONSE'));
    assert.equal(countDeletes(invalid), 0);
  }
});

test('enforces the 200-thread subtree limit', async () => {
  const children = Array.from({ length: 200 }, (_, i) => thread(
    `01900000-0000-7000-8000-${(i + 2).toString(16).padStart(12, '0')}`, { parentThreadId: ROOT }));
  const h = harness([thread(ROOT), ...children]);
  await assert.rejects(h.engine.preview(ROOT), rejectedCode('LIMIT_EXCEEDED'));
  assert.equal(countDeletes(h), 0);
});

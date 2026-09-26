import assert from 'node:assert/strict';
import test from 'node:test';
import { DeleteService } from '../plugins/agentchat-del/src/service.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const copy = value => structuredClone(value);

function thread(id, overrides = {}) {
  return { id, name: `Chat ${id[0]}`, preview: 'Title only', createdAt: 100, updatedAt: 200,
    parentThreadId: null, sessionId: id, ephemeral: false, status: { type: 'notLoaded' },
    cwd: 'C:\\test-project', path: `C:\\isolated\\${id}.jsonl`, ...overrides };
}

function fixture(initial = [thread(B)], options = {}) {
  const stored = new Map(initial.map(item => [item.id, copy(item)]));
  const live = new Map(initial.map(item => [item.id,
    { id: item.id, kind: 'codex', hostId: 'local', status: { type: 'notLoaded' } }]));
  const nativeCalls = [];
  const desktopCalls = [];
  const events = [];
  let opens = 0;
  let closes = 0;
  const state = { stored, live, nativeCalls, desktopCalls, events,
    get opens() { return opens; }, get closes() { return closes; } };
  const native = {
    async request(method, params) {
      nativeCalls.push({ method, params: copy(params) });
      events.push(`native:${method}:${params.threadId ?? params.ancestorThreadId ?? ''}`);
      if (options.onNative) {
        const result = await options.onNative(method, params, state);
        if (result !== undefined) return result;
      }
      if (method === 'thread/read') {
        const entry = stored.get(params.threadId);
        if (!entry) throw Object.assign(new Error(`thread not found: ${params.threadId}`), { code: -32600 });
        return { thread: copy(entry) };
      }
      if (method === 'thread/list') {
        return { data: [...stored.values()].filter(entry => entry.id !== params.ancestorThreadId &&
          Boolean(entry.archived) === params.archived).map(copy), nextCursor: null };
      }
      if (method === 'thread/delete') {
        if (options.deleteFailure) throw options.deleteFailure;
        if (!options.keepAfterDelete) stored.clear();
        return {};
      }
      throw new Error(`Unexpected native method ${method}`);
    },
    close() { closes++; },
  };
  const desktop = {
    async read(caller, target) {
      desktopCalls.push({ caller, target });
      events.push(`desktop:read:${target}`);
      await options.onDesktop?.(caller, target, state);
      return copy(live.get(target));
    },
  };
  state.service = new DeleteService({ desktop, openNative: async () => { opens++; return native; }, now: () => 1000 });
  state.confirm = async (message) => { state.prompt = message; return true; };
  return state;
}

const deletes = h => h.nativeCalls.filter(call => call.method === 'thread/delete');

test('service denies A deleting A before any desktop or native request', async () => {
  const h = fixture();
  await assert.rejects(h.service.requestDelete(A, A, h.confirm), /禁止删除当前对话/);
  assert.equal(h.opens, 0);
  assert.deepEqual(h.desktopCalls, []);
  assert.deepEqual(h.nativeCalls, []);
});

for (const status of [{ type: 'active' }, { type: 'idle' }, { type: 'systemError' }, { type: 'unknown' }, null]) {
  test(`desktop status ${JSON.stringify(status)} is rejected before starting native worker`, async () => {
    const h = fixture();
    h.live.get(B).status = status;
    await assert.rejects(h.service.requestDelete(A, B, h.confirm), /正在运行|仍被桌面加载|状态未知/);
    assert.equal(h.opens, 0);
    assert.equal(deletes(h).length, 0);
  });
}

test('native worker notLoaded cannot override desktop active descendant status', async () => {
  const h = fixture([thread(B), thread(C, { parentThreadId: B, archived: true })]);
  h.live.get(C).status = { type: 'active' };
  let confirmations = 0;
  await assert.rejects(h.service.requestDelete(A, B, async () => { confirmations++; return true; }), /正在运行|仍被桌面加载/);
  assert.equal(confirmations, 0);
  assert.equal(deletes(h).length, 0);
  assert.equal(h.closes, 1);
});

test('service rejects root B whose spawned descendant is calling conversation A', async () => {
  const h = fixture([thread(B), thread(A, { parentThreadId: B })]);
  let confirmations = 0;
  await assert.rejects(h.service.requestDelete(A, B, async () => { confirmations++; return true; }), /禁止删除当前对话|不能删除当前/);
  assert.equal(confirmations, 0);
  assert.equal(deletes(h).length, 0);
  assert.ok(h.desktopCalls.every(call => call.target !== A));
});

test('user cancellation sends no deletion and closes the worker', async () => {
  const h = fixture();
  const result = await h.service.requestDelete(A, B, async () => false);
  assert.deepEqual(result, { deleted: false, cancelled: true });
  assert.equal(deletes(h).length, 0);
  assert.equal(h.closes, 1);
  assert.equal(h.service.deleting, false);
});

test('a target loaded after confirmation is rejected before deletion', async () => {
  const h = fixture();
  await assert.rejects(h.service.requestDelete(A, B, async () => {
    h.live.get(B).status = { type: 'idle' };
    return true;
  }), /正在运行|仍被桌面加载/);
  assert.equal(deletes(h).length, 0);
});

test('a descendant loaded after metadata checks is rejected by final desktop checks', async () => {
  const h = fixture([thread(B), thread(C, { parentThreadId: B })], {
    onDesktop(caller, target, state) {
      // C is checked in preview, again during reinspection, and once more immediately before delete.
      const reads = state.desktopCalls.filter(call => call.target === C).length;
      if (target === C && reads === 3) state.live.get(C).status = { type: 'active' };
    },
  });
  await assert.rejects(h.service.requestDelete(A, B, h.confirm), /正在运行|仍被桌面加载/);
  assert.equal(deletes(h).length, 0);
  assert.equal(h.desktopCalls.filter(call => call.target === C).length, 3);
});

test('new spawned descendant after confirmation requires a new preview', async () => {
  const h = fixture();
  await assert.rejects(h.service.requestDelete(A, B, async () => {
    h.stored.set(C, thread(C, { parentThreadId: B }));
    h.live.set(C, { id: C, kind: 'codex', hostId: 'local', status: { type: 'notLoaded' } });
    return true;
  }), /已经变化|重新预览/);
  assert.equal(deletes(h).length, 0);
});

test('metadata revision change after confirmation requires a new preview', async () => {
  const h = fixture();
  await assert.rejects(h.service.requestDelete(A, B, async () => {
    h.stored.get(B).updatedAt++;
    return true;
  }), /已经变化|重新预览/);
  assert.equal(deletes(h).length, 0);
});

test('native writer-lock rejection reports unknown result and is never retried', async () => {
  const h = fixture([thread(B)], {
    deleteFailure: Object.assign(new Error('thread writer lock is held'), { code: -32603 }),
  });
  await assert.rejects(h.service.requestDelete(A, B, h.confirm), /不要自动重试|不得自动重试/);
  assert.equal(deletes(h).length, 1);
  assert.equal(h.stored.has(B), true);
  assert.equal(h.closes, 1);
});

test('only native notLoaded and desktop notLoaded with explicit confirmation permit deletion', async () => {
  const h = fixture([thread(B), thread(C, { parentThreadId: B }), thread(D, { parentThreadId: C, archived: true })]);
  const result = await h.service.requestDelete(A, B, h.confirm);
  assert.deepEqual(result.deletedIds, [B, C, D]);
  assert.equal(result.deleted, true);
  assert.equal(result.backupCreated, false);
  assert.equal(deletes(h).length, 1);
  assert.equal(h.closes, 1);
  assert.ok(h.prompt.includes(B) && h.prompt.includes(C) && h.prompt.includes(D));
  assert.match(h.prompt, /不创建备份/);
  assert.ok(h.nativeCalls.every(call => ['thread/read', 'thread/list', 'thread/delete'].includes(call.method)));
  assert.ok(h.nativeCalls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === false));
  const deleteIndex = h.nativeCalls.findIndex(call => call.method === 'thread/delete');
  assert.deepEqual(h.nativeCalls.slice(deleteIndex + 1).filter(call => call.method === 'thread/read')
    .map(call => call.params.threadId), [B, C, D]);
  for (const target of [B, C, D]) {
    assert.ok(h.desktopCalls.filter(call => call.target === target).length >= 3);
  }
  assert.ok(h.desktopCalls.every(call => call.caller === A));
});

test('successful delete RPC with surviving record is reported as unverified and not retried', async () => {
  const h = fixture([thread(B)], { keepAfterDelete: true });
  await assert.rejects(h.service.requestDelete(A, B, h.confirm), /删除结果需要核实/);
  assert.equal(deletes(h).length, 1);
  assert.equal(h.stored.has(B), true);
});

test('post-delete not-found reads cannot hide a surviving state-db index entry', async () => {
  const h = fixture([thread(B)], {
    onNative(method, params, state) {
      if (method === 'thread/list' && state.nativeCalls.some(call => call.method === 'thread/delete')) {
        return { data: params.archived ? [thread(B)] : [], nextCursor: null };
      }
    },
  });
  await assert.rejects(h.service.requestDelete(A, B, h.confirm), /删除结果需要核实/);
  assert.equal(deletes(h).length, 1);
});

test('post-delete unrelated RPC errors never count as proof that a target is absent', async () => {
  const h = fixture([thread(B)], {
    onNative(method, params, state) {
      if (method === 'thread/read' && state.nativeCalls.some(call => call.method === 'thread/delete')) {
        throw Object.assign(new Error('database locked'), { code: -32603 });
      }
    },
  });
  await assert.rejects(h.service.requestDelete(A, B, h.confirm), /删除结果需要核实/);
  assert.equal(deletes(h).length, 1);
});

test('abort after confirmation cannot reach delete RPC', async () => {
  const h = fixture();
  const controller = new AbortController();
  const confirm = async () => { controller.abort(new Error('User cancelled')); return true; };
  confirm.signal = controller.signal;
  await assert.rejects(h.service.requestDelete(A, B, confirm), /User cancelled/);
  assert.equal(deletes(h).length, 0);
});

test('remote or non-Codex desktop identity is denied before opening native worker', async () => {
  for (const overrides of [{ hostId: 'remote' }, { kind: 'chatgpt' }, { id: C }]) {
    const h = fixture();
    Object.assign(h.live.get(B), overrides);
    await assert.rejects(h.service.requestDelete(A, B, h.confirm), /本机 Codex 会话/);
    assert.equal(h.opens, 0);
    assert.equal(deletes(h).length, 0);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import { serve } from '../plugins/agentchat-del/src/mcp.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

function fixture(t, { capabilities = { elicitation: { form: {} } }, service, elicitationTimeoutMs = 2000 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const waiters = new Set();
  const deletions = [];
  const operations = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      messages.push(message);
      for (const waiter of waiters) {
        if (waiter.predicate(message)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message); }
      }
    }
  });
  const defaultService = {
    async searchChats(caller, query, limit) { operations.push({ caller, query, limit }); return { chats: [{ id: B, title: '测试会话' }] }; },
    async requestDelete(caller, target, confirm) {
      operations.push({ caller, target });
      if (!await confirm(`永久删除 ${target}？无法撤销，不创建备份。`)) return { deleted: false, cancelled: true };
      confirm.signal.throwIfAborted();
      deletions.push({ caller, target });
      return { deleted: true, id: target };
    }
  };
  const server = serve(service ?? defaultService, { input, output, elicitationTimeoutMs });
  const send = message => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const wait = predicate => {
    const prior = messages.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Timed out waiting for MCP message')); }, 3000);
      waiters.add(waiter);
    });
  };
  const call = (id, name, args, meta = { threadId: A }) => send({ id, method: 'tools/call', params: { name, arguments: args, _meta: meta } });
  t.after(() => { server.close(); input.destroy(); output.destroy(); for (const waiter of waiters) clearTimeout(waiter.timer); });
  send({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' }, capabilities } });
  send({ method: 'notifications/initialized' });
  return { send, wait, call, input, output, server, messages, deletions, operations };
}

test('MCP exposes only search and confirmed deletion with correct annotations', async t => {
  const client = fixture(t);
  client.send({ id: 'list', method: 'tools/list' });
  const { result } = await client.wait(message => message.id === 'list');
  assert.deepEqual(result.tools.map(tool => tool.name), ['search_chats', 'delete_chat']);
  assert.equal(result.tools[0].annotations.readOnlyHint, true);
  assert.equal(result.tools[1].annotations.destructiveHint, true);
  assert.equal(result.tools[1].annotations.openWorldHint, false);
  assert.equal(result.tools[1].inputSchema.additionalProperties, false);
});

test('search forwards executor caller and enforces maximum of 30 results', async t => {
  const client = fixture(t);
  client.call(1, 'search_chats', { query: ' 测试 ' });
  const { result } = await client.wait(message => message.id === 1);
  assert.equal(result.isError, false);
  assert.deepEqual(client.operations, [{ caller: A, query: '测试', limit: 30 }]);
  client.call(2, 'search_chats', { query: '测试', limit: 31 });
  assert.equal((await client.wait(message => message.id === 2)).result.isError, true);
  assert.equal(client.operations.length, 1);
});

test('delete waits for explicit accepted boolean form confirmation', async t => {
  const client = fixture(t);
  client.call(1, 'delete_chat', { thread_id: B });
  const prompt = await client.wait(message => message.method === 'elicitation/create');
  assert.equal(prompt.params.mode, 'form');
  assert.deepEqual(prompt.params.requestedSchema.required, ['confirmed']);
  assert.equal(prompt.params.requestedSchema.properties.confirmed.default, false);
  assert.equal(prompt.params.requestedSchema.properties.confirmed.type, 'boolean');
  assert.equal(client.deletions.length, 0);
  client.send({ id: prompt.id, result: { action: 'accept', content: { confirmed: true } } });
  assert.equal((await client.wait(message => message.id === 1)).result.isError, false);
  assert.deepEqual(client.deletions, [{ caller: A, target: B }]);
});

for (const [label, response] of [
  ['decline', { action: 'decline' }],
  ['cancel', { action: 'cancel' }],
  ['unchecked', { action: 'accept', content: { confirmed: false } }],
  ['string boolean', { action: 'accept', content: { confirmed: 'true' } }],
  ['missing content', { action: 'accept' }]
]) {
  test(`delete does not delete for ${label}`, async t => {
    const client = fixture(t);
    client.call(1, 'delete_chat', { thread_id: B });
    const prompt = await client.wait(message => message.method === 'elicitation/create');
    client.send({ id: prompt.id, result: response });
    const result = (await client.wait(message => message.id === 1)).result;
    assert.equal(result.structuredContent.cancelled, true);
    assert.equal(client.deletions.length, 0);
  });
}

for (const capabilities of [{}, { elicitation: {} }, { elicitation: { url: {} } }, { elicitation: { form: null } }]) {
  test(`deletion fails closed without form capability ${JSON.stringify(capabilities)}`, async t => {
    const client = fixture(t, { capabilities });
    client.call(1, 'delete_chat', { thread_id: B });
    assert.equal((await client.wait(message => message.id === 1)).result.isError, true);
    assert.equal(client.operations.length, 0);
    assert.equal(client.deletions.length, 0);
  });
}

for (const meta of [
  null, {}, { threadId: 'not-a-uuid' },
  { threadId: A, 'x-codex-turn-metadata': { thread_id: C } },
  { threadId: A, 'x-codex-turn-metadata': 'malformed' },
  { threadId: A, 'x-codex-turn-metadata': { thread_id: false } }
]) {
  test(`missing, invalid or conflicting executor identity is rejected ${JSON.stringify(meta)}`, async t => {
    const client = fixture(t);
    client.call(1, 'delete_chat', { thread_id: B }, meta);
    assert.equal((await client.wait(message => message.id === 1)).result.isError, true);
    assert.equal(client.operations.length, 0);
  });
}

test('caller identity can come from serialized turn metadata and self deletion is denied', async t => {
  const client = fixture(t);
  client.call(1, 'delete_chat', { thread_id: A }, { 'x-codex-turn-metadata': JSON.stringify({ thread_id: A }) });
  assert.match((await client.wait(message => message.id === 1)).result.content[0].text, /不能删除当前会话/);
  assert.equal(client.operations.length, 0);
  client.call(2, 'search_chats', { query: '测试' }, { 'x-codex-turn-metadata': JSON.stringify({ thread_id: A }) });
  assert.equal((await client.wait(message => message.id === 2)).result.isError, false);
  assert.equal(client.operations[0].caller, A);
});

test('unknown arguments cannot bypass current-thread identity or confirmation', async t => {
  const client = fixture(t);
  client.call(1, 'delete_chat', { thread_id: B, confirmed: true, currentThreadId: C });
  assert.equal((await client.wait(message => message.id === 1)).result.isError, true);
  assert.equal(client.operations.length, 0);
});

test('parallel calls retain independent callers and confirmation IDs', async t => {
  const client = fixture(t);
  client.call(1, 'delete_chat', { thread_id: B }, { threadId: A });
  const first = await client.wait(message => message.method === 'elicitation/create');
  client.call(2, 'delete_chat', { thread_id: D }, { threadId: C });
  const second = await client.wait(message => message.method === 'elicitation/create' && message.id !== first.id);
  client.send({ id: second.id, result: { action: 'accept', content: { confirmed: true } } });
  client.send({ id: first.id, result: { action: 'decline' } });
  await Promise.all([client.wait(message => message.id === 1), client.wait(message => message.id === 2)]);
  assert.deepEqual(client.deletions, [{ caller: C, target: D }]);
});

test('cancelled tool invocation ignores a later accepted confirmation', async t => {
  const client = fixture(t);
  client.call(1, 'delete_chat', { thread_id: B });
  const prompt = await client.wait(message => message.method === 'elicitation/create');
  client.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
  client.send({ id: prompt.id, result: { action: 'accept', content: { confirmed: true } } });
  assert.equal((await client.wait(message => message.id === 1)).result.isError, true);
  assert.equal(client.deletions.length, 0);
});

test('stdin disconnect while confirmation is pending cancels deletion', async t => {
  const client = fixture(t);
  client.call(1, 'delete_chat', { thread_id: B });
  await client.wait(message => message.method === 'elicitation/create');
  client.input.end();
  await client.server.closed;
  await nextTick();
  assert.equal(client.deletions.length, 0);
});

test('disconnect after confirmation aborts the service before deletion', async t => {
  let release;
  let confirmed;
  let deleted = false;
  const confirmedPromise = new Promise(resolve => { confirmed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const client = fixture(t, { service: {
    async requestDelete(caller, target, confirm) {
      if (!await confirm(`Delete ${target}`)) return { cancelled: true };
      confirmed();
      await gate;
      confirm.signal.throwIfAborted();
      deleted = true;
      return { deleted: true };
    }
  } });
  client.call(1, 'delete_chat', { thread_id: B });
  const prompt = await client.wait(message => message.method === 'elicitation/create');
  client.send({ id: prompt.id, result: { action: 'accept', content: { confirmed: true } } });
  await confirmedPromise;
  client.input.end();
  await client.server.closed;
  release();
  await nextTick();
  assert.equal(deleted, false);
});

test('confirmation timeout fails without deletion', async t => {
  const client = fixture(t, { elicitationTimeoutMs: 10 });
  client.call(1, 'delete_chat', { thread_id: B });
  assert.equal((await client.wait(message => message.id === 1)).result.isError, true);
  assert.equal(client.deletions.length, 0);
});

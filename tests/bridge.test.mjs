import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../renderer/bridge.js', import.meta.url), 'utf8');

function bridge() {
  let api;
  const sent = [];
  const events = new Map();
  const window = {
    electronBridge: { sendMessageFromView: message => { sent.push(message); } },
    addEventListener: (type, fn) => events.set(type, fn),
    removeEventListener: (type, fn) => { if (events.get(type) === fn) events.delete(type); },
  };
  window.top = window;
  const context = vm.createContext({
    window, location: { href: 'app://-/threads/00000000-0000-7000-8000-000000000001', pathname: '/threads/00000000-0000-7000-8000-000000000001' },
    document: { querySelector: () => null }, crypto: webcrypto, setTimeout, clearTimeout,
    CodexDeleteEngine: { create: options => { api = options; return options; } },
  });
  vm.runInContext(source, context);
  return { window, sent, api, location: context.location, reply(data) {
    let stopped = false;
    events.get('message')({ source: null, data, stopImmediatePropagation: () => { stopped = true; } });
    return stopped;
  }};
}

test('renderer bridge routes requests to the local host and consumes only its own replies', async () => {
  const b = bridge();
  const response = b.api.rpc('thread/read', { threadId: 'example', includeTurns: false });
  assert.equal(b.sent[0].hostId, 'local');
  assert.equal(b.sent[0].priority, 'interactive');
  assert.equal(b.sent[0].source, 'thread');
  assert.equal(b.sent[0].request.method, 'thread/read');
  assert.equal(b.reply({ type: 'mcp-response', hostId: 'other', message: { id: b.sent[0].request.id, result: {} } }), false);
  assert.equal(b.reply({ type: 'mcp-response', hostId: 'local', message: { id: 'unrelated', result: {} } }), false);
  assert.equal(b.reply({ type: 'mcp-response', hostId: 'local', message: { id: b.sent[0].request.id, result: { ok: true } } }), true);
  assert.deepEqual(await response, { ok: true });
  b.window.__codexDeleteOnlyBridge.dispose();
});

test('renderer bridge preserves native errors and rejects unexpected operations', async () => {
  const b = bridge();
  const response = b.api.rpc('thread/delete', { threadId: 'example' });
  b.reply({ type: 'mcp-response', hostId: 'local', message: { id: b.sent[0].request.id, error: { code: -32601, message: 'Method not found' } } });
  await assert.rejects(response, error => error.code === -32601 && /不支持/.test(error.message));
  await assert.rejects(b.api.rpc('command/exec', {}), /不支持/);
  assert.equal(b.sent.length, 1);
  assert.equal(b.api.currentThreadId(), '00000000-0000-7000-8000-000000000001');
  b.window.__codexDeleteOnlyBridge.dispose();
});

test('renderer teardown rejects pending reads without issuing another request', async () => {
  const b = bridge();
  const response = b.api.rpc('thread/read', {});
  b.window.__codexDeleteOnlyBridge.dispose();
  await assert.rejects(response, /重新加载/);
  assert.equal(b.sent.length, 1);
});

test('current conversation protection works with collapsed sidebar on native and hotkey routes', () => {
  const b = bridge();
  const id = '00000000-0000-7000-8000-000000000001';
  for (const route of [`/local/${id}`, `/local/local%3A${id}`, `/hotkey-window/thread/${id}`, `/threads/${id}`]) {
    b.location.pathname = route;
    assert.equal(b.api.currentThreadId(), id);
  }
  b.location.pathname = `/remote/${id}`;
  assert.equal(b.api.currentThreadId(), null);
  b.window.__codexDeleteOnlyBridge.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildInjectionSource } from '../src/launcher.mjs';
import { CDP } from '../src/cdp.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('injection compiles and runs only for a top-level Codex document after DOM readiness', () => {
  const scripts = ['engine.js', 'bridge.js', 'ui.js'].map(name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), 'utf8'));
  assert.doesNotThrow(() => new vm.Script(buildInjectionSource(scripts)));
  const source = buildInjectionSource(['window.called = true;']);
  let ready;
  const window = {}; window.top = window;
  const context = { window, location: { href: 'app://-/threads/example' }, document: { readyState: 'loading', addEventListener: (name, fn) => { ready = fn; } } };
  vm.runInNewContext(source, context);
  assert.equal(window.called, undefined);
  ready();
  assert.equal(window.called, true);
  window.called = false;
  context.document.readyState = 'complete';
  context.location.href = 'https://example.com';
  vm.runInNewContext(source, context);
  assert.equal(window.called, false);
  context.location.href = 'app://-/';
  window.top = {};
  vm.runInNewContext(source, context);
  assert.equal(window.called, false);
});

test('launcher rejects invalid ports and unknown options', () => {
  for (const value of ['0', '1023', '65536', 'NaN', '1.5']) {
    assert.throws(() => parseArgs(['--port', value]), /端口/);
  }
  assert.throws(() => parseArgs(['--kill-codex']), /未知/);
  assert.throws(() => parseArgs(['--exe']), /完整路径/);
  assert.equal(parseArgs(['--doctor', '--port', '23456']).port, 23456);
  assert.equal(parseArgs(['--attach-only']).attachOnly, true);
});

class Socket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
}

test('CDP correlates out of order replies and does not treat events as replies', async () => {
  const socket = new Socket();
  const cdp = new CDP(socket);
  const seen = [];
  cdp.onEvent(event => seen.push(event.method));
  const first = cdp.call('one');
  const second = cdp.call('two');
  socket.receive({ method: 'Page.ready' });
  socket.receive({ id: 2, result: { value: 2 } });
  socket.receive({ id: 1, result: { value: 1 } });
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await second, { value: 2 });
  assert.deepEqual(seen, ['Page.ready']);
  cdp.close();
});

test('CDP errors, timeout and disconnection reject outstanding requests', async () => {
  const socket = new Socket();
  const cdp = new CDP(socket);
  const error = cdp.call('bad');
  socket.receive({ id: 1, error: { message: 'unsupported' } });
  await assert.rejects(error, /unsupported/);
  await assert.rejects(cdp.call('slow', {}, 10), /超时/);
  const lost = cdp.call('lost');
  socket.close();
  await assert.rejects(lost, /关闭/);
  assert.equal(cdp.pending.size, 0);
});

test('CDP rejects non-loopback websocket targets', async () => {
  await assert.rejects(CDP.connect('ws://example.com:19379/devtools/page/1'), /本机/);
  await assert.rejects(CDP.connect('wss://127.0.0.1:19379/devtools/page/1'), /本机/);
});

// Opt-in only; npm test does not run this file.
// Usage: node tests/native-smoke.mjs C:\absolute\path\to\codex.exe
// The child gets a new isolated CODEX_HOME and no credentials. No turn is ever started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) {
  throw new Error('Provide an absolute path to the native codex executable. No real Codex home is used.');
}
const binary = await realpath(executable);
const probeRoot = fileURLToPath(new URL('../../.reference/probe-home/', import.meta.url));
await mkdir(probeRoot, { recursive: true });
const isolatedHome = await mkdtemp(path.join(probeRoot, 'native-smoke-'));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'].includes(key.toUpperCase())) {
    env[key] = value;
  }
}
Object.assign(env, {
  CODEX_HOME: isolatedHome, HOME: isolatedHome, USERPROFILE: isolatedHome,
  APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
});
const child = spawn(binary, [
  '-c', 'model="probe-model"', '-c', 'model_provider="probe"',
  '-c', 'model_providers.probe={name="Isolated Smoke Test",base_url="http://127.0.0.1:1",wire_api="responses"}',
  'app-server', '--stdio',
], { cwd: isolatedHome, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
const calls = [];
const notifications = [];
let stderr = '';
let nextId = 0;
const exited = new Promise(resolve => child.once('close', resolve));
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) {
    notifications.push(message);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) {
    entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  } else {
    entry.resolve(message.result);
  }
});
child.on('error', error => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
});
function rpc(method, params) {
  calls.push({ method, params });
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

try {
  const initialized = await rpc('initialize', {
    clientInfo: { name: 'codex-delete-only-isolated-smoke', title: 'Isolated Delete Smoke', version: '1.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  assert.equal(path.resolve(initialized.codexHome), path.resolve(isolatedHome));
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const started = await rpc('thread/start', { cwd: isolatedHome, ephemeral: false, environments: [] });
  const createdId = started.thread.id;
  assert.equal(path.resolve(started.thread.cwd), path.resolve(isolatedHome));
  assert.equal(started.thread.status.type, 'idle');
  const context = vm.createContext({});
  vm.runInContext(await readFile(new URL('../renderer/engine.js', import.meta.url), 'utf8'), context);
  const engine = context.CodexDeleteEngine.create({
    currentThreadId: () => null,
    rpc: (method, params) => {
      assert.ok(['thread/read', 'thread/list', 'thread/delete'].includes(method));
      assert.equal(method === 'thread/list' ? params.ancestorThreadId : params.threadId, createdId);
      return rpc(method, params);
    },
  });
  const preview = await engine.preview(createdId);
  assert.equal(preview.targets.length, 1);
  const removed = await engine.remove(preview.token);
  assert.deepEqual(Array.from(removed.deletedIds), [createdId]);
  const listCalls = calls.filter(call => call.method === 'thread/list');
  assert.equal(listCalls.length, 4); // archived + unarchived, both preview and confirmation recheck
  assert.ok(listCalls.every(call => call.params.sourceKinds.length === 10 &&
    call.params.ancestorThreadId === createdId && call.params.modelProviders.length === 0));
  assert.ok(listCalls.some(call => call.params.archived === true));
  assert.ok(listCalls.some(call => call.params.archived === false));
  await assert.rejects(rpc('thread/read', { threadId: createdId, includeTurns: false }), error =>
    error.code === -32600 && /thread not loaded|thread not found|no rollout found/i.test(error.message));
  assert.equal(calls.filter(call => call.method === 'thread/delete').length, 1);
  assert.ok(notifications.some(item => item.method === 'thread/deleted' && item.params.threadId === createdId));
  console.log(JSON.stringify({
    passed: true, userAgent: initialized.userAgent, isolatedHome, createdId,
    enginePreview: 'passed', engineRemove: 'passed', metadataReadAfterDelete: 'not found',
    descendantFilterRequests: listCalls.length, deletedNotification: true, modelTurnsStarted: 0,
  }, null, 2));
} finally {
  child.stdin.end();
  const termination = setTimeout(() => child.kill(), 3000);
  await exited;
  clearTimeout(termination);
  lines.close();
  await writeFile(path.join(isolatedHome, 'smoke-stderr.log'), stderr, 'utf8');
}

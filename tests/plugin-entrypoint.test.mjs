import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

test('installed entrypoint exposes two tools, rejects self deletion, and exits on stdin close', async () => {
  const plugin = fileURLToPath(new URL('../plugins/agentchat-del/', import.meta.url));
  const child = spawn(process.execPath, ['./src/server.mjs'], {
    cwd: plugin, windowsHide: true, env: {}, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  let nextId = 0;
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const timeout = setTimeout(() => child.kill(), 4000);
  const request = (method, params) => new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'test', version: '1.0.0' } });
    assert.equal(initialized.result.serverInfo.name, 'agentchat-del');
    const listed = await request('tools/list', {});
    assert.deepEqual(listed.result.tools.map(tool => tool.name), ['search_chats', 'delete_chat']);
    const caller = '01900000-0000-7000-8000-000000000001';
    const denied = await request('tools/call', { name: 'delete_chat', arguments: { thread_id: caller },
      _meta: { 'openai/threadId': caller } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /当前会话/);
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(stderr, '');
  } finally { clearTimeout(timeout); child.kill(); lines.close(); }
});

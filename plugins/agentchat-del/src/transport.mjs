import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;

export class PipeClient {
  constructor(pipePath, timeout = 20000) {
    if (!pipePath) throw new Error('缺少桌面连接。请在本机 Codex 桌面的新聊天中使用此插件。');
    this.pipePath = pipePath;
    this.timeout = timeout;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      this.socket = socket;
      const timer = setTimeout(() => socket.destroy(new Error('桌面连接超时。')), this.timeout);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('error', error => { clearTimeout(timer); reject(error); this.fail(error); });
      socket.on('close', () => { clearTimeout(timer); this.fail(new Error('桌面连接已关闭。')); });
      socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (size > LIMIT) { socket.destroy(new Error('桌面响应超过上限。')); return; }
          if (this.buffer.length < size + 4) return;
          const bytes = this.buffer.subarray(4, size + 4);
          this.buffer = this.buffer.subarray(size + 4);
          try {
            const message = JSON.parse(bytes.toString('utf8'));
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
          } catch { socket.destroy(new Error('桌面响应格式无效。')); return; }
        }
      });
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
  async request(method, params) {
    await this.connect();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('桌面响应超时；已停止操作。'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      this.socket.write(Buffer.concat([header, body]));
    });
  }
  close() { this.socket?.destroy(); this.fail(new Error('连接已关闭。')); }
}

export function desktopClient(pipe) {
  return {
    async read(callerId, targetId) {
      const response = await pipe.request('tools/call', {
        namespace: 'codex_app', tool: 'read_thread', callerSource: 'codex',
        threadId: callerId, turnId: 'agentchat-del-read', callId: randomUUID(),
        arguments: { threadId: targetId, hostId: 'local', turnLimit: 1,
          includeOutputs: false, maxOutputCharsPerItem: 0 },
      });
      if (response?.success !== true) throw new Error('无法从桌面确认会话状态，已停止删除。');
      for (const item of response.contentItems ?? []) {
        if (item.type !== 'inputText') continue;
        try {
          const value = JSON.parse(item.text);
          if (value.thread) return value.thread;
        } catch { /* Only the structured thread response is usable. */ }
      }
      throw new Error('桌面未返回可验证的会话信息。');
    },
  };
}

export async function findCodex(env = process.env) {
  if (process.platform !== 'win32') throw new Error('当前版本只支持 Windows Codex 桌面。');
  const configured = env.CODEX_CLI_PATH;
  if (configured && path.isAbsolute(configured) && /codex\.exe$/i.test(configured) &&
      (await stat(configured)).isFile()) return configured;
  // Read executable locations only; never read process command lines or credentials.
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process -Name codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 10000 });
  const decoded = stdout.trim() ? JSON.parse(stdout) : [];
  const paths = (Array.isArray(decoded) ? decoded : [decoded]).filter(p =>
    typeof p === 'string' && path.isAbsolute(p) && /codex\.exe$/i.test(p));
  if (paths.length !== 1) throw new Error('无法唯一定位桌面正在使用的 codex.exe；请关闭其他版本后重试。');
  return paths[0];
}

export class NativeClient {
  constructor(executable, env = process.env, { timeout = 20000 } = {}) {
    this.pending = new Map();
    this.nextId = 0;
    this.timeout = timeout;
    this.env = env;
    this.child = spawn(executable, ['app-server', '--stdio'], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Protocol errors are surfaced through RPC; do not log user data from native stderr.
    this.child.stderr.resume();
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      if (line.length > LIMIT) { this.close(); return; }
      let message;
      try { message = JSON.parse(line); } catch { this.close(); return; }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else item.resolve(message.result);
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex 会话服务已退出。')));
    this.child.stdin.on('error', error => this.fail(error));
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  async initialize() {
    if (!this.env.CODEX_HOME) throw new Error('缺少 CODEX_HOME；拒绝猜测会话数据目录。');
    const info = await this.request('initialize', {
      clientInfo: { name: 'agentchat-del', title: 'AgentChat Delete', version: '2.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (typeof info?.codexHome !== 'string' ||
        path.resolve(info.codexHome).toLowerCase() !== path.resolve(this.env.CODEX_HOME).toLowerCase()) {
      throw new Error('会话服务的数据目录与桌面不一致，已停止。');
    }
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return info;
  }
  request(method, params) {
    if (!['initialize', 'thread/read', 'thread/list', 'thread/delete'].includes(method)) {
      throw new Error('不支持的会话操作。');
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('会话服务超时；不得自动重试删除。')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() {
    this.fail(new Error('会话服务已关闭。'));
    this.lines.close();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 2000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}

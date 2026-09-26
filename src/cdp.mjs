export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.id != null) {
        const item = this.pending.get(data.id);
        if (!item) return;
        this.pending.delete(data.id);
        clearTimeout(item.timer);
        if (data.error) item.reject(new Error(data.error.message));
        else item.resolve(data.result);
      } else {
        for (const fn of this.listeners) fn(data);
      }
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Codex 窗口连接已关闭。'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('仅允许连接本机 Codex 调试端口。');
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('连接 Codex 调试端口超时。')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 Codex 调试端口。')); }, { once: true });
    });
    return new CDP(socket);
  }

  call(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) return reject(new Error('Codex 连接不可用。'));
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 调试请求超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(fn) { this.listeners.add(fn); }
  close() { this.socket.close(); }
}

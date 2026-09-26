(() => {
  'use strict';
  if (window.top !== window || !/^app:\/\/-\//.test(location.href) || !window.electronBridge?.sendMessageFromView) return;
  window.__codexDeleteOnlyBridge?.dispose();
  const pending = new Map();
  const prefix = `codex-delete-only-${crypto.randomUUID()}-`;
  let counter = 0;

  function rpc(method, params) {
    const allowed = ['thread/read', 'thread/list', 'thread/delete'];
    if (!allowed.includes(method)) return Promise.reject(new Error('不支持的会话操作。'));
    return new Promise((resolve, reject) => {
      const id = prefix + (++counter);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method === 'thread/delete'
          ? '删除请求超时，结果未知。请查看会话列表确认；不要立即重复删除。'
          : '读取会话超时，请稍后重新预览。'));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      Promise.resolve(window.electronBridge.sendMessageFromView({
        type: 'mcp-request', hostId: 'local', priority: 'interactive', source: 'thread', request: { id, method, params }
      })).catch(error => {
        const item = pending.get(id);
        if (!item) return;
        clearTimeout(timer); pending.delete(id); reject(error);
      });
    });
  }

  function response(event) {
    if (event.source !== window && event.source !== null) return;
    const data = event.data;
    if (data?.type !== 'mcp-response' || data.hostId !== 'local') return;
    const reply = data.message;
    const item = pending.get(reply?.id);
    if (!item) return;
    event.stopImmediatePropagation();
    pending.delete(reply.id); clearTimeout(item.timer);
    if (reply.error) {
      const error = new Error(reply.error.code === -32601
        ? '当前 Codex 不支持所需会话接口，请升级 Codex；本插件不会直接修改数据库。'
        : (reply.error.message || 'Codex 拒绝了会话操作。'));
      error.code = reply.error.code;
      item.reject(error);
    } else item.resolve(reply.result);
  }
  window.addEventListener('message', response, true);

  function currentThreadId() {
    let pathname = location.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* Keep invalid escapes uninterpreted. */ }
    const match = pathname.match(/^\/(?:local|threads?|hotkey-window\/thread)\/(?:local:)?([0-9a-f-]{36})(?:\/|$)/i);
    if (match) return match[1].toLowerCase();
    const row = document.querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-kind="local"][data-app-action-sidebar-thread-host-id="local"]');
    return row?.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/, '').toLowerCase() ?? null;
  }
  window.__codexDeleteOnlyApi = globalThis.CodexDeleteEngine.create({ rpc, currentThreadId });
  window.__codexDeleteOnlyBridge = {
    dispose() {
      window.removeEventListener('message', response, true);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('删除插件已重新加载，请重新预览。')); }
      pending.clear();
      delete window.__codexDeleteOnlyApi;
    }
  };
})();

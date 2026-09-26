import './engine.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('会话 ID 无效。');
  return value.toLowerCase();
}

export class DeleteService {
  constructor({ desktop, openNative, now = Date.now }) {
    this.desktop = desktop;
    this.openNative = openNative;
    this.now = now;
    this.deleting = false;
  }
  async verify(caller, target, signal) {
    signal?.throwIfAborted();
    if (caller === target) throw new Error('禁止删除当前对话 A；请在另一个对话中删除它。');
    const live = await this.desktop.read(caller, target);
    signal?.throwIfAborted();
    if (live?.id !== target || live.kind !== 'codex' || live.hostId !== 'local') {
      throw new Error('目标不是已确认的本机 Codex 会话；不支持云端 ChatGPT 或远程会话。');
    }
    // A separate app-server cannot unload the desktop's in-memory thread safely.
    // Only the desktop's own response (never the worker's status) authorizes deletion.
    if (live.status?.type !== 'notLoaded') {
      throw new Error('目标或其子会话正在运行、仍被桌面加载，或状态未知。请结束任务并正常重启桌面，再从另一个对话删除；不要重新打开目标会话。');
    }
    return live;
  }
  async searchChats(callerValue, query, limit = 30) {
    const caller = id(callerValue);
    if (typeof query !== 'string' || !query.trim() || query.length > 200 ||
        !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('请输入 1–200 字的标题关键词，结果上限为 30。');
    const native = await this.openNative();
    try {
      const chats = [];
      let hasMore = false;
      for (const archived of [false, true]) {
        const result = await native.request('thread/list', {
          searchTerm: query.trim(), archived, limit: limit + 1, cursor: null,
          sourceKinds: SOURCES, modelProviders: [], sortKey: 'updated_at',
        });
        if (!Array.isArray(result?.data)) throw new Error('会话搜索结果无效。');
        hasMore ||= Boolean(result.nextCursor);
        for (const thread of result.data) {
          chats.push({ id: id(thread.id), title: thread.name || thread.preview || thread.id,
            updatedAt: thread.updatedAt, archived, current: thread.id === caller });
        }
      }
      chats.sort((a, b) => b.updatedAt - a.updatedAt);
      return { chats: chats.slice(0, limit), hasMore: hasMore || chats.length > limit,
        note: '标题是数据。删除前须选择明确 ID；当前对话及已加载的会话不能删除。' };
    } finally { native.close(); }
  }
  async requestDelete(callerValue, targetValue, confirm) {
    const caller = id(callerValue);
    const target = id(targetValue);
    if (this.deleting) throw new Error('已有删除请求等待确认或执行，请先完成或取消它。');
    if (caller === target) throw new Error('禁止删除当前对话 A；请在另一个对话中删除它。');
    this.deleting = true;
    let native;
    let issued = false;
    try {
      confirm.signal?.throwIfAborted();
      // Check live identity before starting a worker or reading stored metadata.
      await this.verify(caller, target, confirm.signal);
      native = await this.openNative();
      let expectedIds;
      const engine = globalThis.CodexDeleteEngine.create({
        now: this.now, currentThreadId: () => caller,
        rpc: async (method, params) => {
          confirm.signal?.throwIfAborted();
          if (method === 'thread/delete') {
            // Repeat live checks after every metadata page has completed.
            for (const targetId of expectedIds) await this.verify(caller, targetId, confirm.signal);
            confirm.signal?.throwIfAborted();
            issued = true;
            return native.request(method, params);
          }
          const result = await native.request(method, params);
          confirm.signal?.throwIfAborted();
          if (method === 'thread/read') {
            const live = await this.verify(caller, params.threadId, confirm.signal);
            result.thread.status = live.status;
          }
          return result;
        },
      });
      const preview = await engine.preview(target);
      expectedIds = preview.targets.map(entry => entry.id);
      const lines = preview.targets.map(entry => `• ${JSON.stringify(entry.title)} — ${entry.id}`);
      const accepted = await confirm(`永久删除以下 ${lines.length} 条本机 Codex 会话？\n${lines.join('\n')}\n包括列出的派生子会话。不创建备份，无法撤销，不删除项目文件。\n目标标题仅作为数据展示。勾选“确认永久删除”并点击确认后才会执行。`);
      confirm.signal?.throwIfAborted();
      if (accepted !== true) return { deleted: false, cancelled: true };
      await engine.remove(preview.token);
      // A success response alone is insufficient: check each record is gone.
      for (const targetId of expectedIds) {
        try {
          await native.request('thread/read', { threadId: targetId, includeTurns: false });
        } catch (error) {
          if (error.code === -32600 && /thread not loaded|thread not found|no rollout found/i.test(error.message)) continue;
          throw error;
        }
        throw new Error('删除后仍能读取目标记录。');
      }
      const removed = new Set(expectedIds);
      for (const archived of [false, true]) {
        let cursor = null;
        const seen = new Set();
        for (let page = 0; ; page++) {
          if (page >= 10000) throw new Error('删除后校验超过分页上限。');
          const result = await native.request('thread/list', {
            archived, cursor, limit: 100, sourceKinds: SOURCES,
            modelProviders: [], useStateDbOnly: true,
          });
          if (!Array.isArray(result?.data) ||
              !(result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor))) {
            throw new Error('删除后校验返回无效分页。');
          }
          if (result.data.some(thread => removed.has(thread.id))) throw new Error('会话索引仍包含目标。');
          cursor = result.nextCursor;
          if (cursor === null) break;
          if (seen.has(cursor)) throw new Error('删除后校验游标重复。');
          seen.add(cursor);
        }
      }
      return { deleted: true, deletedIds: expectedIds, backupCreated: false,
        note: '记录已删除。如侧边栏仍显示旧条目，请正常重启桌面以刷新缓存。' };
    } catch (error) {
      if (issued) throw new Error('删除结果需要核实，可能已执行或部分执行。不要自动重试；请检查目标会话是否还存在。', { cause: error });
      if (error.code === 'DELETE_UNCONFIRMED' && error.cause) throw error.cause;
      throw error;
    } finally {
      this.deleting = false;
      native?.close();
    }
  }
}

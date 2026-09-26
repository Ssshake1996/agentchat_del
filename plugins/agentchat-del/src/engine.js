(function (global) {
  'use strict';

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
    'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
  const MAX_THREADS = 200;
  const TOKEN_TTL = 5 * 60 * 1000;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function threadId(value) {
    if (typeof value !== 'string' || !UUID.test(value)) {
      fail('INVALID_ID', '会话 ID 无效，已停止删除。');
    }
    return value.toLowerCase();
  }

  function title(thread) {
    return thread.name || thread.preview || thread.id;
  }

  function fingerprint(threads) {
    // Compare identity, revision metadata and runtime state with the approved preview.
    const keys = ['id', 'sessionId', 'parentThreadId', 'forkedFromId', 'name', 'preview', 'createdAt',
      'updatedAt', 'recencyAt', 'cwd', 'path', 'modelProvider', 'historyMode', 'ephemeral', 'status',
      'source', 'projectId', 'section', 'sectionEnteredAt'];
    return JSON.stringify(threads.map(thread => keys.map(key => thread[key] ?? null)));
  }

  function create({ rpc, currentThreadId, now = Date.now }) {
    if (typeof rpc !== 'function' || typeof currentThreadId !== 'function') {
      throw new TypeError('rpc and currentThreadId are required functions');
    }
    const previews = new Map();
    let removing = false;

    function validateThread(thread, expectedId) {
      if (!thread || thread.id !== expectedId || !Number.isFinite(thread.createdAt) ||
          !Number.isFinite(thread.updatedAt)) {
        fail('INVALID_RESPONSE', '无法确认会话身份或更新时间，已停止删除。');
      }
      const current = currentThreadId();
      if (typeof current === 'string' && current.toLowerCase() === expectedId) {
        fail('CURRENT_THREAD', '不能删除当前打开的会话；请先切换到其他会话。');
      }
      if (thread.ephemeral !== false) {
        fail('EPHEMERAL_THREAD', '临时会话或持久化状态未知，已停止删除。');
      }
      if (!thread.status || !['idle', 'notLoaded'].includes(thread.status.type)) {
        fail('UNSAFE_STATUS', '会话仍在运行、发生错误或状态未知，请停止运行后重新预览。');
      }
    }

    async function read(id) {
      const response = await rpc('thread/read', { threadId: id, includeTurns: false });
      validateThread(response && response.thread, id);
      return response.thread;
    }

    async function pages(method, params, accept) {
      let cursor = null;
      const seen = new Set();
      for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
        const response = await rpc(method, { ...params, cursor, limit: 100 });
        if (!response || !Array.isArray(response.data) ||
            !(response.nextCursor === null || (typeof response.nextCursor === 'string' && response.nextCursor))) {
          fail('INVALID_RESPONSE', '分页结果不完整，无法确认所有会话或记录，已停止删除。');
        }
        await accept(response.data);
        cursor = response.nextCursor;
        if (cursor === null) return;
        if (seen.has(cursor)) fail('INVALID_RESPONSE', '分页游标重复，已停止删除。');
        seen.add(cursor);
      }
      fail('LIMIT_EXCEEDED', '记录分页超过安全上限，已停止删除。');
    }

    async function inspect(rootId) {
      const root = await read(rootId);
      const listed = new Map();
      for (const archived of [false, true]) {
        await pages('thread/list', {
          ancestorThreadId: rootId, archived, sourceKinds: SOURCE_KINDS.slice(), modelProviders: [],
        }, data => {
          for (const entry of data) {
            const id = threadId(entry && entry.id);
            if (id === rootId || listed.has(id)) {
              fail('INVALID_SUBTREE', '子会话列表重复或发生变化，请重新预览。');
            }
            listed.set(id, entry);
            if (listed.size + 1 > MAX_THREADS) {
              fail('LIMIT_EXCEEDED', '此会话及其子会话超过 200 条，已停止删除。');
            }
          }
        });
      }
      const threads = [root];
      for (const id of Array.from(listed.keys()).sort()) {
        const thread = await read(id);
        if (thread.parentThreadId !== listed.get(id).parentThreadId) {
          fail('INVALID_SUBTREE', '子会话归属发生变化，请重新预览。');
        }
        threads.push(thread);
      }
      const byId = new Map(threads.map(thread => [thread.id, thread]));
      for (const thread of threads.slice(1)) {
        let parent = thread.parentThreadId;
        const visited = new Set([thread.id]);
        while (parent !== rootId) {
          if (!byId.has(parent) || visited.has(parent)) {
            fail('INVALID_SUBTREE', '无法确认子会话与目标的归属关系，已停止删除。');
          }
          visited.add(parent);
          parent = byId.get(parent).parentThreadId;
        }
      }
      // A route change during a paginated read must not turn this into deleting the open chat.
      threads.forEach(thread => validateThread(thread, thread.id));
      return threads;
    }

    function assertUnchanged(expected, actual) {
      if (fingerprint(expected) !== fingerprint(actual)) {
        fail('THREAD_CHANGED', '会话内容、状态或子会话列表已经变化，请重新预览后再删除。');
      }
    }

    async function preview(value) {
      if (removing) fail('BUSY', '正在处理删除，请等待完成。');
      const rootId = threadId(value);
      const threads = await inspect(rootId);
      const timestamp = now();
      for (const [token, record] of previews) {
        if (timestamp >= record.expiresAt) previews.delete(token);
      }
      // Only this object identity is accepted. The caller cannot forge or edit the stored target set.
      const token = Object.freeze({});
      const expiresAt = timestamp + TOKEN_TTL;
      previews.set(token, { rootId, threads, expiresAt });
      return { token, threadId: rootId, rootThreadId: rootId, title: title(threads[0]), expiresAt,
        targets: threads.map(thread => ({ id: thread.id, title: title(thread) })) };
    }

    async function remove(token) {
      if (removing) fail('BUSY', '正在处理删除，请勿重复点击。');
      const record = previews.get(token);
      if (!record) fail('INVALID_TOKEN', '预览已失效或已使用，请重新预览。');
      previews.delete(token);
      if (now() >= record.expiresAt) fail('EXPIRED_TOKEN', '预览已超过 5 分钟，请重新预览。');
      removing = true;
      try {
        const threads = await inspect(record.rootId);
        assertUnchanged(record.threads, threads);
        if (now() >= record.expiresAt) fail('EXPIRED_TOKEN', '检查期间预览已过期，请重新预览。');
        try {
          const result = await rpc('thread/delete', { threadId: record.rootId });
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('删除接口未返回有效确认');
          }
        } catch (cause) {
          const error = new Error('删除结果未确认，可能已部分执行；请检查会话列表，不要直接重试。');
          error.code = 'DELETE_UNCONFIRMED';
          error.unknownResult = true;
          error.cause = cause;
          throw error;
        }
        return { deletedIds: threads.map(thread => thread.id) };
      } finally {
        removing = false;
      }
    }

    return Object.freeze({ preview, remove });
  }

  global.CodexDeleteEngine = Object.freeze({ create });
})(globalThis);

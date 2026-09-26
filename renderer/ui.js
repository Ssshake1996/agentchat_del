/* Codex Delete Only — original renderer integration; no third-party dependencies. */
(() => {
  'use strict';

  const previous = window.__codexDeleteOnlyUI;
  const deletedIds = new Set(previous && Array.isArray(previous.deletedIds) ? previous.deletedIds : []);
  if (previous && typeof previous.dispose === 'function') previous.dispose();

  const ROW = '[data-app-action-sidebar-thread-id]';
  const OWNED = '[data-cdo-owned]';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const records = new Map();
  const pendingRows = new Set();
  const removers = [];
  let disposed = false;
  let scanTimer = null;
  let toastTimer = null;
  let dialogState = null;
  let toast = null;
  let requestVersion = 0;

  function normalizedId(value) {
    if (typeof value !== 'string') return null;
    const id = value.replace(/^local:/, '').toLowerCase();
    return UUID.test(id) && id !== '00000000-0000-0000-0000-000000000000' ? id : null;
  }

  function localTarget(row) {
    const raw = row.getAttribute('data-app-action-sidebar-thread-id') || '';
    const host = row.getAttribute('data-app-action-sidebar-thread-host-id');
    const kind = row.getAttribute('data-app-action-sidebar-thread-kind');
    if (kind !== 'local' || (host !== 'local' && !(host === null && raw.startsWith('local:')))) return null;
    return normalizedId(raw);
  }

  function routeId() {
    const match = window.location.pathname.match(/^\/(?:local|threads|thread|hotkey-window\/thread)\/([^/]+)/);
    if (!match) return null;
    try { return normalizedId(decodeURIComponent(match[1])); } catch { return null; }
  }

  function hasCurrentMarker(row) {
    const active = row.getAttribute('data-app-action-sidebar-thread-active');
    if (active === 'true' || active === '1') return true;
    const marker = row.getAttribute('aria-current');
    if (marker !== null && marker !== 'false') return true;
    return [...row.querySelectorAll('[aria-current]')].some(node => node.getAttribute('aria-current') !== 'false');
  }

  function isCurrent(id) {
    if (routeId() === id) return true;
    return [...document.querySelectorAll(ROW)].some(row => localTarget(row) === id && hasCurrentMarker(row));
  }

  function rowTitle(row) {
    const declared = row.getAttribute('data-app-action-sidebar-thread-title') || row.querySelector('[data-thread-title]')?.textContent;
    if (declared && declared.trim()) return declared.trim().slice(0, 240);
    const clone = row.cloneNode(true);
    clone.querySelectorAll('button, svg, [data-cdo-owned], [aria-hidden="true"]').forEach(node => node.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240) || '未命名会话';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    removers.push(() => node.removeEventListener(type, handler, options));
  }

  const style = el('style');
  style.dataset.cdoOwned = 'style';
  style.textContent = `
    .cdo-row { position: relative !important; }
    .cdo-row.cdo-deleted { display: none !important; }
    .cdo-delete {
      position: absolute; inset-inline-end: 30px; top: 50%; transform: translateY(-50%);
      display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
      border: 0; border-radius: 6px; padding: 5px; margin: 0; z-index: 3;
      color: inherit; background: var(--cdo-control-bg, #f3f3f3); cursor: pointer;
      font: inherit; opacity: 0; pointer-events: none; transition: opacity 100ms ease, background 100ms ease;
    }
    .cdo-row:hover > .cdo-delete, .cdo-row:focus-within > .cdo-delete, .cdo-delete:focus-visible {
      opacity: 1; pointer-events: auto;
    }
    .cdo-delete:hover { background: var(--cdo-hover-bg, #e5e5e5); color: var(--cdo-danger, #ad3030); }
    .cdo-delete:focus-visible, .cdo-dialog button:focus-visible, .cdo-toast button:focus-visible {
      outline: 2px solid var(--cdo-focus, #656565); outline-offset: 2px;
    }
    .cdo-delete svg { display: block; width: 16px; height: 16px; pointer-events: none; }
    .cdo-dialog, .cdo-toast {
      --cdo-panel: #fff; --cdo-ink: #242424; --cdo-muted: #666; --cdo-border: #e1e1e1;
      --cdo-control: #f1f1f1; --cdo-control-hover: #e7e7e7; --cdo-danger: #ad3030;
      color: var(--cdo-ink); background: var(--cdo-panel); font-family: inherit; font-size: 13px;
      line-height: 1.6; box-sizing: border-box; color-scheme: light dark;
    }
    .cdo-dialog {
      width: min(424px, calc(100vw - 40px)); max-height: calc(100vh - 48px); overflow: auto;
      border: 1px solid var(--cdo-border); border-radius: 14px; padding: 24px; margin: auto;
      box-shadow: 0 18px 64px #0003;
    }
    .cdo-dialog::backdrop { background: #0005; }
    .cdo-dialog h2 { font: inherit; font-size: 17px; font-weight: 650; margin: 0 0 12px; line-height: 1.5; }
    .cdo-title { font-weight: 550; overflow-wrap: anywhere; margin: 0 0 8px; white-space: pre-wrap; }
    .cdo-detail { color: var(--cdo-muted); margin: 0; }
    .cdo-status { margin: 14px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--cdo-control); overflow-wrap: anywhere; }
    .cdo-status[data-error="true"] { color: var(--cdo-danger); }
    .cdo-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
    .cdo-dialog button, .cdo-toast button {
      font: inherit; line-height: 1.4; border-radius: 7px; border: 1px solid var(--cdo-border);
      padding: 7px 15px; min-height: 34px; background: var(--cdo-panel); color: inherit; cursor: pointer;
    }
    .cdo-dialog button:hover, .cdo-toast button:hover { background: var(--cdo-control-hover); }
    .cdo-dialog .cdo-confirm { color: #fff; background: #ad3030; border-color: #ad3030; }
    .cdo-dialog .cdo-confirm:hover { background: #942727; border-color: #942727; }
    .cdo-dialog button:disabled { opacity: .45; cursor: default; }
    .cdo-dialog [hidden], .cdo-toast [hidden] { display: none !important; }
    .cdo-toast {
      position: fixed; z-index: 2147483646; inset-inline-end: 20px; bottom: 20px;
      width: min(420px, calc(100vw - 40px)); border: 1px solid var(--cdo-border); border-radius: 12px;
      padding: 16px 44px 16px 18px; box-shadow: 0 6px 30px #0002; overflow-wrap: anywhere;
    }
    .cdo-toast strong { display: block; font-size: 13px; margin: 0 0 3px; }
    .cdo-toast p { color: var(--cdo-muted); margin: 0; user-select: text; }
    .cdo-toast .cdo-toast-close { position: absolute; top: 9px; right: 9px; padding: 2px; width: 26px; min-height: 26px; border: 0; }
    @media (prefers-color-scheme: dark) {
      .cdo-delete { --cdo-control-bg: #303030; --cdo-hover-bg: #414141; --cdo-danger: #f49797; --cdo-focus: #b0b0b0; }
      .cdo-dialog, .cdo-toast { --cdo-panel: #262626; --cdo-ink: #f0f0f0; --cdo-muted: #b3b3b3; --cdo-border: #424242; --cdo-control: #343434; --cdo-control-hover: #3a3a3a; --cdo-danger: #f49797; --cdo-focus: #b0b0b0; }
    }
    :root.dark .cdo-delete, :root[data-theme="dark"] .cdo-delete { --cdo-control-bg: #303030; --cdo-hover-bg: #414141; --cdo-danger: #f49797; --cdo-focus: #b0b0b0; }
    :root.dark .cdo-dialog, :root.dark .cdo-toast, :root[data-theme="dark"] .cdo-dialog, :root[data-theme="dark"] .cdo-toast {
      --cdo-panel: #262626; --cdo-ink: #f0f0f0; --cdo-muted: #b3b3b3; --cdo-border: #424242;
      --cdo-control: #343434; --cdo-control-hover: #3a3a3a; --cdo-danger: #f49797; --cdo-focus: #b0b0b0;
    }
    @media (hover: none) { .cdo-delete { opacity: 1; pointer-events: auto; } }
    @media (prefers-reduced-motion: reduce) { .cdo-delete { transition: none; } }
  `;
  (document.head || document.documentElement).append(style);

  function errorText(error) {
    const message = error && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : '';
    return message.slice(0, 700) || '操作未完成，请稍后重试。会话仍保留在侧边栏中。';
  }

  function api() {
    const bridge = window.__codexDeleteOnlyApi;
    if (!bridge || typeof bridge.preview !== 'function' || typeof bridge.remove !== 'function') {
      throw new Error('删除服务未连接。请使用“Codex Delete Only”启动器重新打开 Codex。');
    }
    return bridge;
  }

  function assertNotCurrent(ids) {
    if (ids.some(isCurrent)) throw new Error('不能删除当前正在查看的会话。请先切换到其他会话后重试。');
  }

  function closeDialog(force = false) {
    const state = dialogState;
    if (!state || (state.busy && !force)) return;
    requestVersion++;
    dialogState = null;
    if (state.node.open) state.node.close();
    state.node.remove();
    if (!disposed && state.opener && state.opener.isConnected) state.opener.focus({ preventScroll: true });
  }

  function setStatus(state, text, error = false) {
    state.status.textContent = text;
    state.status.hidden = !text;
    state.status.dataset.error = String(error);
    state.status.setAttribute('role', error ? 'alert' : 'status');
  }

  async function preview(state) {
    const version = ++requestVersion;
    state.token = null;
    state.targets = [];
    state.confirm.disabled = true;
    state.retry.hidden = true;
    state.detail.textContent = '正在读取会话信息…';
    setStatus(state, '');
    try {
      assertNotCurrent([state.id]);
      const result = await api().preview(state.id);
      if (disposed || dialogState !== state || requestVersion !== version) return;
      if (!result || !result.token || normalizedId(result.threadId) !== state.id || !Array.isArray(result.targets) || !result.targets.length) {
        throw new Error('会话信息未通过检查，请重新读取后再试。');
      }
      const targets = result.targets.map(target => normalizedId(target.id));
      if (targets.some(id => !id) || !targets.includes(state.id) || new Set(targets).size !== targets.length) {
        throw new Error('删除范围未通过检查，请重新读取后再试。');
      }
      assertNotCurrent(targets);
      state.targets = targets;
      state.token = result.token;
      state.title.textContent = typeof result.title === 'string' && result.title.trim() ? result.title : '未命名会话';
      const children = targets.length - 1;
      state.detail.textContent = `${children ? `将删除此会话及 ${children} 条关联子会话。` : '将删除此会话及其聊天记录。'}删除后无法撤销。`;
      state.confirm.disabled = false;
    } catch (error) {
      if (disposed || dialogState !== state || requestVersion !== version) return;
      state.detail.textContent = '暂时无法确认删除范围。';
      setStatus(state, errorText(error), true);
      state.retry.hidden = false;
    }
  }

  function showToast(result) {
    if (toast) toast.remove();
    clearTimeout(toastTimer);
    toast = el('aside', 'cdo-toast');
    toast.dataset.cdoOwned = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.append(el('strong', '', `已删除 ${result.deletedIds.length} 条会话`));
    const close = el('button', 'cdo-toast-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭删除结果提示');
    close.addEventListener('click', () => { if (toast) toast.remove(); toast = null; clearTimeout(toastTimer); });
    toast.append(close);
    document.body.append(toast);
    toastTimer = setTimeout(() => { if (toast) toast.remove(); toast = null; }, 20000);
  }

  async function confirmDelete(state) {
    if (state.busy || !state.token || state.confirm.disabled) return;
    try { assertNotCurrent(state.targets); } catch (error) {
      state.token = null;
      state.confirm.disabled = true;
      state.retry.hidden = false;
      setStatus(state, errorText(error), true);
      return;
    }
    state.busy = true;
    state.confirm.disabled = true;
    state.cancel.disabled = true;
    state.retry.hidden = true;
    state.node.setAttribute('aria-busy', 'true');
    setStatus(state, '正在删除，请稍候…');
    const token = state.token;
    state.token = null; // Every attempt consumes its preview; retries always obtain a new token.
    try {
      const result = await api().remove(token);
      if (disposed || dialogState !== state) return;
      if (!result || !Array.isArray(result.deletedIds) || !result.deletedIds.length) {
        throw new Error('删除服务未返回可确认的结果，请重新检查此会话。');
      }
      const confirmedIds = result.deletedIds.map(normalizedId);
      if (confirmedIds.some(id => !id || !state.targets.includes(id))) {
        throw new Error('删除结果与确认范围不一致，请查看启动器日志。');
      }
      for (const id of confirmedIds) deletedIds.add(id);
      document.querySelectorAll(ROW).forEach(refreshRow);
      closeDialog(true);
      showToast({ deletedIds: confirmedIds });
    } catch (error) {
      if (disposed || dialogState !== state) return;
      state.busy = false;
      state.cancel.disabled = false;
      state.retry.hidden = false;
      state.node.removeAttribute('aria-busy');
      setStatus(state, errorText(error), true);
      state.retry.focus();
    }
  }

  function openDialog(row, opener) {
    if (dialogState || disposed) return;
    const id = localTarget(row); // Read again: virtualized rows may now represent a different chat.
    if (!id || isCurrent(id) || deletedIds.has(id)) { refreshRow(row); return; }
    const node = el('dialog', 'cdo-dialog');
    node.dataset.cdoOwned = 'dialog';
    node.setAttribute('aria-labelledby', 'cdo-dialog-heading');
    node.setAttribute('aria-describedby', 'cdo-dialog-detail');
    const heading = el('h2', '', '删除会话？');
    heading.id = 'cdo-dialog-heading';
    const title = el('p', 'cdo-title', rowTitle(row));
    const detail = el('p', 'cdo-detail');
    detail.id = 'cdo-dialog-detail';
    const status = el('p', 'cdo-status');
    status.hidden = true;
    const actions = el('div', 'cdo-actions');
    const retry = el('button', 'cdo-retry', '重试');
    const cancel = el('button', 'cdo-cancel', '取消');
    const confirm = el('button', 'cdo-confirm', '删除');
    for (const button of [retry, cancel, confirm]) button.type = 'button';
    retry.hidden = true;
    confirm.disabled = true;
    cancel.autofocus = true;
    actions.append(retry, cancel, confirm);
    node.append(heading, title, detail, status, actions);
    const state = { id, node, title, detail, status, retry, cancel, confirm, opener, token: null, targets: [], busy: false };
    dialogState = state;
    cancel.addEventListener('click', () => closeDialog());
    retry.addEventListener('click', () => { cancel.focus(); void preview(state); });
    confirm.addEventListener('click', () => void confirmDelete(state));
    node.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    node.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const buttons = [retry, cancel, confirm].filter(button => !button.disabled && !button.hidden);
      if (!buttons.length) { event.preventDefault(); return; }
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    });
    document.body.append(node);
    node.showModal();
    cancel.focus();
    void preview(state);
  }

  function makeDeleteButton(row) {
    const button = el('button', 'cdo-delete');
    button.type = 'button';
    button.dataset.cdoOwned = 'delete';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5');
    svg.append(path);
    button.append(svg);
    button.addEventListener('pointerdown', event => {
      event.preventDefault(); event.stopImmediatePropagation(); button.focus({ preventScroll: true });
    }, true);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation(); openDialog(row, button);
    }, true);
    for (const type of ['keydown', 'keyup']) button.addEventListener(type, event => event.stopPropagation());
    return button;
  }

  function refreshRow(row) {
    if (!(row instanceof Element) || !row.matches(ROW) || !row.isConnected) return;
    const id = localTarget(row);
    const deleted = !!id && deletedIds.has(id);
    row.classList.toggle('cdo-deleted', deleted);
    const eligible = !!id && !deleted && !isCurrent(id);
    let record = records.get(row);
    if (!eligible) {
      if (record) record.button.remove();
      records.delete(row);
      row.classList.toggle('cdo-row', deleted);
      return;
    }
    if (!record) {
      record = { id, button: makeDeleteButton(row) };
      records.set(row, record);
    }
    record.id = id;
    record.button.title = '删除会话';
    record.button.setAttribute('aria-label', `删除会话：${rowTitle(row)}`);
    if (record.button.parentNode !== row) row.append(record.button);
    row.classList.add('cdo-row');
  }

  function flushRows() {
    scanTimer = null;
    if (disposed) return;
    for (const row of pendingRows) refreshRow(row);
    pendingRows.clear();
    for (const [row, record] of records) {
      if (!row.isConnected || !row.matches(ROW)) {
        record.button.remove(); row.classList.remove('cdo-row', 'cdo-deleted'); records.delete(row);
      }
    }
  }

  function schedule() {
    if (scanTimer === null) scanTimer = setTimeout(flushRows, 40);
  }

  function queueAllRows() {
    document.querySelectorAll(ROW).forEach(row => pendingRows.add(row));
    schedule();
  }

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (!target || target.closest(OWNED)) continue;
      if (mutation.type === 'attributes') {
        const row = target.closest(ROW);
        if (row) pendingRows.add(row);
        if (mutation.attributeName === 'aria-current' || mutation.attributeName === 'data-app-action-sidebar-thread-active') {
          records.forEach((record, node) => pendingRows.add(node));
        }
      } else {
        const parentRow = target.closest(ROW);
        const externalChanges = [...mutation.addedNodes, ...mutation.removedNodes].some(node => !(node instanceof Element) || !node.matches(OWNED));
        if (parentRow && externalChanges) pendingRows.add(parentRow);
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element) || node.matches(OWNED)) continue;
          if (node.matches(ROW)) pendingRows.add(node);
          node.querySelectorAll(ROW).forEach(row => pendingRows.add(row));
        }
      }
    }
    // A removal may need cleanup even when it adds no row.
    schedule();
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: [
      'data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id',
      'data-app-action-sidebar-thread-kind', 'data-app-action-sidebar-thread-active',
      'data-app-action-sidebar-thread-title', 'aria-current'
    ]
  });
  listen(window, 'popstate', queueAllRows);
  listen(window, 'hashchange', queueAllRows);
  if (window.navigation) listen(window.navigation, 'navigatesuccess', queueAllRows);
  listen(document, 'click', event => {
    if (event.target instanceof Element && event.target.closest(ROW) && !event.target.closest(OWNED)) queueAllRows();
  });
  document.querySelectorAll(ROW).forEach(refreshRow);

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(toastTimer);
    removers.forEach(remove => remove());
    closeDialog(true);
    for (const [row, record] of records) { record.button.remove(); row.classList.remove('cdo-row', 'cdo-deleted'); }
    records.clear();
    pendingRows.clear();
    document.querySelectorAll('.cdo-deleted').forEach(row => row.classList.remove('cdo-row', 'cdo-deleted'));
    if (toast) toast.remove();
    style.remove();
    if (window.__codexDeleteOnlyUI === publicApi) delete window.__codexDeleteOnlyUI;
  }

  const publicApi = Object.freeze({ dispose, get deletedIds() { return [...deletedIds]; } });
  window.__codexDeleteOnlyUI = publicApi;
})();

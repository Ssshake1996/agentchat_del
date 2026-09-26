import { readFile, mkdir, writeFile, open, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CDP } from './cdp.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DATA = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'CodexDeleteOnly');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function buildInjectionSource(scripts) {
  return String.raw`(() => {
    if (window.top !== window || !/^app:\/\/-\//.test(location.href)) return;
    const boot = () => { ${scripts.join('\n;\n')} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  })();`;
}

export function parseArgs(args) {
  const config = { port: 19379, exe: null, doctor: false, attachOnly: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port': config.port = Number(args[++i]); break;
      case '--exe':
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--exe 后需要 Codex 桌面程序的完整路径。');
        config.exe = resolve(args[++i]); break;
      case '--doctor': config.doctor = true; break;
      case '--attach-only': config.attachOnly = true; break;
      default: throw new Error(`未知参数：${args[i]}`);
    }
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('调试端口必须是 1024–65535 的整数。');
  return config;
}

async function powershell(script) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  return stdout.replace(/^\uFEFF/, '').trim();
}

async function discoverApp(override) {
  if (override) {
    if (!(await stat(override)).isFile()) throw new Error('指定的 Codex 路径不是文件。');
    // CLI codex.exe is a different program; never attach a GUI flag to the CLI by accident.
    if (!await stat(join(dirname(override), 'resources', 'app.asar')).catch(() => null)) {
      throw new Error('--exe 必须指向含 resources/app.asar 的 Codex 桌面程序，不能是 Codex CLI。');
    }
    return override;
  }
  const result = await powershell(`
$ErrorActionPreference = 'Stop'
$packages = @(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending)
foreach ($package in $packages) {
  foreach ($name in @('ChatGPT.exe', 'Codex.exe')) {
    $candidate = Join-Path $package.InstallLocation ('app\\' + $name)
    if (Test-Path -LiteralPath $candidate) { [Console]::Write($candidate); exit 0 }
  }
}
foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Programs\\Codex\\Codex.exe'), (Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\Codex.exe'))) {
  if (Test-Path -LiteralPath $candidate) { [Console]::Write($candidate); exit 0 }
}
`);
  if (!result) throw new Error('未找到 Codex 桌面程序。请用 --exe 指定桌面程序完整路径。');
  return result;
}

async function appRunning(exe) {
  const output = await powershell(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'ChatGPT' -or $_.ProcessName -eq 'Codex' } | ForEach-Object { $_.Path }`);
  return output.split(/\r?\n/).some(path => path.toLowerCase() === exe.toLowerCase());
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
  if (!response.ok) throw new Error('调试端口没有返回有效页面列表。');
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('调试端口响应格式不兼容。');
  return data.filter(target => target.type === 'page' && /^app:\/\/-\//.test(target.url) && target.webSocketDebuggerUrl);
}

async function acquireLock(port) {
  await mkdir(APP_DATA, { recursive: true });
  const path = join(APP_DATA, `launcher-${port}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => unlink(path).catch(() => {});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`启动锁损坏，请检查：${path}`);
      let alive = true;
      try { process.kill(pid, 0); } catch (check) { if (check.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('删除版启动器已经在运行，无需重复打开。');
      await unlink(path);
    }
  }
  throw new Error('无法获取启动器锁。');
}

async function attach(target, source) {
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    const installation = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source });
    cdp.scriptId = installation.identifier;
    const result = await cdp.call('Runtime.evaluate', { expression: source, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '界面插件加载失败。');
    return cdp;
  } catch (error) { cdp.close(); throw error; }
}

export async function main(args = process.argv.slice(2)) {
  const config = parseArgs(args);
  if (process.platform !== 'win32') throw new Error('此版本启动器仅支持 Windows。');
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket === 'undefined') throw new Error('需要 Node.js 22.4 或更新版本。');
  const exe = await discoverApp(config.exe);
  const existing = await targets(config.port).catch(() => []);
  if (config.doctor) {
    const report = {
      node: process.version, desktopExecutable: exe, desktopRunning: await appRunning(exe),
      debuggingPort: config.port, attachableWindows: existing.length,
      note: '诊断只检查运行环境，不注入界面，不读取或删除会话。',
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!existing.length && config.attachOnly) throw new Error('没有可连接的 Codex 调试窗口。');
  if (!existing.length && await appRunning(exe)) {
    throw new Error('Codex 已在普通模式运行。请先等待任务完成并退出所有 Codex 窗口，再双击“启动删除版Codex.vbs”。启动器不会强制关闭 Codex。');
  }
  const unlock = await acquireLock(config.port);
  const connections = new Map();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const scripts = await Promise.all(['engine.js', 'bridge.js', 'ui.js'].map(name => readFile(join(ROOT, 'renderer', name), 'utf8')));
    // The preload bridge may not exist until the document's DOM is ready.
    const source = buildInjectionSource(scripts);
    if (!existing.length) {
      const child = spawn(exe, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${config.port}`], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      console.log('已启动 Codex，正在加载会话删除按钮。');
    }
    const startedAt = Date.now();
    let lastFound = startedAt;
    let attached = false;
    let lastError = '';
    while (!stopped) {
      const pages = await targets(config.port).catch(() => []);
      if (pages.length) lastFound = Date.now();
      const liveIds = new Set(pages.map(page => page.id));
      for (const [id, cdp] of connections) {
        if (!liveIds.has(id) || cdp.socket.readyState !== WebSocket.OPEN) { cdp.close(); connections.delete(id); }
      }
      for (const page of pages) {
        if (connections.has(page.id)) continue;
        try {
          connections.set(page.id, await attach(page, source));
          attached = true; lastError = '';
          console.log('会话删除按钮已加载。');
        } catch (error) {
          if (error.message !== lastError) console.error(error.message);
          lastError = error.message;
        }
      }
      if (!attached && Date.now() - startedAt > 60000) {
        throw new Error('60 秒内未完成插件加载。' + (lastError || '请确认普通 Codex 已完全退出，或尝试更换 --port。'));
      }
      if (!pages.length && Date.now() - lastFound > (attached ? 10000 : 60000)) {
        if (!attached) throw new Error('60 秒内未连接到 Codex。请确认普通 Codex 已完全退出，或尝试更换 --port。');
        break;
      }
      await sleep(1500);
    }
  } finally {
    for (const cdp of connections.values()) {
      if (cdp.socket.readyState === WebSocket.OPEN) {
        await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: cdp.scriptId }, 2000).catch(() => {});
        await cdp.call('Runtime.evaluate', { expression: 'window.__codexDeleteOnlyUI?.dispose();window.__codexDeleteOnlyBridge?.dispose();' }, 2000).catch(() => {});
      }
      cdp.close();
    }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(error.message);
    await mkdir(APP_DATA, { recursive: true }).catch(() => {});
    await writeFile(join(APP_DATA, 'last-error.txt'), error.message, 'utf8').catch(() => {});
    process.exitCode = 1;
  });
}

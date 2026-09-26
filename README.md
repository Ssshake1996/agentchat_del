# agentchat_del

Codex Delete Only：仅提供会话删除功能的轻量扩展。

Windows 版 Codex 桌面侧边栏删除扩展。**只有会话删除功能，不生成本地备份。**

鼠标移到侧边栏会话上，点击垃圾桶按钮，核对标题和子会话范围，再点击 **删除**。删除后无法撤销。按 `Esc` 或点击 **取消** 不执行删除。

## 使用

1. 安装 Node.js **22.4 或更新版本**。本项目没有 npm 依赖，不需要 `npm install`。
2. 克隆本仓库，或下载源码并解压到固定位置。
3. 等待正在运行的任务完成，退出所有 Codex 桌面窗口。
4. 双击 **启动删除版Codex.vbs**。它会启动官方 Codex，并加载侧边栏删除按钮。

以后从这个入口启动即可。从官方入口启动时不加载扩展。启动器不会强制结束正在运行的 Codex。

可选：在本目录的 PowerShell 中执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`，创建桌面快捷方式。安装器仅创建快捷方式，不修改 Codex 安装文件。移动文件夹后需重新创建快捷方式。

## 删除范围

- 仅处理本机 Codex 会话；不操作 ChatGPT 聊天、旧云任务或远程主机。
- 调用当前 Codex 窗口连接的原生 `thread/delete`，由 Codex 自身清理会话存储并刷新列表。
- 原生接口会连同派生的子会话删除；确认框展示具体影响范围。独立 fork 不等于 spawned 子会话。
- 当前打开的会话、运行中的会话，以及包含这些会话的父会话，均拒绝删除。先切换到其他会话，或等待任务完成。
- 不读取项目文件，不删除工作目录或 worktree，不写登录、模型或供应商配置。
- 不创建聊天备份、不提供撤销。运行日志只包含启动状态及错误。

## 环境与兼容性

参考 CodexPlusPlus 的 CDP 注入方式和侧边栏定位方式，删除动作使用官方 App 已有接口；不打包原项目的供应商、主题、导出等功能，不修改 `app.asar`。

已依据本机 **Codex 26.924.2738.0 / codex-cli 0.151.0** 的程序结构适配。此版本菜单本身也有原生“永久删除”；本扩展提供直接显示在会话行上的删除按钮。不同版本更新可能改变 DOM 或消息接口；无法识别时不猜测目标、不直接修改 SQLite。本项目通过独立启动器注入侧边栏，不需要在插件市场安装。

启动器使用本机回环调试端口 `127.0.0.1:19379`。不提供 HTTP 删除服务，不监听局域网地址。关闭 Codex 后启动器自动退出。临时诊断与启动日志位于 `%LOCALAPPDATA%\CodexDeleteOnly`。

查看诊断（只读，不注入或删除）：

```powershell
node .\src\launcher.mjs --doctor
```

手动指定桌面程序或端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher.ps1 -Executable 'C:\path\Codex\Codex.exe' -Port 19380
```

`-Executable` 必须指向桌面程序（同目录有 `resources\app.asar`），不是命令行 `codex.exe`。默认自动识别 Microsoft Store 的 `OpenAI.Codex` 包，兼容桌面程序名 `ChatGPT.exe` 与 `Codex.exe`。

如果普通 Codex 已打开而调试端口不可用，启动器会提示先退出，不强制重启。删除请求若超时，结果可能已生效，应先核对列表，不自动重试。

## 开发与验证

```powershell
npm test
node --check .\renderer\ui.js
node --check .\renderer\engine.js
node --check .\renderer\bridge.js
node .\src\launcher.mjs --doctor
```

`tests/ui-fixture.html` 是使用假会话的界面测试页，所有数据仅存在该页面内。原生删除验证在独立的临时 `CODEX_HOME` 下进行，不删除使用者的真实会话。当前 Codex 正在承载开发会话，未强行重启它做真实桌面端到端删除验证。

需要重跑原生集成检查时，执行 `node .\tests\native-smoke.mjs 'C:\完整路径\codex.exe'`，此处参数为 **Codex CLI**。该脚本始终创建独立临时目录，不发起模型请求；默认测试不运行它。

状态检查与原生删除不是一个原子操作；请勿在另一个窗口恰好同时启动准备删除的任务。接口没有条件删除参数，插件不会承诺消除这一极短竞态。

## 移除

退出 Codex，移除本项目文件夹和自行创建的快捷方式即可。官方程序、会话配置无需恢复。`%LOCALAPPDATA%\CodexDeleteOnly` 中的诊断日志可以自行删除。

## 来源

- [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus/tree/693c8486bafb0f98e2539c455335d3d2fd42ce00)：参考实现，AGPL-3.0-only。
- [OpenAI Codex 原生 thread/delete 实现](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/src/request_processors/thread_delete.rs)。

本项目以 AGPL-3.0-only 提供源码。见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。

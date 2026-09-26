# agentchat_del

**AgentChat Delete：在 A 对话中确认删除 B 对话的标准 Codex 插件。** 只有会话查找与删除，不创建本地备份，不需要专用启动器。

支持 Windows 上 ChatGPT 桌面中的 **Codex 本地聊天/任务**。不支持普通 ChatGPT 云端聊天、网页端或远程主机。插件 ID 为 `agentchat-del`，GitHub 仓库名保持 `agentchat_del`。

## 使用

在一个新聊天中说：

> 使用 AgentChat Delete，查找标题包含“测试”的 Codex 历史会话。

选择明确的目标后，插件显示原始标题、会话 ID 和将被一并删除的派生子会话。勾选 **确认永久删除** 并提交才会删除。取消、关闭或确认超时都不删除。

- **A 删 B，禁止 A 删 A**；如果 B 的派生子会话中包含 A，同样拒绝。
- 只接受桌面实际状态为 `notLoaded` 的目标及其全部派生子会话。运行中、仍加载的 `idle`、未知或异常状态都会拒绝。
- 若提示目标仍被加载，请结束任务并正常退出、重新打开桌面，从其他聊天删除，期间不要再打开目标。无需使用旧版启动器。
- 删除包含派生子会话，独立 fork 不属于这个范围。
- 不归档中转、不创建备份、不删除项目或 worktree 文件。删除不能撤销。
- 删除成功后会验证记录及索引均已消失。侧边栏如仍显示缓存，正常重启桌面刷新；不要直接重复删除。

## 安装

需要 Windows、支持插件与 MCP 确认表单的 Codex 桌面、可运行的 `codex` CLI，以及 Node.js **22.4 或更新版本**。没有 npm 依赖，不必 `npm install`。

克隆/下载本仓库后，在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-plugin.ps1
```

安装器将插件复制到 `%USERPROFILE%\plugins\agentchat-del`，添加默认个人市场条目，然后通过 `codex plugin add` 安装并启用。它保留其他插件与市场条目，不修改 Codex 程序文件。

**安装后新开一个 Codex 聊天**，让技能和 MCP 工具加载。现有聊天不会自动得到新工具。可在插件页搜索 **AgentChat Delete** 查看。

卸载：在插件页卸载，或运行 `codex plugin remove agentchat-del@personal`。如果个人市场已有其他名称，请使用实际的市场名。

## 实现与边界

标准插件在 `plugins/agentchat-del/`，包括 `.codex-plugin/plugin.json`、`.mcp.json`、技能和零依赖的 stdio MCP 服务，只提供两个工具：

| 工具 | 用途 |
| --- | --- |
| `search_chats` | 按标题查找会话，最多返回 30 条 |
| `delete_chat` | 展示完整范围，等待用户确认，复查后永久删除 |

当前调用者来自 Codex 执行器提供的 MCP 元数据，工具参数不能指定调用者或伪造确认。确认通过 MCP elicitation 表单完成；客户端不支持表单时停止，不降级为 `confirmed: true` 参数。

插件通过桌面本机 pipe 的只读 `read_thread` 核实真实运行状态，通过同一数据目录的 Codex 原生 app-server 调用 `thread/read`、`thread/list`、`thread/delete`。不自行修改 SQLite 或 JSONL。独立 app-server 的状态不能代表桌面的状态，因此必须额外校验桌面。原生跨进程写锁会阻止删除另一个进程持有的会话。

确认后重新检查会话修订、子会话范围和桌面状态。接口超时或结果不确定时，明确报错且不自动重试。桌面内部只读连接及原生协议可能随版本变化；不兼容时停止操作。

插件只访问本机：元数据及删除操作不发送到第三方服务。桌面 `read_thread` 的返回值仅取身份与状态，工具结果只包含候选标题/ID/时间或删除结果。不会持久化聊天内容或备份。

## 验证

```powershell
npm test
node .\tests\native-plugin-smoke.mjs 'C:\完整路径\codex.exe'
```

第二条命令接受 **Codex 原生命令行二进制**的绝对路径，只使用新建临时数据目录、离线测试供应商和无模型调用的假会话，验证写锁、真实删除、记录消失与项目文件保留。默认测试不会操作实际聊天。详情见 [TESTING.md](TESTING.md)。

修改已经安装的同版本本地插件时，应按 Codex `plugin-creator` 的 cachebuster + reinstall 流程更新安装副本，之后新开聊天测试；仅编辑仓库源文件不会热更新安装缓存。

## 旧版侧边栏扩展

原来的侧边栏按钮/专用启动器代码仍保留，标准插件不加载它。需要侧边栏方式可看 [旧版说明](docs/sidebar-launcher.md)，两种使用形式不必同时启用。

## 来源与许可

- [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus/tree/693c8486bafb0f98e2539c455335d3d2fd42ce00)：原侧边栏实现参考。
- [OpenAI 插件打包说明](https://developers.openai.com/plugins/build/plugins)。
- [Codex 原生删除](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server/src/request_processors/thread_delete.rs)与[跨进程写锁](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/thread-store/src/local/writer_lock.rs)。

非官方插件，以 AGPL-3.0-only 提供源码，见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。不分发 OpenAI 程序、认证资料或聊天记录。

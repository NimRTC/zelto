# ADR-091：Cursor IDE 内置 agent 作为执行器 —— 官方通路，但被特性闸门挡在门外

**状态**：调研完成，**不落地**（`desktop_bridge` 特性闸门未放量）；等闸门开放后重评估
**日期**：2026-11-19
**相关**：ADR-087（Cursor 第二执行器）、ADR-089（CursorFree 代理路实测）、ADR-090（凭证外部化）、ADR-035（用量口径）

> **一句话结论**：Cursor IDE 自带一条**官方支持**的外部驱动通路
> —— `cursor desktop ls / send`，它通过 `~/.cursor/desktop-bridge/` 的
> 本地 socket 直接驱动**正在运行的 IDE** 里的 agent 线程，用 IDE 自己的登录态与额度。
> 这条路在协议、凭证、额度三个维度上都优于 `cursor-agent`，
> 但被 `desktop_bridge` 特性闸门（`default: false`）挡住，
> 且闸门**无法在 stable 构建的普通用户端本地开启**。
> 即使闸门开放，它也无法满足 C9 的运行时写集强制 —— 这是本 ADR **不在闸门开放后直接落地**的独立理由。

## 背景

ADR-089 三轮实测的净结果是：`cursor-agent` 走 CursorFree 代理**到不了代理**
（CLI 在本地就要求 api-key / 登录态，且把 api-key 直送官方校验、无视 `--endpoint`）。
用户随后提出一个更直接的问题：

> 「我没有 cursor-agent 的额度，你能直接使用 ide 里的 agent 吗？」

这个问题的价值在于：**如果 IDE 的 agent 能被外部驱动，
那么「额度」这一在整个 ADR-087/089 链条里最难解的一环就消失了** ——
用的就是用户在 IDE 里已经付过费（或走代理）的那份额度。

## 调研对象

| 项 | 值 |
|---|---|
| IDE | Cursor `3.23.23`，`quality: stable`，commit `2dac2428` |
| 安装路径 | `C:\Program Files\cursor` |
| CLI 入口 | `resources/app/bin/cursor.cmd` → `Cursor.exe out/cli.js` |
| 主进程 | `out/main.js`（2.7 MB） |
| 渲染进程 | `out/vs/workbench/workbench.desktop.main.js`（39 MB） |

## 实测发现

### 1. `cursor desktop` 子命令存在，且是官方设计的外部驱动入口

`cursor --help` 的 `Subcommands` 段落列有 `agent` 与 `desktop`。
`desktop` 的完整用法（从 `cli.js` 的用法串还原）：

```
Usage: cursor desktop <command>

Interact with chat threads in a running Cursor desktop app.

Commands
  ls                                List threads live in running desktop instances
  send <thread> [text...]           Send a message to a live desktop thread

Options
  --json                            Machine-readable output
  --force                           (send) Submit immediately, interrupting a running turn
  --stdin                           (send) Read message text from stdin
  -h --help                         Print usage

<thread> is a thread id from `cursor desktop ls`, or a unique prefix of one.
```

调度点（`cli.js`）：`if (t.desktop) return e0(t.desktop)`。

`send` 的返回结构是受校验的（`pBe`）：

```js
outcome: "submitted" | "queued"   → 需带 threadTitle
       | "not-found"              → 无额外字段
       | "not-sendable"           → 需带 reason
       | "error"                  → 需带 message
```

### 2. 传输层：本地 socket + 一次性 token，不是网络

`desktop-bridge.ts`（`cli.js` 与 `main.js` 各有一份同构实现）：

```js
function desktopBridgeDir({homeDir, envOverride}) {
  return envOverride !== undefined ? envOverride : `${homeDir}/.cursor/desktop-bridge`;
}
protocolVersion = 1
MAX_FRAME = 256 * 1024
MAX_THREADS = 200
// discovery 文件校验：pid > 0、socketPath 非空、token 必须 /^[0-9a-f]{64}$/
```

每个运行中的 IDE 实例在 `~/.cursor/desktop-bridge/` 下写一条 discovery JSON
（`socketPath` / `token` / `pid` / `appName` / `appVersion` / `userDataDir` / `createdAt`），
CLI 读到后连 socket，发 `listThreads` / `sendMessage` 两类请求。
可用 `CURSOR_DESKTOP_BRIDGE_DIR` 环境变量改目录位置。

**这一点很关键**：它不碰网络，不碰 Cursor 服务端协议，
因此不受 ADR-089 里那些 `AgentRunRequest` / `clientLlmGatewayCredential` 的限制。

### 3. 线程模型

`source` 取值 `local | cloud | draft | claude-code`，
`status` 取值 `idle | running | completed | error | unknown`。
`ls` 跨所有运行中的实例汇总，按 `lastUpdatedAt` 降序，最多 200 条。

### 4. 闸门：两道，且 stable 构建下无法本地开

渲染进程（`workbench.desktop.main.js`）里的判定：

```js
function isDesktopBridgeEnabled(e) {
  return e.isBuilt ? e.featureGateEnabled && e.userEnabled : true;
}
// featureGateEnabled: checkFeatureGate("desktop_bridge")
// userEnabled:        settings.desktopBridgeUserEnabled
```

- **`desktop_bridge`** 是 Statsig 特性闸门，本地默认表里写死：
  `desktop_bridge: { client: true, default: false }`
- **`desktopBridgeUserEnabled`** 是用户状态项，默认 `false`：
  `desktopBridgeUserEnabled: Ih(!1, -1, 0)`

设置页 UI 的渲染**也受闸门控制**：

```js
const gate = readGate("desktop_bridge");
... gate ? <group title="Desktop Bridge"> <checkbox label="Allow CLI to access desktop agents" ... /> </group> : null
```

**所以闸门关闭时，设置页里根本不存在这一项** —— 不是「藏起来」，是不渲染。
本机实测（用户为 Cursor Free Plan、stable 3.23.23）：
`~/.cursor/desktop-bridge/` 目录不存在，`settings.json` 中无相关键，
`cursor desktop ls` 静默返回空。

不能靠本地覆盖开启，因为 `setFeatureFlagOverride` 前置检查就拒绝：

```js
setFeatureFlagOverride(name, value) {
  if (!this._canUseOverrides()) {
    console.warn("Cannot set feature flag overrides in production builds for non-dev users");
    return;
  }
  ...
}

_canUseOverrides() {
  return this._isTestMode || !(isBuilt && !isExtensionDevelopment)
    ? true
    : !!contextKeyService.getContextKeyValue("isDevUser")
      || this._isDevUserInCachedServerConfig();   // cursorai/serverConfig.isDevDoNotUseForSecretThings…
}
```

三个可开途径：测试模式、扩展开发模式启动、云端 `serverConfig` 标记为 dev 用户。
前两个需要改变 IDE 启动方式（会影响日常使用），第三个由 Cursor 服务端决定。

## 结论

### 决策 1：现在不实现 `CursorDesktopAdapter`

理由是**闸门不在我们手里**，不是技术不可行。用不了的东西做成代码只是死代码；
而如果为了「能用」去改 IDE 启动参数或伪造 `isDevUser` 上下文，
那是**动上游客户端完整性**，与 ADR-089 拒绝改二进制是同一条红线。

### 决策 2：即使闸门开放，默认也不接入为切片执行器 —— 因为 C9

这是本 ADR 的核心判断，独立于闸门状态。

**C9 要求**：写集预约运行时强制 —— 以 PreToolUse 钩子**逐写判定为主**、
运行后 git 审计**兜底**；预约缺失时 fail closed。

`cursor desktop` 驱动的 agent **运行在 IDE 进程内部**，
它的工具调用（读文件、写文件、跑命令）由 IDE 的 agent 循环执行，
**不经过 zelto 的 PreToolUse hook**。后果：

| C9 组成 | 状态 |
|---|---|
| 逐写判定为主 | **完全失效** —— hook 根本没有被调用 |
| 运行后 git 审计兜底 | 仍可用 |
| 预约缺失 fail closed | 仍可判 —— 但判的是「没预约就拒绝启动」，拦不住启动后的越界写 |

这不是「打折扣」，是把主防线摘掉、只剩事后追责。
按 AGENTS.md「约束优先于功能，宁可少一个功能，也不许破一条不变量」，
**默认不接入**。

### 决策 3：闸门开放后的允许用法 —— 人盯着用的辅助通道，不是切片执行器

如果将来确实要用，它只适合**人在场、非切片、可以不写集预约**的场景
（例如 zelto 侧的一个「问问 IDE 里的 agent」的辅助命令）。
一旦要作为 `ExecutorAdapter` 跑切片，必须先解决 C9 —— 见下方「待决策」。

### 能力缺口（若强行接入为 `ExecutorAdapter`）

对照 `src/core/ports/executor.ts`：

| 端口方法 | `cursor desktop` 的实际情况 |
|---|---|
| `start` | 可映射：`send <new-thread>` 或先 `ls` 选目标。**但 thread 由 IDE 创建，zelto 不能指定工作目录** |
| `resume` | 可映射：复用 thread id。**但 thread 随 IDE 窗口存活**，IDE 关闭即失效 → 按端口契约必须**抛错**而非静默新开 |
| `continueSession` | 同上 |
| `getOutput` | **拿不到** —— `send` 返回 `{outcome, threadTitle}`，不含回答正文。需另找读取途径（IDE 本地会话存储） |
| `getUsage` | **拿不到** —— `send` 只返回 `{outcome, threadTitle}`，无 token/cost。只能按「无用量数据」上报（`getUsage` 返回 `null`），**不能填 0** —— 填 0 会把「不知道花了多少」误记成「没花钱」 |
| `stop` | **不精确** —— 无 kill；`--force` 只中断当前 turn，不终止会话 |
| `events` | **不提供** —— 无事件流。zelto 的事件流需完全由适配器自行合成 |
| `waitForExit` | **语义不成立** —— 没有「进程退出」这回事，agent 活在 IDE 里 |

八项里有五项（`getOutput` / `getUsage` / `stop` / `events` / `waitForExit`）**没有干净实现**。
这不是适配器写得好不好的问题，是端口语义与「无进程、无事件、无用量」的
IPC 模型之间存在结构性错配。

## 待决策

以下问题需要人来定，本 ADR 不代替拍板：

1. **C9 是否允许降级？** 若允许「运行后 git 审计为主」作为 Cursor 内置 agent 的
   执行模式，需要单独一条 ADR 明确它适用于哪些切片、如何标注、签字门槛是否提高。
   不允许的话，这条路**永远只能做辅助命令，不能做切片执行器**。
2. **`getUsage` 缺失怎么记账？** 端口契约（`AdaptersUsage`）允许适配器不实现
   `getUsage`，但**允许不实现 ≠ 不影响的后果**。若内置 agent 长期无用量，
   预算侧看到的是「该项无数据」，而不是「该项未超支」。
   是否需要补一个按 turn 数估算的兜底口径？—— 这属于 ADR-035 口径变更。
3. **闸门开放后是否值得做？** 若 C9 不放行，答案倾向于否。

## 复现方式

```
1. cursor --help                         # 确认 Subcommands 里有 desktop
2. ls ~/.cursor/desktop-bridge           # 闸门关闭时不存在
3. Cursor 设置 → Beta → 找 "Desktop Bridge"
                                         # 闸门关闭时该区块不渲染，搜不到
4. Electron-as-node 调 cli.js：
   ELECTRON_RUN_AS_NODE=1 Cursor.exe resources/app/out/cli.js desktop ls --json
                                         # 闸门关闭时静默返回空
```

闸门开放后，第 2 步应出现 discovery JSON，第 4 步应列出 thread。

## 2026-11-27 复核：闸门仍然关闭，且「ACP 能不能用 IDE 的额度」有明确答案

ADR-133 落地后（ACP 执行器），自然会问：
「ACP 能不能直接控制这台机器的 IDE 里那个 Cursor？」——实测结论如下。

### 1. 闸门仍然关闭（ADR-091 的结论今天不变）

| 检查 | 结果 |
|---|---|
| `~/.cursor/desktop-bridge/` | **不存在** |
| `cursor desktop ls` | 静默返回空（退出码 0，零行输出） |
| `cli.js` 里 `desktop` 子命令 | **存在**（`Ts={type:"subcommand",description:"Interact with chat threads in a running Cursor desktop app."}`） |
| `cli.js` 里 `desktop_bridge` 闸门名 | 0 命中（闸门在 IDE 侧的 `main.js` 里，不在 CLI 侧） |

**IDE 在跑（41 个 `Cursor` 进程），但 bridge 目录不存在** ——
说明是闸门关着，不是 IDE 没开。

### 2. IDE 里**没有** ACP 实现

| 搜索项 | `workbench.desktop.main.js` 命中数 |
|---|---|
| `agentclientprotocol` | **0** |
| `request_permission` | **0** |
| `session/new` | **0** |
| `protocolVersion` | 10 —— 但全是 **MCP** 的（`typeof e.params.protocolVersion=="string"`） |

ACP v1 规范里 `protocolVersion` 是**数字**；IDE 里是**字符串**（MCP 日期格式）。
`agent_acp` 那个字符串只是 `structured-log.ts` 的**日志分类标签**，
不是协议实现 —— 看到它就以为「IDE 支持 ACP」是误判。

**结论：ACP 是「zelto 当 client、agent CLI 当 agent」的通路，
方向是 zelto → 外部 agent CLI，不是 zelto → IDE。**

### 3. 关键问题：`cursor-agent acp` 与 IDE 共用登录态/额度吗？

**不共用（至少不是自动共用）。** 实测证据：

| 位置 | 内容 |
|---|---|
| IDE 的登录态 | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`（71 GB），**含 `cursorAuth` key** → IDE 已登录 |
| `cursor-agent` 读的凭证 | `%APPDATA%\<Name>\auth.json`（bundle 里的 `getAuthFilePath`，Windows 分支 = `APPDATA` + TitleCase(name) + `auth.json`） |
| 实测 | `%APPDATA%\Cursor\auth.json` **不存在** → CLI **未登录** |

`cursor-agent status` → `Not logged in`；
`cursor-agent models` → `Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.`

**所以「ACP 用 IDE 的额度」这个诉求不成立** —— 不是 zelto 的问题，
是 Cursor 自己的 CLI 与 IDE **两套登录态**。

要打通只有两条路：

1. **`cursor-agent login`** —— 走一次浏览器授权，写出 `%APPDATA%\Cursor\auth.json`。
   登录后 ACP 路线立即可用（**zelto 不代劳**：那是人自己的账号授权）。
2. **`CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` 环境变量**（ADR-090 的凭证外部化口径）。

### 4. 顺带修正 ADR-091 的一处表述

ADR-091 说 `cursor desktop` 走「用 IDE 自己的登录态与额度」——
这句对 **bridge 通路**成立（它连的就是 IDE 进程），
但**容易被误读成「Cursor 的一切都共用 IDE 登录态」**。
事实是：bridge 通路共用，`cursor-agent` CLI **不共用**。

## 参考

- `C:\Program Files\cursor\resources\app\out\cli.js`
  （`cliDesktopBridge.js`、`desktop-bridge.ts`、`pBe` 返回值校验）
- `C:\Program Files\cursor\resources\app\out\main.js`
  （`desktopBridge.js`：`cursor.desktopBridge.enabled`、
  `desktopBridgeUserEnabled`、`composer.desktopBridge.listThreads` / `sendMessage`）
- `C:\Program Files\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js`
  （设置 UI 渲染条件、`_canUseOverrides()`、`desktop_bridge` 默认值表）

# ADR-022: 凭据不落文件 —— LLM 密钥优先走环境变量

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C3
**关联文档**: `AGENTS.md`, `docs/zelto-技术架构.md`,
`docs/adr-014-runtime-policy-enforcement.md`（运行时强制）

---

## 1. 摘要

`.zelto/config.yaml` 里的 `llm.apiKey` 目前是**明文**。`.zelto/` 虽然在
`.gitignore` 里、推不上 GitHub，但明文密钥躺在配置文件里仍有两个问题：

1. **文件会被复制**。用户把项目目录打包发给别人、丢进 CI 缓存、
   同步到云盘，密钥跟着走。`.gitignore` 只挡 git，不挡其它通道。
2. **配置与密钥混在一处**。`zelto config set llm.apiKey ...` 之后，
   密钥和「门禁跑什么命令」这种普通配置长得一样，无法区分哪些该外置。

本 ADR 提议：**`llm.apiKey` 优先从环境变量读，配置文件里的值降级为回退**。
环境变量没有时才用文件里的。

**优先级**（高 → 低）：

| 来源 | 变量名 | 说明 |
|---|---|---|
| 1 | `ZELTO_LLM_API_KEY` | zelto 专用，不与其它工具抢 |
| 2 | `DEEPSEEK_API_KEY` | 沿用 DeepSeek 生态的通用命名 |
| 3 | `llm.apiKey`（配置文件） | 现有行为，回退路径 |

`llm.baseUrl` 与 `llm.model` **不涉及密钥**，保持纯配置，不进环境变量。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| `llm.apiKey` 只从 `.zelto/config.yaml` 读 | `src/cli/commands/shared.ts` 的 `loadConfig()` | 密钥必须落盘 |
| `createLlmFromConfig()` 直接取 `cfg.llm.apiKey` | `src/cli/commands/shared.ts` | 无密钥时返回 `null`，LLM 通路整体不可用 |
| 占位符只按精确值 `sk-your-key-here` 判定 | `src/cli/commands/shared.ts` 的 `validateConfig()` | 其它形态的占位符（如 `sk-xxx`）不告警 |
| `zelto config` 会打印 key 前 8 位 | `src/cli/commands/config.ts` | 有意为之（掩码），不是泄露面 |

### 2.2 为什么不是「只留环境变量」

直接砍掉配置文件里的 `apiKey` 会破坏现有用法：很多用户是把 zelto 当
本机工具用的，`config.yaml` 里填 key 是最自然的方式。**砍掉是破坏性变更**。

本 ADR 走的是**加一条更优先的路**，而不是拆旧路：
配置文件里的 key 继续能用，只是不再是首选。

### 2.3 为什么不是「只留配置文件」

那就等于什么都不做。上面两个问题（文件被复制、密钥与配置混淆）都还在。

### 2.4 与「可追溯」的关系

zelto 的核心主张是「agent 的每一行代码都能追溯到一条人批准的规格」。
这条链追溯的是**代码**，不是密钥。但有一条相关的不变量：

> 判定必须确定性（C3），且**判定结果不能依赖调用者的环境**。

LLM 通路（通路 B）不参与任何判定 —— `llm/` 的产出永远只是草稿（C7），
所以「密钥从哪来」不会影响任何判定结论。**这是本改动能安全做的前提。**

---

## 3. 设计

### 3.1 解析顺序

在 `loadConfig()` 解析完 YAML 之后，对 `llm` 段做一次覆盖：

```
apiKey = env.ZELTO_LLM_API_KEY
      ?? env.DEEPSEEK_API_KEY
      ?? yaml.llm.apiKey
```

`baseUrl` / `model` / `provider` / `pricing` 全部保持原样从 YAML 读。

### 3.2 实现位置

| 内容 | 位置 |
|---|---|
| 优先级解析 | `src/cli/commands/shared.ts` 的 `loadConfig()` —— 新增 `resolveApiKey()` |
| llm 段解耦 | `src/cli/commands/shared.ts` 的 `parseConfigYaml()` |
| 掩码显示 | `src/cli/commands/config.ts`（不动 —— 已经只显示前 8 位） |
| 判定测试 | `tests/shared.test.ts`、`tests/credential-resolution.test.ts` |

### 3.3 三种状态

`createLlmFromConfig()` 的返回值语义不变：

| 情况 | 行为 |
|---|---|
| 环境变量或配置里有 key | 正常返回 adapter |
| 两处都没有 key | 返回 `null`（现有行为） |
| 只有占位符 `sk-your-key-here` | 告警（现有行为） |

**没有 key 不是错误** —— 通路 B 的功能（clarify / spec / stall）本来就可选。
报错信息保持现状：`LLM_NOT_CONFIGURED` 提示用户配置。

### 3.4 与 `.gitignore` 的关系

`.zelto/` 继续留在 `.gitignore` 里 —— 这条不变。

本 ADR **不**要求用户把 key 从 `config.yaml` 里删掉，只是给了一条更好的路。
存量用户的配置文件不用动，行为不变。

---

## 4. 约束合规性

| 约束 | 怎么满足 |
|---|---|
| C1 状态只在文件里 | 环境变量不是「状态」，是「输入」。切片状态、签字记录、事件流全部照旧落文件，不受影响 |
| C3 判定确定性 | 密钥来源只影响通路 B（LLM 草稿）。通路 A 的门禁判定（policy / gate）完全不读 LLM 配置，判定结论不受影响 |
| C7 llm 产出只是草稿 | 不变。本 ADR 不让 LLM 参与任何判定 |
| C2 core 不依赖 SDK | 改动只在 `src/cli/commands/shared.ts`，`core/` 不动 |

---

## 5. 后果

**好的**

- 密钥不必落盘：CI 里用 secret 注入，本地可以用系统 keychain / 环境变量。
- 配置文件里可以只写「非密钥部分」，密钥与普通配置分离。
- 优先级明确：环境变量赢，符合「显式覆盖隐式」的直觉。

**代价与边界**

- **优先级反转是个 breaking change**：如果某个用户的**环境变量里恰好有**
  `DEEPSEEK_API_KEY`，而配置文件里写的是另一个 key，
  改完之后会**改用环境变量那个**。这是有意的（显式覆盖隐式），
  但必须在 CHANGELOG 里写清楚。
- `DEEPSEEK_API_KEY` 这个名字有点宽：DeepSeek 官方 SDK 也用这个名字。
  如果本机同时装了别的 DeepSeek 工具，可能意外共用一个 key。
  **因此优先级上 `ZELTO_LLM_API_KEY` 更高** —— 想隔离就用 zelto 专名。
- 不做「密钥加密后存进配置」：密钥管理的正解是环境变量或 keychain，
  自造一套加密只会把「明文」变成「可解密的明文」，还多一份密钥管理负担。
- 不做「从 `~/.zelto/credentials` 读」：又多一个状态位置，与 C1 的
  「状态只在文件里」容易混淆，且没有额外收益。

**明确没做**

- 不改 `llm.baseUrl` / `llm.model` 的来源 —— 它们不是密钥。
- 不加 `.zelto/config.yaml` 的模板化改造 —— `zelto init` 的模板本来就不含 `llm` 段。
- 不做运行时密钥轮换 —— 那是运维的事，不在 zelto 的职责里。

---

## 6. 已知缺口

**`.zelto/config.yaml` 本身仍会被复制。** 本 ADR 解决的是「密钥不必落在这个文件里」，
但如果用户还是把 key 写进配置，那个文件照样会被打包带走。

彻底的办法是：**别把密钥写进文件**。这是使用约定，不是代码能强制的。

配套建议（本次不做，只是记下来）：

- 在 `docs/zelto-开工包.md` 的配置参考里补一段「密钥建议用环境变量」的说明；
- 在 `README.md` 的快速开始里加一行 `export ZELTO_LLM_API_KEY=...` 的示例。

---

## 7. 已确认的决策

| 问题 | 决定 |
|---|---|
| 环境变量支持哪几档 | **两档都留**：`ZELTO_LLM_API_KEY` 优先，其次 `DEEPSEEK_API_KEY` |
| 优先级反转算不算 breaking change | **不算**。环境变量覆盖配置文件是符合直觉的行为，CHANGELOG 记一笔即可 |
| 实现范围 | **完整实现**：ADR + 文档 + 代码 + 判定测试 |

---

## 8. 实现记录

| 内容 | 位置 |
|---|---|
| 优先级解析 | `src/cli/commands/shared.ts` —— 新增 `resolveApiKey()`（纯函数，env 可注入）与 `withEnvApiKey()` |
| llm 段解耦 | `src/cli/commands/shared.ts` 的 `parseConfigYaml()` —— llm 段不再要求 `provider && apiKey` 同时存在，否则 key 走环境变量时 `baseUrl` / `model` / `pricing` 会跟着丢 |
| 类型 | `ZeltoConfig.llm.apiKey` 由必填改为可选 |
| 掩码显示 | `src/cli/commands/config.ts`（不动 —— 已经只显示前 8 位） |
| 错误提示 | `src/cli/commands/ai-pipeline.ts` —— 6 处 `LLM_NOT_CONFIGURED` 改为同时提示环境变量 |
| 文档 | `docs/zelto-开工包.md` §5.1、`README.md` / `README.zh-CN.md` 快速开始 |
| 判定测试 | `tests/shared.test.ts`（纯函数 + llm 段解耦）、`tests/credential-resolution.test.ts`（`loadConfig()` 集成） |

**行为契约**（实现必须满足）：

1. `ZELTO_LLM_API_KEY` > `DEEPSEEK_API_KEY` > `llm.apiKey`（配置文件）。
2. 三者都无 → `createLlmFromConfig()` 返回 `null`，LLM 通路不可用（现有行为）。
3. `llm.baseUrl` / `llm.model` / `llm.provider` / `llm.pricing` **不读环境变量**。
4. `zelto config` 的掩码显示逻辑不变（只显示前 8 位）。

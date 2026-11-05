# ADR-026: 配置里的环境变量引用 —— `${VAR}` 展开

**状态**: 已实现
**日期**: 2026-11-05
**作者**: 系统架构
**关联约束**: C1, C3
**关联文档**: `AGENTS.md`, `docs/adr-022-credential-from-env.md`,
`docs/zelto-开工包.md`（§5.1）, `src/cli/commands/shared.ts`

---

## 1. 摘要

`.zelto/config.yaml` 的 `llm.apiKey` 支持写 `${VAR}` 形式的**环境变量引用**：

```yaml
llm:
  provider: deepseek
  apiKey: "${NIMRTC_LLM_API_KEY}"
  baseUrl: "https://api.example.com"
  model: deepseek-ai/DeepSeek-V3
```

配置加载时，`${NIMRTC_LLM_API_KEY}` 被替换为同名环境变量的值；
环境变量没设置时，该引用解析为**未设置**（而不是把字面量当密钥用），
并打印一条警告说明是哪个变量没设。

展开只作用于 `llm.apiKey` 一个字段，其它字段一律不动。

---

## 2. 动机

### 2.1 现状：`${...}` 被当成字面量

配置解析器 `parseConfigYaml()` 只做「去引号」，不做任何变量替换。
于是这一行：

```yaml
apiKey: "${NIMRTC_LLM_API_KEY}"
```

解析结果是字符串 `${NIMRTC_LLM_API_KEY}` —— 一串字面量，被原样塞进
`Authorization: Bearer ...` 请求头。结果是远端返回 401，
而本地**没有任何提示**：配置看起来是对的，密钥看起来是填了的，
错误却指向一个跟密钥毫无关系的方向（网络、模型名、额度）。

同类项目（`nimrtc-zelto`、`NimRTC`）的 `.zelto/config.yaml` 已经这么写了，
注释也写着「API key loaded from env var for security」——
**配置意图是环境变量，实际行为是把占位符当密钥发出去**。
这是静默失效：用户以为密钥没落盘（确实没落），实际落盘的是占位符，
而真正的密钥在哪没人知道。

### 2.2 为什么不是「让用户照 ADR-022 用 `ZELTO_LLM_API_KEY`」

ADR-022 已经给了「环境变量优先」的机制，文档也写清楚了
`ZELTO_LLM_API_KEY` > `DEEPSEEK_API_KEY` > 配置文件。
但它解决的是**zelto 默认认哪两个变量名**，不是「这个项目用哪个变量名」。

现实里同一个代理密钥会被多个项目共用（zelto 本身 + nimrtc-zelto + NimRTC），
变量名跟着项目走（`NIMRTC_LLM_API_KEY`）比强迫所有项目都叫
`ZELTO_LLM_API_KEY` 更贴近既有约定。

### 2.3 为什么不是「把明文密钥继续留在文件里」

明文密钥躺在 `.zelto/config.yaml` 里有三个问题：文件会被复制（打包发给别人、
丢 CI 缓存、同步到云盘）、密钥与普通配置混在一起无法区分、
以及终端回显（`zelto config`、错误栈）会把密钥带进日志。

`.gitignore` 只挡 git，挡不住其它通道。

---

## 3. 决策

### 3.1 解析规则

只认**整值**引用，形式为 `${NAME}`，`NAME` 匹配 `[A-Za-z_][A-Za-z0-9_]*`：

| 配置里的值 | 环境变量 | 解析结果 |
|---|---|---|
| `"${NIMRTC_LLM_API_KEY}"` | 已设置 | 环境变量的值（trim 后） |
| `"${NIMRTC_LLM_API_KEY}"` | 未设置 | **未设置**（空串）+ 一条警告 |
| `"sk-abc123..."` | 任意 | 原样保留（明文回退路径仍可用） |
| `"prefix-${VAR}"` | 任意 | 原样保留（混合形式不做展开） |

**不做部分展开**。`prefix-${VAR}` 这类写法原样保留：部分展开会在
「变量没设」时静默产出半个密钥，比不展开更难排查。

### 3.2 优先级（与 ADR-022 一致，不改）

```
ZELTO_LLM_API_KEY > DEEPSEEK_API_KEY > 配置文件里的 llm.apiKey
```

配置文件里的值如果是 `${VAR}` 引用，**展开后**落在第三级。
也就是说：环境变量里若有 `ZELTO_LLM_API_KEY`，它仍然赢过配置文件里的引用。
「显式覆盖隐式」这条不变。

### 3.3 未设置时的行为

引用指向的环境变量没设置 → `llm.apiKey` 视为未设置，并打印：

```
  ⚠️  Config: llm.apiKey 引用了环境变量 NIMRTC_LLM_API_KEY，但它没有设置。
      LLM 通路（clarify / spec / stall）将不可用。
```

不设置不算错误 —— 通路 B 本来就是可选的（ADR-022 §3.3）。
相关命令照旧报 `LLM_NOT_CONFIGURED`。

**关键**：绝不把字面量 `${NIMRTC_LLM_API_KEY}` 当成密钥发出去。
「密钥看起来是填了的，实际填的是占位符」这种静默失效是本 ADR 要根除的东西。

### 3.4 只作用于 `llm.apiKey`

`llm.baseUrl` / `llm.model` / `llm.pricing` 是**配置不是密钥**，
留在文件里才能保证项目可复现（ADR-022 §3.1）。它们不做展开。

`gate.commands[].run` 里的 `$` / `${}` 有别的归属：那些是**交给 shell 执行的命令**，
shell 自己会做变量替换。zelto 在这里展开会抢 shell 的活，且改变命令语义。
因此不碰。

---

## 4. 实现位置

| 内容 | 位置 |
|---|---|
| 引用解析（纯函数） | `src/cli/commands/shared.ts` — `parseEnvRef()` |
| 配置展开（纯函数） | `src/cli/commands/shared.ts` — `expandConfigEnvRefs()` |
| 接入加载流程 | `src/cli/commands/shared.ts` — `loadConfig()` |
| 判定测试 | `tests/credential-resolution.test.ts` |

`parseEnvRef()` 与 `expandConfigEnvRefs()` 都是纯函数，`env` 可注入，
不读全局状态 —— 与 ADR-022 的 `resolveApiKey()` 同一风格。

`loadConfig()` 的调用顺序变为：

```
parseConfigYaml(content)   →  expandConfigEnvRefs(parsed)  →  validateConfig(expanded)  →  withEnvApiKey(expanded)
```

展开在「校验」之前 —— 校验要看的是展开后的真实值
（比如占位符判断 `sk-your-key-here`）。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 不新增状态位置；`.zelto/config.yaml` 格式不变，只是取值方式多了一种 | ✅ |
| **C3** | 展开只影响通路 B（LLM 草稿）的密钥来源，不参与任何判定结论（与 ADR-022 §2.4 同理） | ✅ |
| **C2** | 改动只在 `src/cli/`，`core/` 不动 | ✅ |
| **C4** | 不新增事件类型 | ✅ |
| **C7** | 展开后的密钥只用于 LLM 通路，产出仍只是草稿 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格行为；
配置格式的**读取**方式扩展，未改变文件格式本身。

---

## 6. 后果

**好的**

- 配置文件可以只写「非密钥部分」，密钥真的不落盘。
- 不设变量时给出可操作的提示，而不是 401。
- 同类项目已有的 `${NIMRTC_LLM_API_KEY}` 写法从「静默失效」变成「正常工作」。

**代价与边界**

- 配置文件格式的**读取**语义变了 —— 这是契约变更，故有此 ADR。
- 只支持整值引用，不支持 `prefix-${VAR}` 混合形式。
- 只作用于 `llm.apiKey` 一个字段。想让别的字段也支持，需要再评估
  （`baseUrl` 涉及可复现性，`run` 涉及 shell 语义，两者都不该顺手扩）。

**明确不做**

- 不做 `~/.zelto/credentials` 之类的独立密钥文件（多一处状态位置，与 C1 相悖）。
- 不做密钥加密后存进配置（自造加密 = 可解密的明文）。
- 不读 `.env` 文件（引入 dotenv 依赖，且 `.env` 的加载时机是另一个话题）。

---

## 7. 验收标准

1. `llm.apiKey: "${VAR}"` 在 `VAR` 已设置时，解析出环境变量的值。
2. `VAR` 未设置时，解析结果为空串，并打印点名变量的警告。
3. 明文 `apiKey` 的行为不变（回退路径仍可用）。
4. 混合形式 `prefix-${VAR}` 原样保留，不展开。
5. `ZELTO_LLM_API_KEY` 仍然覆盖配置文件里的引用（ADR-022 优先级不变）。
6. `llm.baseUrl` / `llm.model` / `gate.commands[].run` 不做展开。

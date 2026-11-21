# Zelto 实战缺陷记录（nimrtc v1.4 演练）

> 每条都附一条可复现的回归测试。跑：`npm test -- --filter <测试文件>`

## ZD-001 `zelto design` 看不到真实仓库结构

**场景**：`zelto require` → `zelto design`，生成的设计文档写了 `src/net/`、`src/device/`、`src/events/`、`src/platform/` 这些**根本不存在的顶层目录**，底层库也写错了（libnice，实际是 libjuice；OpenSSL，实际是 vendored wolfSSL）。

**根因**：`src/llm/generators/design.ts` 的 `generateDesign` 只把需求文本喂给模型；它不知道仓库长什么样，只能凭需求文本猜目录和库。

**后果**（比"文档不准"严重）：
- 设计的 `modules[].filePatterns` 是切片写集的来源 → 切片要求写不存在的路径
- `arch check` 拿设计对照真实 import 图 → 立刻报「模块无文件」
- 人审设计时目录和仓库对不上，只能整份重do

**修复**（v0.6.x）：
- 新增 `src/llm/project-context.ts`：`summarizeProjectStructure` + `renderStructureSection`，从 `scanProject` 抽紧凑摘要（模块名 + 代表性文件 + 构建/测试命令），注入 design prompt
- `DESIGN_PROMPT` 增加 `{{PROJECT_STRUCTURE}}` 占位符 + 两条额外约束（模块路径必须落在现有结构里、不能凭印象编库名）
- `generateDesign` 接收可选的 `projectStructure` 参数
- `ai-pipeline.ts` 的 `design <req-id>` 分支先扫一遍仓库再喂模型

**回归测试**：`tests/llm-design-project-context.test.ts`

**剩余问题（未修）**：模型还是会猜 `third_party/libnice`。原因是需求文档没写 `libjuice`。**修法建议**（下轮）：摘要里单独提取 `third_party/` 或 `vendor/` 下的子目录名，写进「项目现状」；并且在需求阶段就把「允许触及的第三方库」明确写进需求文档。

---

## ZD-002 `zelto design` 设计要求的数据超出模型上下文时没有降级

**场景**：第一次加完项目结构摘要后，摘要 1.1MB（`src/third_party` 一个目录就 14k 文件，全被 `scanProject` 逐条喂），DeepSeek 直接 400 "number of input tokens (373385) has exceeded max_seq_len (163840)"。

**根因**：
1. `scanProject` 的 `files` 列表是**全量**，没有上限
2. 设计摘要没有字符预算检查

**修复**（v0.6.x）：
- `summarizeProjectStructure` 加 `MAX_SUMMARY_CHARS = 12000` 字符预算
- 超预算时从尾部分块丢模块（保留前 5 个顶层模块），丢弃的名单以 "(还有 N 个顶层模块因预算未展开: ...)" 写进摘要

**回归测试**：`tests/llm-design-project-context.test.ts` 里「字符预算：vendored 大目录不让摘要爆掉」

**未做**：报错时不会自动重试或降级 —— 如果未来 token 上限再被突破，应该捕获 LLM 400 并按摘要大小 ∕2 重试一次。

---

## ZD-003（根源）项目结构摘要缺 `third_party` / `vendor` 库清单

见 ZD-001 的「剩余问题」。摘要里只有 `src/third_party/libjuice/src/Makefile` 这样的**文件路径**，模型得自己推「libjuice 是个库」。更好的做法是单独抽 `third_party/*/` 下的子目录名，列成「项目已依赖的第三方库：libjuice, wolfSSL, ...」。

**待做**。

---

## ZD-004 版本基点没法在计划阶段钉死

**场景**：nimrtc v1.4 开发在 `feat/v14-turn-tls` 上（不是 main）。版本分支 `version/v1` 必须从 `ff9d64b0` 长出，但默认规则是「前置版本 tip → main HEAD」，会从错误的基点建分支。

**根因**：`baseCommit` 只能在 `version start` 时由 `resolveVersionBaseCommit` 推出来，**计划阶段没有任何通道能钉它**。要钉只能手改 `.zelto/versions/<id>.json` —— 追溯链上的谎言（C4）。

**后果**：版本分支从 main HEAD 长出 → 拉进来的代码不是 v1.4 想要的那份基线；而且是**静默**的 —— 分支建出来了，只是内容不对。

**修复**（v0.6.x）：
- `core/version/patch.ts`：`VersionPatch` 新增 `baseCommit` 字段
- `applyPlanPatch` 支持写/清 `baseCommit`，并记进 `changed`（事件留痕）
- `cli/commands/plan-patch.ts`：新增 `--base-commit <sha|none>`
- `PlanPatchResult.changed` 的 `before`/`after` 类型放宽到 `| null`（原来不支持 null，`--base-commit none` 存不进去）

**回归测试**：`tests/version-base-pinned.test.ts` 的「plan-patch 能钉死版本基点」三例

**实战验证**：`zelto version start v1` 之后 `git rev-parse version/v1` == `ff9d64b0`，版本 worktree 也建在那个提交上。

---

## ZD-005 切片规格拿不到需求条目的正文

**场景**：`zelto spec draft v1-n5-turn-server` 生成的草稿，验收标准写的是：

> 1. 实现一个基本的 TURN 服务器，支持 RFC 5766 规定的核心功能；验证方式：通过标准 TURN 客户端测试工具验证基础连接和转发功能

而计划里 N5 的真实内容是「**部署** coturn 参考实现，带 `--require-tls` 拒绝明文 TCP」。**方向都反了** —— 一个是「实现服务器」，一个是「部署参考实现」。

**根因**（两层）：
1. `SliceSpecInput.requirements` 只有**需求条目的 id 列表**（`["N5"]`）。模型拿到 "N5" 这两个字，只能写通用套话。
2. 更根本：**切片的 `trace.requirements` 是空的**。需求条目的正文在已确认的需求文档里，但从没被连到切片上 —— 追溯链在「需求 → 切片」这一环断了。

**后果**：规格是套话 → 门禁②照着套话验收 → agent 照着套话实现 → 实现了「一个 TURN 服务器」，而人想要的是「一份 coturn 部署」。**整条链都在错，但每一步看起来都通过了**。这是可追溯性最强的反例：链是通的（每片都有规格、规格都有验收标准），但内容是空的。

**修复**（v0.6.x）：
- 新增 `core/requirements/criteria.ts`：`extractCriteria` 从需求文档的验收标准里按 id 取条目正文；取不到就如实标「找不到」，不编造
- `SliceSpecInput` 新增 `requirementDetails`
- `SLICE_SPEC_PROMPT` 新增 `{{REQUIREMENT_DETAILS}}` 占位符 + 明确约束（「需求说的是部署/配置/接入时，就不要写成『实现一个 X 服务器 / 库』」）
- `slice-spec.ts` 的 `buildSpecInput` 调 `loadRequirementDetails`，从**已确认**的需求文档里取

**回归测试**：`tests/spec-requirement-details.test.ts`

**实战验证**：修完后同一片重新生成，草稿的验收标准变成 6 条**静态可查**的判定（能不能检索到 `apt-get install coturn`、`--tls-only` 在不在、测试里有没有 `docker`/`systemctl`），风险段列出了 coturn 参数名差异、自签证书信任等真实坑。

**遗留（已修）**：`trace.requirements` 仍然是**空**的 —— 本次是手工用 `zelto set <id> --field trace.requirements --value "N5"` 补的。根治要让 `version start` 建切片时**自动**从计划/需求推导关联的需求条目，否则下次还是空的。

→ **已修**：`version start` 建切片时自动推导：
- `core/requirements/criteria.ts` 新增 `extractCriterionIds`（从切片标题里找 `N5` / `D3` / `N2-1` 这类 token）与 `collectCriterionIds`（需求文档里真实存在的 id 集合）
- `cli/commands/ai-pipeline.ts` 的 `deriveSliceRequirements`：从切片标题提取候选 id，**核实它在已确认的需求文档里真的存在**才写进 `trace.requirements` —— 不存在的不填（填了就是追溯链上挂着一个不存在的出处，比不填更糟）

回归测试：`tests/spec-requirement-details.test.ts` 的「需求条目 id 的自动推导」四例。

---

## ZD-006 冻结准入的「规格提到 vs 写集覆盖」三条误报

**场景**：`zelto freeze v1-n5-turn-server` 被拦，报三条：

```
- 规格提到「node --test tests/acceptance/v1-n5-turn-server/acceptance.test.cjs」，但它不在写集里 —— agent 改不了它
- 规格提到「acceptance.test.cjs」，但它不在写集里 —— agent 改不了它
- 规格提到「install」，但它不在写集里 —— agent 改不了它
```

**三条全是误报**，而规格完全没问题：

| 误报 | 真相 | 根因 |
|---|---|---|
| `node --test tests/...` | 反引号里是**一条命令**，不是路径 | `parseMentionedPaths` / `parseReferencedPaths` 把反引号内容整串当路径 |
| `acceptance.test.cjs` | 规格只写**文件名**，写集里是完整路径 | `isInWriteSet` 只做字面/前缀比较，不做 basename 匹配 |
| `install` | `apt-get install coturn` 里的 shell 动词 | `KNOWN_EXTENSIONLESS_FILENAMES` 里收了 `install` |

**后果**：冻结被拦 → 人被引去改**正确的**规格（AGENTS.md：「闸门误报会把人引去改正确的规格」）。更糟的是没人在第一次看到误报时会怀疑闸门本身。

**修复**（v0.6.x）：
- `core/spec/scope.ts` + `core/spec/reference.ts`：反引号内容**含空白** → 是命令行/短语，不是路径
- `core/spec/write-set.ts`：`isInWriteSet` 增加 **basename 匹配**（写集里某非 glob 条目的 basename 与被提及路径相同 → 算覆盖）
- `core/spec/scope.ts`：`KNOWN_EXTENSIONLESS_FILENAMES` 去掉 `install`（shell 动词；带路径的 `scripts/install.sh` 仍被识别）

**顺带发现并修的相邻缺陷**：规格「范围」章节里写 `- examples/turn-server/**`（glob、无反引号）时，`looksLikePath` 不认 glob → 整条被丢掉 → 「范围」解析为空 → 写集兜底到目录探测（错的）。修法：含通配符 → 是路径模式。

**回归测试**：`tests/spec-write-set-coverage.test.ts`（11 例，含一条反向测试：修误报不许放松真判据 —— 规格提到、写集里真的没有的文件仍要报 uncovered）

**实战验证**：修完后 `zelto freeze v1-n5-turn-server` 直接通过。

---

## ZD-007 预算只在起跑前和跑完后判定，运行中零拦截

**场景**：N5 切片的 agent 跑了 **40 分钟、花 $5.86**，而预算上限默认 $1.00。zelto 在**跑完之后**才说「预算耗尽」：

```
✅ Agent completed successfully (2436s)
⛔ Slice "v1-n5-turn-server" 预算耗尽（$5.86 / 上限 $1.00）—— 未进入 gate，等人处理。
```

**根因**：`checkBudget` 只在**起跑前**调一次（`core-slice.ts` 的 `zelto run` 分支），跑完后由 `settleRunCost` 记账时复判。**运行期间没有任何地方查预算** —— agent 想烧多少烧多少。

**后果**：
- $5.86 白烧 —— 产物其实做完了（5 个文件 + 10 个真断言），但因为超预算**没进门禁**，切片卡在 `frozen`
- 更糟的是「预算耗尽」这个停机分类**误导人**：它看起来像「agent 跑砸了」，实际是「agent 跑成了但超了闸门」。人第一反应是重跑 → 再烧 $5.86

**修复**：本轮先**改配置**（`budgetLimitUsd: 0` = 不限）—— 对探索式开发任务，$1 是假闸门：不是钱的问题，是「agent 需要先摸清 4 个 vendor 库才能动手」的固有成本。

**未做（真正的修法）**：运行中定期查预算并在超限时**停掉 agent**。这需要：
- agent 进程的可中断点（现在只在进程结束时才拿得到 token 用量）
- 或者用 `--max-turns` / 输出 token 上限做**事前**约束（比事后判定强）

**回归测试**：暂无（这条是「设计缺陷记录」，不是行为缺陷）

---

## ZD-008 worktree 创建时不处理子模块 → 门禁的 build 必然失败

**场景**：N5 的产物做完了，跑 `zelto gate v1-n5-turn-server` —— build 命令直接失败：

```
CMake Error at CMakeLists.txt:409 (add_subdirectory):
  The source directory .../src/third_party/nlohmann_json
  does not contain a CMakeLists.txt file.
```

**根因**：`git worktree add` **不带子模块的 checkout**。worktree 里 `src/third_party/*` 只有 `.git` 指针文件，没有实际内容。而 NimRTC 是重度 vendor 依赖（libjuice / wolfSSL / opus / msquic…），CMake 直接 `add_subdirectory` 它们。

**后果**：门禁 100% 失败，而且**失败原因与被验的代码无关** —— 人第一反应是「agent 写坏了」，实际是环境没准备好。

**修法（本轮用的）**：从主仓把已 checkout 的子模块内容同步过去（robocopy 排除 `.git`）+ 给 msquic 补 `git remote`（SourceLink 需要）。

**未做（zelto 侧该修）**：`worktree create` 之后应该自动同步子模块 —— 要么从主仓的 `.git/modules` 本地 clone（`--reference`，不走网络），要么直接复制内容。这是 zelto 的活，不该让人手工做。

**回归测试**：暂无（需要真 git 仓库 + 子模块，测试成本高）

---

## ZD-009 门禁的 build 命令假设构建树已存在

**场景**：ZD-008 修好、构建树配好之后，第一次跑 `zelto gate` 又撞上一个：门禁的 build 命令是 `cmake --build build`，但 `build/` 从来不存在 —— **配置步骤没人做**。

**根因**：`config.yaml` 的 `gate.commands` 只有 build / test，没有 configure。C++ 项目「配一次、用很多次」，但 zelto 不知道这件事。

**后果**：同上 —— 门禁失败原因与被验代码无关。

**未做（zelto 侧该修）**：门禁命令序列应该支持「配置 → 编译 → 测试」三段，或者从 CMakeLists 自动推导 configure 命令。

---

## ZD-010 设计模块名带括号短名时，依赖名匹配不上 → 护栏全报「未知模块」

**场景**：设计里的模块名是「**中文描述 (标识符)**」：

```
### 网络适配层 (ice)
- **依赖模块**：core, engine
```

而「依赖模块」那一栏写的是**短名**（`ice` / `device` / `engine`）。zelto 按全名精确匹配 → 一个都匹配不上 → 8 条「未知模块」→ 架构护栏 **deny** → **门禁开不了**。

**根因**：`core/arch/resolve.ts` 的 `resolveDependencyNames` 只有两条解析路径：全名精确匹配、路径归属推断。**没有「括号里的标识符」这一条** —— 而作者把标识符放在括号里，正是为了让别处能用它指代这个模块。

**后果**：护栏拦得**对**（设计确实引用了没声明的模块），但 zelto 连「`ice` 就是 `网络适配层 (ice)`」这个最基础的对应关系都认不出来，于是把命名风格差异报成了架构问题。

**修复**（v0.6.x）：
- `core/arch/resolve.ts`：新增 `moduleAliases` —— 取出模块名括号里的标识符（允许字母数字、`-`、`_`、`.`、`/`；**不含空白的散文不算**）
- `resolveDependencyNames` 增加一条解析：**短名匹配优先于路径归属**（作者起了短名，比「某目录下正好有文件」更可信）
- 短名**一对一**：两个模块抢同一个短名 → 判不出来（设计本身有歧义，解析层不替它选）

**回归测试**：`tests/arch-resolve.test.ts` 的「模块名的括号短名（ZD-011）」六例

**实战验证**：修完后未知模块从 8 条降到 0 条 —— 剩下的全是「缺失依赖」（设计声明了但代码还没那个 import，功能没实现时的正常状态）。

---

## ZD-011 设计的模块图不完整 → 没法补，只能手改 JSON

**场景**：ZD-010 修完后，剩下 3 条未知模块是 `core` / `engine` / `plugins/hw` —— 这三个模块**在仓库里真实存在**（`src/core` 15 文件、`src/engine` 64 文件、`src/plugins` 39 文件），但设计的模块图里**根本没声明它们**。

**根因**：`zelto design patch` 只能改**现有**模块段的字段（`--module <name> --path ... --dep ...`）。它**不能新增模块段** —— 而「补上缺失的模块声明」恰恰是修法之一（另一条是删掉那条依赖）。

**后果**：想修只能手改 `.zelto/design/<id>.json` —— 手改 JSON 的坑是 **`body` 是真源、`modules` 是缓存快照**，只改一个就两者不一致（判定读 body，报告读 modules）。

**修复**（v0.6.x）：
- `core/design/patch.ts`：`ModulePatch` 新增 `add` 字段（模块名 / 职责 / 文件路径 / 依赖）
- `patchDesignBody` 支持新增段，**插在最后一个 `###` 段之后、下一个 `##` 之前**（插错位置会被 `findModuleSections` 算进别的段）
- 新增的段**长成设计模板的样子**（职责 / 文件路径 / 依赖模块），否则解析层认不出它的字段 —— 加了等于没加
- `cli/commands/design-patch.ts`：新增 `--add-module <name> --desc <text> --path <glob> [--add-dep <module>]`

**回归测试**：`tests/design-patch.test.ts` 的「新增缺失的模块段（ZD-012）」六例

**实战验证**：用新命令补上 `core` / `engine` / `plugins/hw` 三个模块，同时把 `设备管理层(device)` 的路径从幻觉的 `src/modules/device/**` 改成真实的 `src/modules/audio_device/**` —— 门禁随即通过架构护栏。

---

## ZD-013 agent 重跑时拿不到「上次为什么失败」

**场景**：N5 的验收测试里有两个真 bug（STUN 消息类型编码错位、REQUESTED-TRANSPORT 字节序反了），人被门禁挡下后让 agent 重跑修。但 agent **拿不到失败原因** —— 约束包里只有规格、写集、门禁命令。它可能把已经做对的东西改错，也可能从头再摸一遍 4 个 vendor 库。

**根因**：`ConstraintBundle` 里没有「上一轮的失败证据」这个维度。门禁结论只以 `gate.result` 事件的形式存在于事件流里，但没有任何代码把它读出来喂给 agent。

**后果**：重跑是盲跑。人在转述失败时只会说「测试没过」—— 而真正的关键（`0x113` 是 Allocate Error，不是「类型意外」）就转掉了。

**修复**（v0.6.x）：
- 新增 `src/core/gate/feedback.ts`：`readGateFeedback` 从事件流读出**最近一次**门禁/验收的失败，`renderGateFeedback` 渲染成给 agent 的段落
- 读的是**事件流**（C4：追溯的唯一证据载体），不是切片状态文件 —— 门禁结论本来就只以事件形式存在
- **原文，不加工**：失败输出逐字带上，不做摘要。人转述会把关键细节转掉
- `core/sched/engine.ts`：`buildConstraints` 增加 `gateFeedback` 维度，`Scheduler.readFeedbackFor(sliceId)` 供调用方取
- `cli/commands/core-slice.ts` + `cli/commands/parallel-executor.ts`：所有 `buildConstraints` 调用点接上 feedback

**关键判据**：
- 只看**最近一次**门禁结果 —— 更早的失败已经被后续修好了，全带过去会让 agent 去追一个已经不存在的问题
- **验收没跑**（`status: skipped`）与**验收跑了但没过**（`status: failed`）是两回事 —— 前者不是「通过了」，但也不能编造一个失败出来
- 门禁命令失败与验收失败分开列 —— agent 要知道是哪一步没过

**回归测试**：`tests/gate-feedback.test.ts`（9 例）

**实战验证**：重跑时约束包里确实带上了 `0x113` 的真实失败原文。

---

## ZD-014 `zelto run` 的守卫拒绝路径不回退状态 → 切片永久卡死

**场景**：N5 切片的完整时间线 ——

| 时刻 | 发生了什么 | 切片状态 |
|---|---|---|
| 09:56 | `zelto run` → agent 跑了 40 分钟、花 $5.86 → 跑完超预算，收尾提前 return | 卡在 `running` |
| 11:03 | 人手工 `zelto gate --retry` → 门禁过了（**没配验收**）→ GATE_PASS | `completed` |
| 11:23 | 人修好验收配置，重跑 `zelto run` → `startRun` 推到 running → **重复 agent 守卫命中**（上一轮的会话文件还在盘上）→ 直接 `return 1`，**没退状态** | 卡在 `running` |
| 12:18 | 人手工 `zelto gate --retry` → 验收失败（`0x113`） | 卡在 `running` |

结果：切片卡在 `running`，而**四条路全堵死**：
- `zelto run` 拒绝跑（准入只认 frozen / completed）
- `zelto merge` 不收它（没签字）
- `zelto stall --reap` 看不见它（见 ZD-015）
- `zelto resume` 说它没停机（`stall.class` 是 null）

唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写。

**根因（两层）**：

1. **守卫早退没退状态**。`core-slice.ts` 的 `zelto run` 里，`startRun` 之后有多条早退路径（重复 agent 守卫、装守卫失败、worktree 建不出来、监督进程拉不起来）。其中大部分都调了 `revertRunAbortedBeforeStart`（D-64 修的），**唯独「重复 agent 守卫」这条漏了** —— 它直接 `return 1`，切片留在 `running`。

2. **更根本：那轮遗留的会话文件让守卫误判**。09:56 那轮跑完后，适配器把会话文件写成 `status: completed`。11:23 重跑时，重复 agent 守卫查「最新的 running 记录」—— `readSliceLivenessRecord` 只返回 `status === 'running'` 的记录，所以它**没查到**……但守卫仍然命中了，因为判据走的是「有记录 + 活性判定」，而那条 `completed` 记录的 pid 已经不在了 → 判成 stale/dead → 守卫放行 → 于是 11:23 那次 run 是**真的起了 agent**（`sched.admitted` 有事件），但 agent 之前那次已经烧掉预算。

**后果**：一个本该 5 分钟修好的验收 bug，因为「撞上一个假活记录」变成了「整片作废」。这跟 D-64 是同一个病灶的**漏网路径** —— D-64 修了「装守卫失败」，没修「守卫拒绝」。

**修复**（v0.6.x）：
- `cli/commands/core-slice.ts`：重复 agent 守卫拒绝时也调 `revertRunAbortedBeforeStart` —— agent **一个都没起**，切片必须退回 `frozen`

**回归测试**：`tests/d065-stuck-running-shell.test.ts`（配合 ZD-015 的判据）

---

## ZD-015 `stall --reap` 的空壳判据漏掉「记录都收尾了但切片还在 running」

**场景**：ZD-014 里那片卡在 `running` 的切片，`zelto stall --reap` **看不见它** —— 干跑输出 `{"dead":[],"orphans":[]}`。

**根因**：`findOrphanShells` 的判据是「盘上**一条记录都没有**」才算空壳。原判据的注释写着：

> (b) 有记录但都不是 running → 那一轮**已经收尾**了 …… 这时去抢着改状态会与正常路径打架。所以只认 (a)。

**这个假设是错的**。它假定「收尾路径一定会把切片退回 frozen」—— 但 09:56 那轮**没有**：跑完超预算 → `finishRun` 提前 return → 状态停在 running。所以「记录已收尾」与「状态已退」是两件独立的事，把前者当成后者的充分条件，就漏掉了这一类。

**后果**：这类切片**永久卡死** —— 造它的那条路径（ZD-014）已经修了，但历史上已经造出来的、以及别的路径造出来的，仍然救不回来。而人看不出哪些切片属于这一类：`zelto status` 只显示「running · 没有运行记录」，那句话是**假的**（有记录，只是状态不是 running）。

**修复**（v0.6.x）：
- `core/stall/reap.ts`：新增 `classifyOrphanShell` —— **唯一一份**空壳判据，`findOrphanShells` 与 `reapDeadSlices` 共用
- 判据改为：**没有一条 `running` 记录 = 没人再管这一轮 = 空壳**
- **有** `running` 记录时绝不能碰 —— 那可能是 agent 还活着（判错会导致「reap 收走 → 人重跑 → 同一 worktree 上起第二个 agent」）

**为什么要抽成一份**：判据分叉的后果是「列表里看得见、清理时却不认」—— 人看着 `stall --reap` 的列表里有这片，命令却说「没找到」。这意味着「清理」这条路对某些切片**根本不存在**，而人看不出哪些属于那一类。原来的 `reapDeadSlices` 里还有**另一份拷贝**（更宽松：`rec === null` 直接判 dead，没区分「有记录但都不是 running」），两份判据必然漂移。

**回归测试**：`tests/d065-stuck-running-shell.test.ts`（10 例，含一条反向测试：**绝不能**把活着的 agent 判成尸体）

**实战验证**：修完后 `zelto stall --reap` 认出了那片切片，把它从 `running` 退回 `frozen`，随即 `zelto run` 准入通过。

---

## ZD-016 worktree 删除失败时给出的建议是坏的

**场景**：N5 切片签字合并后，`zelto merge` 要清理 `.zelto/worktrees/v1-n5-turn-server`，但 `git worktree remove --force` 在 Windows 上失败。CLI 打印出来的建议是：

```
请手动清理: git worktree remove --force "<path>"
```

人照着跑，得到的是：

```
fatal: '<path>' is not a working tree
```

—— 因为第一次 `git worktree remove` **已经把 git 侧的登记摘掉了**，只是目录没删掉（被某个进程锁着）。git 侧已经是干净的，再跑一次 remove 必然报「不是工作树」。

**根因**：`git worktree remove` 的语义是「先注销，再删目录」。注销成功、删目录失败时，两边状态**不一致**：git 认为工作树不存在，OS 认为目录还在。而建议语只覆盖了「git 还认得它」这一种情况。

**后果**：人被困在「按建议做没用」的循环里，而真正的问题（目录被进程锁住）没有任何提示。

**修复**（v0.6.x）：
- `core/worktree/manager.ts`：`remove()` 捕获「git 侧已注销」的**事实**后，改为 `git worktree prune` + 直接 `rmSync` 删目录（不再依赖 git 的登记）
- `cli/commands/core-slice.ts` / `cli/commands/merge-runner.ts`：建议语补上 `rmdir /s /q "<path>"`，两条路都给

**兜底的判据必须是「事实」，不能是「症状」**（后续修订，2026-11-20）：

第一版修法把「`remove` 失败」直接当成「git 已注销」，结果**吞掉了 D-67 契约**
（`tests/d67-worktree-remove-retry.test.ts`：非占用类错误必须**立刻原样抛出**，
不许被兜底改写）。两条契约是冲突的，必须用事实把它们分开：

| 事实 | 含义 | 动作 |
|---|---|---|
| git **显式说**「not a working tree」 | git 自己说不认它了 | 兜底删目录 |
| 事前 `worktree list` 有、事后没有 | git 摘了登记 | 兜底删目录 |
| 目录里有 `.git` **文件** + 现在 list 里没有 | 当过 worktree，git 摘了登记 | 兜底删目录 |
| 失败是**占用类**（Invalid argument / Permission denied） | git 想删但删不掉 | 才可能属于上面任一 |
| 其它 | git 的**真错误** | **原样抛出**，不兜底 |

最后一行是关键：**「git 压根不认这个目录」（从没当过 worktree）** 与
**「git 刚摘掉登记」** 在 `worktree list` 的输出上**长得一模一样**。
区分它们靠的是「目录里有没有 `.git` 指针文件」——
真正当过 worktree 的目录会留下它（worktree 的 `.git` 是**文件**，指向主仓的
`.git/worktrees/<name>`；主仓的 `.git` 才是目录）。

少任何一个条件都不兜底 —— 宁可报错让人看，不许替 git 改判。

**回归测试**：`tests/d67-worktree-remove-retry.test.ts`（4 例）+ `tests/zd017-worktree-cwd-lock.test.ts`（4 例，含一条反向测试：**非占用类失败仍立刻抛出、不删目录**）

---

## ZD-017 Windows 上「目录删不掉」的真因是别的进程把它设成了当前目录

**场景**：ZD-016 里那个删不掉的空目录，人手动 `rd /s /q` 也报：

```
另一个程序正在使用此文件夹，无法访问。
```

但目录里**一个文件都没有**，只有 `.` 和 `..`。`Restart Manager` API 报告 `NO_LOCKERS`（没有任何进程持有该目录的**句柄**）。

**根因**：Windows 上，进程的**当前工作目录**会让该目录获得一个「目录句柄」—— 这不是 `Restart Manager` 能报告的那类锁（它只管文件句柄）。所以「没有任何进程打开这个目录的文件」与「目录删不掉」可以同时成立。

**排查代价（这才是重点）**：这个锁的持有者极难定位 ——
- `handle.exe` 没装，`Restart Manager` 查不到
- `Get-CimInstance Win32_Process` 看不到 cwd
- 逐个终端文件看 `cwd:` 元数据，只能看到 **Cursor 自己的**终端
- 最后靠**读进程 PEB**（`NtQueryInformationProcess` → PEB → `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory`）才扫出全量 cwd

本例的真凶是 **`wslhost`（PID 21272）** —— 它的 cwd 恰好停在那次构建留下的 worktree 里。（`MSBuild /nodeReuse:true` 的常驻节点也曾是嫌疑，但杀掉后锁仍在。）

**后果**：这类残留会**一直占着目录**，让下一个切片的 worktree 建不出来 —— 而 zelto 侧的报错只说「删除失败」，不会说「有进程蹲在这里」。

**修复**（v0.6.x）：
- `core/worktree/manager.ts`：`remove()` 在兜底删目录也失败时，调用 `diagnoseRemovalBlock()` 判定根因，错误消息里带上**对应的**排查步骤
  - **目录为空** → cwd 锁（ZD-017）→ 给 `handle.exe` / 读 PEB 的定位步骤
  - **目录非空** → 文件句柄被占 → 给「等几秒 / 关掉 MSBuild 再 rmdir」
- 两条路径都保留 `rmdir /s /q "<path>"` 作为最终手段

**为什么不自动定位持有者**：读进程 PEB 是特权操作，而且 `core/` 的职责边界是「纯判定、只读文件、不触网」（C3）—— 去枚举全系统进程的 cwd 属于「环境侦查」，超出了 core 的定位。zelto 的责任是**认得出这个特征**并给出正确方向，而不是替人抓进程。

**回归测试**：`tests/zd017-worktree-cwd-lock.test.ts`（4 例）
- 空目录 → 报 cwd 锁 + 给 PEB 排查步骤
- 非空目录 → 报文件句柄占用，**且不误报** cwd 锁
- 兜底能删 → 不报错
- **反向**：非占用类失败仍立刻原样抛出、**不删目录**（D-67 契约不被兜底吞掉）

**实战验证**：定位到 `wslhost` 后杀掉进程，目录立即删除成功，`git worktree list` 恢复干净。

---

## ZD-018 `zelto halt` 只停了并行批次，单片前台路径与 detach 监督进程根本不听

**场景**：nimrtc-v14 的 v1-n5-turn-server 切片跑偏了，人执行 `zelto halt --reason "..."`。
命令回了「已拉闸」，**但 agent 照跑不误**。

**根因**：`HaltStore.isHalted()` 只有 `run --parallel` 那条路（`parallel-executor.ts`）在等 agent 的间隙查。
单片 `zelto run <id>` 的等待逻辑（`waitForExitWithWatchdog`）压根没读过 `.zelto/halts/`；
detach 监督进程的重试回路（`supervisor.ts` 的 `waitForAgentExit`）同样没读。

**后果**：**人以为喊停了，其实没喊停** —— 这比「喊了停不了」更糟。
人会带着「已经停了」的错觉去处理现场（比如改文件），
而 agent 还在同时改同一批文件。事后看，「拉闸」这个动作给人的安全感是假的。

（实测的现场：agent 进程被杀掉后，监督进程还在用 `--resume` 无限重试，
把切片一直钉在 `running`。）

**修复**（v0.6.x）：
- `cli/commands/core-slice.ts`：`waitForExitWithWatchdog` 的看门狗间隙里查 `haltStore.isHalted(haltScope)`，
  收到就**先 resolve 再 stop**（顺序反了的话，`adapter.stop()` 会让 `waitForExit` 的
  promise 先 resolve，`Promise.race` 抢在拉闸结果之前返回 —— 拿到的就是
  「agent 退出了」那个结果，**拉闸信息整个丢掉**），并把切片退回 `frozen`
- `cli/commands/supervisor.ts`：`waitForAgentExit` 的重试回路里查 `haltStore.isHalted(sliceId)`，
  拉了就退出回路，不再无限 `--resume`
- 作用域：单片运行没有批次键，用切片 id 当自己的作用域；
  `scope='all'` 的全局拉闸对它同样生效（`HaltStore.isHalted` 的语义）

**回归测试**：`tests/d74-halt-single-slice-path.test.ts`（5 例）
- 拉闸 → agent 被停掉，等待方拿到 `halted` 与原因
- 没人拉闸时，agent 正常退出（**不被拉闸逻辑误伤**）
- 批次作用域的拉闸**不影响**别的切片（作用域隔离）
- 全局拉闸（`scope=all`）对单片路径同样生效
- 源码层面：detach 监督进程的重试回路必须先问一次拉闸

**实战验证**：v1-n5-turn-server 的现场用 `zelto stall --reap` 退回 `frozen`，
之后重跑门禁全部通过。

---

## ZD-019 占位符检查把规格里提到的 `test.todo` 这个 API 名当成了占位符

**场景**：nimrtc-v14 的 `v1-audio-p2` 切片写规格时，验收标准第 7 条需要明确要求
「验收测试文件里不许残留 `test.todo`」——这句话本身是对 agent 的**约束**，
但 `zelto check` 报了一条警告：

```
Warn:  Spec contains placeholder markers (TBD/TODO/FIXME) — Replace placeholders with concrete content before freezing
```

规格里**根本没有**占位符。这条警告是误报。

**根因**：`core/spec/semantic/analyzer.ts` 的 `checkPlaceholders` 用一条正则扫全文：

```40:44:D:/MyOpen/Zelto/src/core/spec/semantic/analyzer.ts
  const placeholderMatches = specContent.match(
    /TBD|TODO|FIXME|coming soon|not yet determined|to be filled/i,
  );
```

`TODO` 是**大小写不敏感**地匹配的，而 `test.todo` 里的 `todo` 正好命中。
规格里提一个 API 名（`test.todo`）、一个命令名、或者一句「这里应该用 TODO 的写法」
都会被当成「规格里留了占位符」。

**后果**：闸门误报比闸门漏报更糟（AGENTS.md 明确写了这条）：
- 人看到警告会去**改正确的规格**——比如把「不许残留 `test.todo`」改成
  「不许残留未实现的用例」，反而把一条精确的约束写模糊了；
- 或者人会去**改工具**（绕过检查），把一个真问题（规格里真留了 TBD）也一起放过去；
- 警告本身不阻断冻结，所以它只在**肉眼看输出**时起作用——但输出就在人眼前。

**修复方向**：判据不能是「文本里出现了 TODO 这个词」，而要是
「TODO 出现在**占位符该出现的位置**」——典型形态是：
- 独立成行、整行只有占位符（`TBD` / `TODO: 实现细节`）；
- 或者前面跟着「待定 / 待补 / 暂缺」这类**占位语义**的词。

反之，出现在**标识符或 API 名内部**（`test.todo`、`createTodo`、`TODO_LIST`）
或紧跟在反引号里的命令，不该算占位符。

**复现**：

```bash
node -e "const {analyzeSemantic}=require('./dist/core/spec/semantic/analyzer.js');
console.log(analyzeSemantic({}, '验收测试文件不许残留 \`test.todo\`。').issues)"
```

**修复**：已修（2026-11-21）。新增 `core/spec/semantic/placeholder.ts`，
把判据从「文本里出现了这个词」改成「这个词出现在**占位符该出现的位置**」：

| 形态 | 判定 |
|---|---|
| `test.todo` / `createTodo` / `TODO_LIST` | **不是**占位符（词是标识符的一部分） |
| 独立成行的 `TBD` / `TODO` | 是占位符 |
| `TODO: 还没想清楚` | 是占位符（标记 + 连接词 + 内容） |
| `not yet determined` / `coming soon` / `to be filled` | 是占位符（短语整体出现） |
| `待定：\`src/foo.cpp\`` | 是占位符（占位语义 + 具体东西） |
| 「这个值待定由上层决定」 | **不是**占位符（普通叙述，没有跟具体的东西） |

关键设计点：
- **标识符边界判定**：`isIdentifierPart()` 判断词前后的字符是不是
  `[A-Za-z0-9_.\-/]`。`test.todo` 的 `todo` 前面是 `.` → 是 API 名的一部分。
  注意 `:` **不在**这个集合里 —— 「`TODO: 说明`」是占位符的典型形态。
- **中文占位语义要跟具体的东西**：不能「后面有字就算」，
  否则「值待定由上层决定」这种普通叙述会全部误报。
  形态一：`待定：xxx`（连接词）；形态二：紧跟路径或反引号标识符。

**回归测试**：`tests/zd019-zd020-regression.test.ts` 的「ZD-019 占位符检查
不把 API 名当占位符」一组，9 个用例，含**负向用例**
（真留了 `TBD` / `TODO:` / `not yet determined` 仍要报）。

---

## ZD-020 写集全是 glob 时，规格里提到的裸文件名判成「未覆盖」，冻结被拦

**场景**：nimrtc-v14 的 `v1-audio-p2` 切片，写集是 glob：

```
src/modules/opus/**
src/modules/audio_rx/**
src/plugins/include/nimrtc/plugins/audio_decoder.hpp
src/engine/src/engine_media.cpp
...
```

规格里写了「模块内 `opus.cpp` 的 `depacketise()`…」这种**只写文件名**的表述
（很自然——同一个模块里的文件不值得每次都写全路径）。
`zelto freeze` 报错：

```
zelto freeze v1-audio-p2 — 规格与写集不一致，拒绝冻结
  - 规格提到「opus.cpp」，但它不在写集里 —— agent 改不了它
  - 规格提到「codec_plugin.cpp」，但它不在写集里 —— agent 改不了它
  - 规格提到「audio_decoder_plugin.cpp」，但它不在写集里 —— agent 改不了它
```

但 `opus.cpp` 明明在 `src/modules/opus/**` 里面。

**根因**：`core/spec/write-set.ts` 的 `isInWriteSet` 有两条路径：

```365:380:D:/MyOpen/Zelto/src/core/spec/write-set.ts
    if (pattern.includes('*') || pattern.includes('?')) {
      if (globToRegExp(pattern).test(normalized)) return true;
      continue;
    }
    const dir = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;

    // basename 匹配：规格只写文件名时也算覆盖
    const patternBase = pattern.slice(pattern.lastIndexOf('/') + 1);
    if (patternBase && patternBase === base) return true;
```

**basename 匹配（ZD-006 修的那条）只对非 glob 条目生效**。
glob 条目在 `continue` 处就跳过了——因为 glob 只能拿**完整路径**去匹配，
裸文件名 `opus.cpp` 跟 `src/modules/opus/**` 正则对不上。

于是出现一个**不对称**：写集条目写成 `src/modules/opus/src/opus.cpp`（非 glob）
→ basename 匹配生效 → 覆盖；写成 `src/modules/opus/**`（glob）
→ basename 匹配失效 → 不覆盖。

**后果**：同样是「写集覆盖了那个文件」，**写法不同结论相反**。
人被迫把写集从 glob 改成逐文件列举（丧失 glob 的简洁与完备性），
或者把规格里的裸文件名全改成全路径（规格变得难读）。

而这条闸门本身的意图是好的（D-4：「规格说要改 + 写集不允许改」
这个矛盾应该在冻结时暴露，而不是等 agent 撞上写集守卫）。

**修复方向**：glob 条目的 basename 匹配不能直接做（`src/**` 会匹配全仓库
任何叫 `opus.cpp` 的文件），但可以做**受限的**匹配：
glob 的**字面前缀** + 裸文件名的 basename 组合起来判定——
即「`src/modules/opus/**` 是否覆盖 `opus.cpp`」应理解为
「`src/modules/opus/` 目录下是否有叫 `opus.cpp` 的文件」。
这需要在判定时**读一下目录**（存在性检查），而不是纯字符串比较——
需要权衡它是否还满足 C3 的「纯计算、不触网」（读本地文件是可以的，
C3 禁的是调模型和触网）。

**复现**：

```js
const {isInWriteSet} = require('./dist/core/spec/write-set.js');
isInWriteSet('opus.cpp', ['src/modules/opus/**']);            // false ← 应该是 true
isInWriteSet('opus.cpp', ['src/modules/opus/src/opus.cpp']);  // true
```

**修复**：已修（2026-11-21）。`isInWriteSet` 增加第三条路径 ——
glob 条目 + **裸文件名**时，回到文件系统核实：

```
src/modules/opus/**  是否覆盖  opus.cpp
  ↓
glob 的字面前缀是 src/modules/opus/
  ↓
该目录下确实存在 opus.cpp，且其完整相对路径命中 glob？
  ↓ 是 → 覆盖
```

关键设计点：
- **只对裸文件名做这个回退**（不含 `/` 的写法）。带路径的写法走
  正则判定，语义精确，不需要读文件系统。
- **必须落到文件级别核实**，不能靠猜。
  `src/**` 若无脑 basename 匹配，会让全仓库任何叫 `opus.cpp` 的文件都算覆盖
  → D-4 漏报（该授权的文件被放过，agent 撞写集守卫时才炸）。
  漏报比误报更糟。
- **扫描有界**：只扫 glob 的字面前缀目录，跳过 `.git` / `node_modules` /
  `.zelto`，访问数封顶 5000。
- **C3 兼容**：读本地文件不算「触网」，也不调模型，判定仍是确定性的
  （同一份文件树 → 同一结论）。

**回归测试**：`tests/zd019-zd020-regression.test.ts` 的「ZD-020 glob 写集
覆盖裸文件名」一组，7 个用例，含**反向用例**：
glob 范围外的 `engine_media.cpp` / `CHANGELOG.md` 仍必须报未覆盖
（不能为了修误报而放松真判据）。

**遗留**：裸文件名在**多个** glob 目录里存在同名文件时的歧义 ——
当前判据是「任一命中即覆盖」，与逐文件列举写集时的 basename 匹配语义一致，
暂不区分。若将来出现同名文件分属不同模块且改动语义不同的情况，
需要再收紧为「唯一命中才算」。

---

## ZD-021 submodule 指针错位把合并拦下，而那次合并根本不碰那些路径

**场景**：nimrtc-v14 的 `v1-audio-p2` 切片签字通过后跑 `zelto merge v1-audio-p2`：

```
合并目标：version/v1（工作目录 .zelto\version-worktrees\v1）
  ⚠️  目标工作区有未提交改动，已跳过自动合并
     M src/third_party/googletest
     M src/third_party/libopus/src
     M src/third_party/libsamplerate/src
     M src/third_party/libsrtp/src
     M src/third_party/libyuv/src
     M src/third_party/msquic
     …（11 项）
Merge aborted — 目标工作区有未提交改动（11 项），已跳过合并.
```

那 11 条**不是人改的代码**。

**根因**：submodule 的**指针**与 index 记录不一致。

- index 里记的 gitlink 是 `22244de5`（`version/v1` 分支上的旧指针）；
- 而版本工作目录里那个 submodule **实际 checkout 的是** `acdb9e26`
  （主仓工作区当前在的那个 commit）。

来源是**主仓工作区里 submodule 被切过 commit**，worktree 建出来时继承了这个状态。
`alignSubmodulesToMainRepo` 本该把它对齐回 index 记录的指针，
但它的 `checkout --force` 失败了 —— 目标 commit 的对象**不在本地**
（`--no-fetch` 不触网，这是 C3 要求的正确行为）。

已有的 `isSubmoduleOnlyDirty` 只处理**一种**形态：
「指针没变、只是 submodule 内部有未提交改动」（`-dirty` 后缀，D-29 修的）。
本条是**另一种**形态：指针本身就不一样。守卫认不出来 → 判成「未提交改动」。

**后果**：

- 这次合并**根本不碰 `src/third_party`** ——
  `git diff version/v1 slice/v1-audio-p2` 里那些路径一个都没出现
  （待合分支只改了 `src/engine/src/`、`src/modules/opus/`、`src/modules/audio_rx/`、
  `src/plugins/include/`、`specs/`、`tests/acceptance/`）。
- 拦住它 = 「因为仓库里有一处与本次无关的不一致，把这次合并也拦下」。
  人被逼着去 `git commit` 或 `git stash` 那些 vendor 路径 ——
  而那要求把 submodule 指针**提交进版本分支**，等于把主仓工作区的
  临时状态固化成历史。

**修复**：已修（2026-11-21）。新增 `core/sched/audit.ts` 的
`isSubmodulePointerMismatch(repoRoot, path)`，判据两条：

1. 该路径在 index 里是 gitlink（mode `160000`）→ 确实是 submodule；
2. 工作区里那个 submodule 实际 checkout 的 commit 与 index 记录的不一致。

合并守卫新增一条通道 `submodulePointerMismatch`，输出为
「ℹ️ N 个 submodule 的指针与 index 记录不一致（与本次合并无关，不影响合并）」。

**方向**：只豁免「指针错位」这一种形态。
「人真的改了 submodule 指向的源码」不在此列 —— 那种情况 `git diff`
会报出具体文件，不是指针错位。「submodule 内部有未提交改动」仍由
`isSubmoduleOnlyDirty` 管。读不出来（git 调用失败）→ 保守判成「不是错位」
→ 维持拦截（误报比漏报便宜）。

**回归测试**：`tests/zd021-submodule-pointer-mismatch.test.ts`，4 个用例：
- 指针错位 → 判成「错位」（豁免）
- 指针一致 → 不判成错位（由 `-dirty` 通道管）
- 普通文件 → 不判成错位（真实改动必须拦）
- 不存在的路径 → 不判成错位

**修复后的验证**：`zelto merge v1-audio-p2` 成功 fast-forward 合入 `version/v1`，
输出 11 条「指针错位（不影响合并）」的提示，worktree 与切片分支被清理。

---

## ZD-022 `zelto set` 的数组字段只吃逗号分隔，喂 JSON 数组会**静默**写坏写集

**场景**：nimrtc-v14 的 `v1-device-policy` 切片要扩写集（补 `src/modules/video_capture/**`）。
我按直觉喂了 JSON 数组：

```
zelto set v1-device-policy --field writes --value '["src/modules/video_capture/**","src/modules/audio_device/**","src/engine/**"]'
```

命令**报告成功**（`✅ Updated writes`），但切片 JSON 里写进去的是：

```json
"writes": ["[src/modules/video_capture/**", "src/modules/audio_device/**", "src/engine/**]"]
```

第一个条目带着**左方括号** —— 它覆盖不到任何真实路径。
更糟的是这条垃圾条目**永远不会被发现**：写集判定里 glob 条目
（`src/modules/video_capture/**`）能覆盖一切，但 `[src/...` 这个条目本身
既覆盖不到东西、也不报错 —— 它只是**安静地烂在那里**。

**根因**：`cli/commands/slice-detail.ts` 的数组字段解析是：

```ts
const values = rawValue.split(',').map((v) => v.trim()).filter(Boolean);
```

只认逗号分隔。JSON 数组串走这条路 = 按逗号切完，**方括号原样留在首尾项里**。

**判据不一致才是根因**：同一条 `zelto set` 命令里的另一个数组字段
`spec.gateCommands` **早就是 JSON 格式**（ADR-051）—— 因为门禁命令里
经常有逗号和引号（`-DFOO=a,b`、`-G "Visual Studio 17 2022"`），逗号分隔切不准。

于是同一条命令、同类字段，**一个吃 JSON 一个不吃**，用户只能靠猜。
人猜错的那一次，zelto 不报错、不提示，直接把边界写坏。

**后果**：

- 写集里混进永不生效的条目 → 「写集覆盖了什么」这件事说不清；
- 门禁的写集判定会把垃圾条目算进写集 —— 越界豁免的判定基于它；
- **最坏的情况**：本该被拦住的越界写，因为垃圾条目让写集看起来更大而**被放过**。
  边界形同虚设，而全程**没有任何报错**。

**修复**：已修（2026-11-21）。`cli/commands/slice-detail.ts` 新增
`parseArrayField(rawValue, field)`，数组字段**两种格式都收**：

1. **JSON 数组**（首选）：`["src/a/**","src/b/**"]`；
2. **逗号分隔**（历史格式，保持可用）：`src/a/**,src/b/**`。

以 `[` 开头就当 JSON 解析，**解析失败直接报错** ——
不兜底回逗号分隔（兜底会把「JSON 写错了」变成「写集里多了几个奇怪条目」，
那是同一个病）。JSON 数组里混入非字符串元素也报错。

**为什么不能只留 JSON**：逗号分隔格式**已有大量既有用法**，直接砍掉是破坏性变更。
多认一种格式是零风险的。

**回归测试**：`tests/acceptance/cli-commands.test.ts`，5 个用例：
- JSON 数组格式被接受，且写集条目**无方括号残留**
- JSON 数组里混入非字符串 → 报错并说明「只能是字符串」
- 坏 JSON → 报错，且**写集保持为空**（不静默写坏）
- 逗号分隔格式仍然可用（向后兼容）
- `trace.requirements` 同样接受 JSON 数组

**剩余问题**：`zelto set` 的 `--help` 里没说明数组字段接受哪两种格式 ——
下一个人还是会猜。下一步要么在 `--help` 里写清，要么让 `set` 在检测到
「以 `[` 开头但解析失败」时给出「你是不是想写 JSON 数组」的提示。

---

## ZD-023 陈旧的全局拉闸请求会毒化后续切片，且只有 agent 跑完才被发现

**场景**：nimrtc-v14 的 `v1-device-policy` 切片跑完（2h45m）后，zelto 报：

```
⏸️  已拉闸：人工拉闸
   状态: running → frozen（stall: human_halt）
```

而这一轮**没有人喊停**。人从头到尾没碰过拉闸 —— 我在前一步误跑了一个
`zelto halt`，本意是看它输出什么，结果它把一个**全局暂停请求**写进了
`.zelto/halts/all.json`：

```json
{
  "id": "halt-1795220375428",
  "scope": "all",
  "requestedBy": "human",
  "reason": "人工拉闸",
  "requestedAt": "2026-11-21T00:19:35.428Z"
}
```

注意时间戳：`00:19:35`。而 agent 起跑是 `00:22:25` —— **这个暂停请求比 agent 早 3 分钟**。

**根因**：`HaltStore.isHalted(scope)` 的语义是「全局暂停（scope='all'）对所有批次生效」。
`zelto run` 的准入路径**完全不检查它** —— 起跑时没人问「现在是不是暂停着」。
于是：

1. agent 在 00:22 正常起跑，一路跑到 03:04；
2. 看门狗的 `setInterval` 每隔一会儿读一次 `isHalted`，**读到了那个 00:19 的陈旧请求**；
3. 看门狗把 agent 停掉，把这一轮记成「人工拉闸」，切片退 `frozen`。

**后果**：

- agent 干了两小时四十分钟的活，被一个**一小时四十五分钟前就该被清掉的暂停请求**打断；
- 打断点在 agent 快收尾时 —— 产物基本做完了，但「这一轮」不算数；
- 事件流里留下 `batch.halted { reason: "人工拉闸" }`，actor 是 `human` ——
  **追溯链上凭空多了一次人为干预**。而实际上人根本没干预过这一轮；
- 更要命的是「暂停状态」**不会被自动清除**。只要那个 `all.json` 还在，
  下一个切片同样会被打断 —— 一次误操作污染后面**所有**切片。

**为什么这条特别毒**：拉闸是**刹车**，语义是「人现在要接管」。
但刹车踩下之后没人松 —— 刹车就一直咬着。
`zelto halt` 的输出里其实写了解除方式（`zelto halt --clear`），
但那是给人看的；**机器路径上没有任何一处保证「暂停请求不会跨切片生效」**。

**修复**：已修（2026-11-21）。`cli/commands/core-slice.ts` 的 `run` 准入
在 `scheduler.startRun(id)` **之前**检查暂停状态：

```ts
const haltStore = new HaltStore(ZELTO_DIR);
const halted = await haltStore.isBlockingNewWork(id).catch(() => null);
if (halted) {
  // 拒绝起跑，说清怎么解除
  return 1;
}
```

**为什么是「拒绝」而不是「静默消费」**：静默消费等于替人解除了他自己踩下的刹车 ——
人喊停的意图是「现在我要接管」，不是「下一个切片也别跑」。
拒绝起跑并把解除方式说出来（`zelto halt --clear`），控制权回到人手里。

**为什么放在 `startRun` 之前**：放进 `startRun` 之后，切片会被推到 `running`
再退回来 —— 白走一趟状态机；更糟的是某个错误路径忘了退状态，
切片就卡在 `running` 且没人能救（D-64/D-65 同款病灶）。

**回归测试**：`tests/zd023-stale-halt-request.test.ts`，4 个用例：
- 全局暂停请求存在时 `zelto run` 拒绝起跑
- 拒绝时**不**推 `running` 状态（切片仍可再跑）
- 解除暂停后 `zelto run` 恢复可跑
- 切片作用域（scope=切片id）的暂停请求同样拦得住（不只是 `all`）

**补充修复（2026-11-21，同日）—— 暂停请求加 TTL（30 分钟）**：

上面这条修完之后，「踩下刹车忘了松」从「悄悄打断」变成了「明确拒绝」——
但仍然会挡路：人处理完现场忘了 `zelto halt --clear`，
后续**所有**切片都会被拒绝起跑。这不是「明确拒绝」该有的样子。

给 `HaltRequest` 加了 `expiresAt` 字段（`null` = 永不过期），
默认 TTL 30 分钟（`DEFAULT_HALT_TTL_MS`）：

```json
{
  "id": "halt-1795220375428",
  "scope": "all",
  "requestedBy": "human",
  "reason": "人工拉闸",
  "requestedAt": "2026-11-21T00:19:35.428Z",
  "expiresAt": "2026-11-21T00:49:35.428Z"
}
```

**关键设计：过期只影响「拦不拦新工作」，不影响「停不停在跑的活」**。

`HaltStore` 因此拆成两个判定：

| 方法 | 语义 | 过期后 |
|---|---|---|
| `isHalted(scope)` | 「在跑的活要不要停」 | **仍然停** —— 人喊停就是喊停 |
| `isBlockingNewWork(scope)` | 「新的活要不要开始」 | **放行** —— 刹车不该一直咬着 |

对应到三个调用点：

- **看门狗**（`core-slice.ts` 的 `waitForExitOrHalt`）→ 仍用 `isHalted`。
  人喊停是为了让现在跑的停下来，那份请求两小时后过期了，
  正在跑的 agent 也还是得停。
- **准入**（`zelto run` 起跑前、`parallel-executor` 的安全点①③、
  `supervisor` 的重试回路）→ 改用 `isBlockingNewWork`。
  这些都是「要不要开始新工作」，过期的请求不该再拦。

**为什么不静默删除过期请求**：静默消费等于替人解除了他自己踩下的刹车。
过期只是让它**不再拦路**，文件仍在盘上 —— 人随时可以 `--clear`，
也可以在 `zelto halt --list` 里看到它（会标注「已过期」）。

**旧格式文件的处理**：TTL 是后加的，之前写的请求文件里没有 `expiresAt` 字段。
如果把它们当成「永不过期」，那 ZD-023 里那份**真实的**陈旧请求就永远堵着后面的切片 ——
修了等于没修。所以 `get()` 会把**字段缺失**（`undefined`）与
**显式 `null`**（明确表示永不过期）区分开：
字段缺失 → 按 `requestedAt + 默认TTL` 回填；显式 `null` → 尊重人的意图。

**回归测试**：
- `tests/core/halt/store.test.ts` 新增 8 个用例（TTL 计算、显式永不过期、
  `isExpired` 边界、`isHalted` 不看过期、`isBlockingNewWork` 放行/拦截、
  旧格式回填、坏时间戳 fail closed）
- `tests/zd023-stale-halt-request.test.ts` 新增 3 个用例
  （新鲜的仍拦、过期的放行、过期的**仍在盘上**不被静默删除）

**剩余问题**（未做）：

1. 事件流里的 `batch.halted` 没区分「人真的喊停」与「读到陈旧请求」。
   修完准入 + TTL 后这条路径基本不会误触发了，但记下 `requestedAt` 与
   `runStartedAt` 仍能让事后追溯一眼看出差了多少。
2. TTL 是硬编码的 30 分钟，没有配置项，也没暴露到 `zelto config`。
   有人想「我这一轮暂停要留 2 小时」时只能用 `--ttl` 之类的入口 ——
   目前 `HaltStore.request()` 支持传 TTL 参数，但 CLI 没暴露。

---

## 记录格式约定

新增缺陷时按上方的「场景 / 根因 / 后果 / 修复 / 回归测试 / 剩余问题」六段写。不要只记「修了」—— 要说清楚**当时怎么踩到的**、**怎么复现**、**不修的话会在哪一步暴露**。

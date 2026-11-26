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

**已修（zelto 侧，v0.6.x）**：

1. **可中断点** —— `core/ports/executor.ts` 新增可选能力 `getLiveUsage(sessionId)`：
   - 与 `getUsage` 的区别是**什么时候**能拿到 —— `getUsage` 通常要等 agent **退出**
     （Claude Code 的 `--output-format json` 在最后才吐整段 JSON，中途没有）；
     `getLiveUsage` 是**运行中**就能报出当前累计花费。
   - 返回 `null` 的语义是「**测不到**」（不是「零」）—— 没数据不等于没花钱。

2. **纯判定层** —— 新增 `core/budget/runtime-guard.ts`：
   - `RuntimeBudgetGuard.check()` 返回**三态**：`ok` / `exceeded` / `unknown`。
     `unknown`（测不到）→ **不判定超支**，让 agent 继续跑。
     把「测不到」当成「没花钱」会让预算闸门变成一道**假闸门** —— 恰恰是本条要修的病。
   - 上限为「不限」（`budgetLimitUsd: 0` → `Infinity`）→ 闸门**不启用**（没有上限就没有闸门）。

3. **接线层** —— 三条运行路径都在等 agent 的间隙**定期查预算**，超了**当场叫停** agent：
   - 单片前台路径：`core-slice.ts` 的 `waitForExitWithWatchdog`
   - 单片后台监督路径：同一函数（同一个等法）
   - 并行路径：`parallel-executor.ts` 的 `waitForExitOrHalt`

   三处都用 `createRuntimeBudgetGuard` 造闸门：
   - 适配器没有 `getLiveUsage` → **拦不了** → 退回老口径；
   - 没有单价 → 折不出金额 → **拦不了**；
   - shell 适配器默认 `--output-format json` 中途拿不到 → `getLiveUsage` 返回 null → **拦不了**；
     配置 `agent.streamJson: true` 后改用 `--output-format stream-json`，运行中逐条
     解析 `assistant` 消息累加 token（见下方「阶段2」）。
   「拦不了」不等于「放行无阻」—— 起跑前那次检查与跑完后的复判仍在，
   但运行中**确实**没有第三道闸门 —— 这是事实，不该被含糊过去。

4. **收尾不许进门禁** —— 被预算闸门拦下的一轮，**不跑门禁**：
   闸门已经判「这一轮花超了」，再跑一遍门禁（编译 + 测试）是**继续烧机器**。
   而且病灶本身就是「产物做完了但超预算没进门禁，切片卡在 frozen」——
   让人来判，不是让门禁再跑一遍。
   处置统一：留痕（`run.aborted` + `stall.classified`）→ 退 `frozen` → **现场保留**。

4. **事前约束** —— `createExecutorAdapter` 把 `budgetLimitUsd` 接进 SDK 适配器的
   `maxBudgetUsd`（SDK 自己的**事前**约束，比事后查更硬）。

5. **金额折算** —— SDK 的 assistant 消息只给 **token**，不给金额（金额在 `result` 里才有，
   那是**最终**值）。适配器用配置里的 `llm.pricing` 按模型折算（`resolvePricePerKToken`）。
   找不到对应档 → **报不出金额**（宁可测不到，也不拿猜的价去判超支）。

6. **措辞** —— `budgetInterceptionMessage` 明说「这不是 agent 跑砸了，是闸门在运行中拦下的」，
   并提醒「产物可能已经写在 worktree 里，先看现场，别直接重跑」——
   病灶的另一半就是措辞：说成「跑砸了」，人就会重跑 → 再烧一遍钱。

7. **上限三处同源** —— `budgetLimitUsd` 有三个读者
   （`BudgetCollector.getLimit` / 配置解析器 / 运行中闸门），
   必须**同一口径**（`0` = 不限，默认 `1.0`）——
   漂移的后果是「起跑前按 $1 拦、运行中按 $100 拦」，人看到一个自相矛盾的账。

**回归测试**：`tests/zd007-runtime-budget-guard.test.ts`（25 例，分五层）
- 纯逻辑层：判定口径（三态、边界、不限、脏数据）
- 接线层：挂一个**永不自己退出**的假 adapter，验「超预算真的会停下来」
  （单片路径 + 并行路径各一）
- 适配器层：shell 适配器默认 json 模式 `getLiveUsage` 返回 null（fail-safe）；
  `streamJson` 模式能从 NDJSON 累加 token、按单价折成金额（含跨 chunk 拼行、最终金额优先）
- 配置层：三处读上限必须一致
- 单价层：拿别的模型的价去折算 = 错的判据 → 不猜

**阶段2（2026-11-23）：shell 适配器的运行中拦截**。原实现里 shell 适配器
（`npx claude-code`）根本报不出运行中用量 —— 它跑 `--output-format json`，
stdout 到最后才一次性到达。现在：
- 配置 `agent.streamJson: true` 时改用 `--output-format stream-json --verbose`
  （stream-json 强制要求 verbose，否则 Claude Code 直接报错退出）；
- 适配器逐行解析 NDJSON：`assistant` 消息累加 `message.usage` 的 token，
  `result` 消息记下最终 `total_cost_usd`（有精确金额时优先用它）；
- 配了 `llm.pricing` 就能把 token 折成金额 → `getLiveUsage` 在运行中报得出 →
  运行中预算拦截对 shell 适配器生效。
- **默认关**（零行为变化），且没有单价时仍报 null（不猜金额）。

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

**已修（zelto 侧）**：`worktree create` 之后自动同步子模块 —— 实现见 `core/worktree/manager.ts`
的 `syncSubmodules`（ADR-044）：

- **不触网**（C3）：克隆源指向主仓里已存在的 module git 目录
  （`<主仓>/<path>/.git` 是目录 → 用它自己；否则用 `<主仓>/.git/modules/<name>/`），
  本地 objects 复用。
- **不用 `--recursive`**：嵌套 submodule 由 `syncNestedSubmodules` 从主仓的
  module git 目录**本地克隆**（`--recursive` 会按 `.gitmodules` 里的 https URL 联网，
  实测挂起 5 分钟以上，见 D-66 的记录）。
- **同步失败必须留痕**（D-73）：`submoduleFailures` 记下「是哪个 vendor + 为什么」，
  否则「worktree 里少了 12 个 vendor」完全不显形，等到门禁报「找不到 googletest」
  时人看到的是源码缺失，跟「隔离目录没同步 vendor」毫无关系。
- **本地缺钉死的 commit → 当场抛错**（ADR-095 §3.1）：worktree 建出来是**坏的**，
  门禁②**必然**失败。让它在建 worktree 的时候失败（早几分钟、错误信息直达），
  比在门禁的时候失败（信息被几千行编译输出淹没）好得多。

**回归测试**：
- `tests/d73-submodule-offline-sync.test.ts` —— 离线同步 + 失败留痕
- `tests/adr095-submodule-missing-commit.test.ts` —— 本地缺 commit 时当场抛错
- `tests/zd021-submodule-pointer-mismatch.test.ts` —— 指针错位不误拦合并
- `tests/d72-worktree-submodule-cleanup.test.ts` —— 含 submodule 的 worktree 清理
- `tests/d52-submodule-dirty-merge.test.ts` —— dirty submodule 的合并

---

## ZD-009 门禁的 build 命令假设构建树已存在

**场景**：ZD-008 修好、构建树配好之后，第一次跑 `zelto gate` 又撞上一个：门禁的 build 命令是 `cmake --build build`，但 `build/` 从来不存在 —— **配置步骤没人做**。

**根因**：`config.yaml` 的 `gate.commands` 只有 build / test，没有 configure。C++ 项目「配一次、用很多次」，但 zelto 不知道这件事。

**后果**：同上 —— 门禁失败原因与被验代码无关。

**已修（zelto 侧）**：门禁命令支持 `phase` 字段，序列按「**配置 → 编译 → 测试**」排序：

- `core/gate/types.ts` 新增 `GatePhase = 'configure' | 'default' | 'build' | 'test'`、
  `GATE_PHASE_ORDER`、`gatePhaseOf`、`orderGateCommands`。
- `core/gate/executor.ts` 的 `GateExecutor.execute` 用 `orderGateCommands` 排序选中的命令。
- 配置里长这样：

  ```yaml
  gate:
    commands:
      - name: configure
        run: cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
        phase: configure
      - name: build
        run: cmake --build build --config Debug
        phase: build
      - name: test
        run: ctest --test-dir build -C Debug --output-on-failure
        phase: test
  ```

- **不写 `phase` 的命令归 `default`**，排在 configure 之后、build 之前 ——
  旧配置（只写 build / test）行为不变。

**回归测试**：`tests/zd009-gate-command-phases.test.ts`（11 例，含配置解析）

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

## ZD-024 glob 写集下，**新建文件**的裸文件名被误报成「不在写集里」，冻结被拦

**场景**：nimrtc-v14 的 `v2-ice` 切片（RFC 6544 ICE-over-TCP）冻结时：

```
zelto freeze v2-ice — 规格与写集不一致，拒绝冻结
  - 规格提到「tcp_socket.cpp」，但它不在写集里 —— agent 改不了它
  - 规格提到「tcp_framing.cpp」，但它不在写集里 —— agent 改不了它
  - 规格提到「tcp_ice.cpp」，但它不在写集里 —— agent 改不了它
```

那片的写集是：

```
src/modules/ice/**
src/modules/sdp/**
src/plugins/include/nimrtc/plugins/ice_transport.hpp
tests/acceptance/v2-ice/acceptance.test.cjs
```

规格里对应的表格长这样（**人怎么写规格**，不是规格写错了）：

```
| 文件 | 职责 |
|---|---|
| `src/modules/ice/src/tcp_socket.hpp` + `tcp_socket.cpp` | 跨平台 TCP socket |
| `src/modules/ice/src/tcp_framing.hpp` + `tcp_framing.cpp` | RFC 4571 帧编解码 |
| `src/modules/ice/src/tcp_ice.cpp` | RFC 6544 连接性检查 |
```

**根因**：ZD-020 修完「glob 写集 + 裸文件名」之后，留下了下一个盲区。

ZD-020 的判据是「glob 覆盖的目录里**确实存在**同名文件，且该文件的完整相对路径
命中 glob → 算覆盖」。这个判据要求文件**已经存在**。

而 `tcp_socket.cpp` / `tcp_framing.cpp` / `tcp_ice.cpp` 恰恰是**这一片要新建的**
—— 冻结发生在 agent 动手**之前**，它们此刻在盘上根本不存在。

于是：

1. 规格里写的是**裸文件名** `tcp_socket.cpp`（同行有带目录的 `tcp_socket.hpp`）；
2. 裸名 → 走 ZD-020 的「同名文件已存在」回退；
3. 文件不存在 → 查不到 → 判「未覆盖」→ 冻结被拦。

**规格完全没问题**：写集 `src/modules/ice/**` 明确授权了整棵树的写入，
`tcp_socket.cpp` 显然是 `tcp_socket.hpp` 的兄弟文件。

**后果**：这条闸门误报**系统性地**挡住所有「新建文件」的切片 ——
也就是**最需要写集授权**的那一类。

具体表现是：**规格写得越自然（新文件的头/实现成对写），越会被拦。**
而人被迫把规格改成全路径（「`src/modules/ice/src/tcp_socket.cpp`」）才能过 ——
规格变得难读，而且这已经是本条缺陷的**第二次**退让了（ZD-020 逼人把裸名改全路径）。

**修复**：已修（2026-11-21）。修在**规格解析层**（`core/spec/scope.ts` 的
`parseMentionedPaths`），不在写集判定层。

判据（四条都要满足，缺一不可）：

1. 该反引号段是**裸文件名**（不含 `/`）且扩展名已知；
2. **同一行内**、在它之前有一个反引号段，其路径**带目录**，
   且 **basename 去掉扩展名后与本段相同**（`x.hpp` ↔ `x.cpp`）；
3. 两个段的扩展名**不同**（同扩展名不是「头/实现」对）；
4. 补齐后的完整路径做归一化（去尾部标点、排除 URL / 绝对路径）。

补齐后的路径**取代**裸名（不是并存）—— 因为 `evaluateWriteSetCoverage`
要求 mentioned 里的**每一条**都被覆盖，裸名那条对新建文件必然不覆盖，
并存的话 uncovered 里仍会有那个裸名。

**为什么只认「同名不同扩展名」**：同行的 `a/b/x.hpp` ↔ `x.cpp` 是标准的
「头文件 + 实现文件」对，目录**必然相同** —— 这是确定的信息，不是猜。
而行内的 `a/b/x.hpp` ↔ `y.cpp` 里，`y.cpp` 是**另一个文件**，
它在哪个目录规格**没说** → 不补（补了就是猜 → 漏报）。

**为什么不在写集判定层用「同扩展名兄弟」放行（试过，否决）**：
裸文件名没有目录信息，「它是不是 glob 范围内某个文件的兄弟」只能靠猜，
而这个猜测**必然漏报**：

```
写集 `src/modules/ice/**`，规格提到 `engine_media.cpp`
→ glob 范围内有 `ice.cpp`（同扩展名）→ 猜「是兄弟」→ 放行
→ `src/engine/src/engine_media.cpp` **根本没被授权**，却没报
```

漏报比误报更糟（AGENTS.md：「闸门误报会把人引去改正确的规格」，
但漏报会让 agent 撞写集守卫时才炸）。解析层有**确切证据**，判定层只能靠猜。

**顺带修掉的一个隐蔽 bug**：补齐的 stem 比较最初写的是「整条路径的 stem」
（`src/modules/ice/src/tcp_socket` vs `tcp_socket`）—— 永远不相等，
补齐**从未生效**。这个 bug 被第一版的反向用例逮到：
「裸文件名借同行的头/实现对补齐目录」断言 `mentioned` 含
`src/modules/ice/src/tcp_socket.cpp`，实际拿到的是裸名。
改成比较 **basename 的 stem** 才生效。

**还修了行内扫描与反引号分支的重复抓取**：
行内裸路径正则会把反引号里的裸文件名**再抓一遍**
（`tcp_socket.cpp` 的前置字符是反引号，不在排除集里 → 命中），
于是「已补齐目录的名字」又以**裸名**形式回到列表里
→ 覆盖判据仍报「tcp_socket.cpp 不在写集里」。

修法：行内扫描**跳过反引号区间**。反引号里的内容已由反引号分支处理过
（含 ZD-024 的补齐），再扫一遍只会把它退回去。

注意这里必须**精确**：含空白的反引号段（`node --test tests/...` 这类**命令**，
ZD-006 修的）**不进入** `backtickSegments`，所以它们的区间不在跳过清单里 ——
行内扫描仍会抓到里面的路径片段。这是有意的，不能一刀切。

**回归测试**：`tests/zd024-bare-filename-dir-context.test.ts`，6 个用例：
- 裸文件名借同行的「头/实现」对补齐目录，且**裸名不再残留**
- D-4 覆盖判据不再误报（新建文件）
- 反向：不同名的裸文件名不借目录（那是另一个文件，规格没说它在哪）
- 反向：跨行的裸文件名不借目录
- 反向：glob 覆盖范围外的路径仍然报未覆盖（补齐不得越界）
- 反向：同一个裸名出现在两行、目录不同时，各自补到各自的目录
  （补齐结果按**段的起始位置**索引，不按文件名 —— 否则后一个会覆盖前一个）

**剩余问题**（未做）：

1. 补齐只认「同一行」。跨行写法（「头文件在上一行、实现文件在下一行」）
   仍然不补 —— 那是规格排版的问题，不补是安全的（走 ZD-020 的同名文件判定）。
2. 「同名不同扩展名」的判据目前是**扩展名不同**就行，
   不区分「头/实现」与「其它同名文件」。`x.hpp` ↔ `x.json` 也会被补齐。
   这在实践中不会出错（同名不同扩展名本来就大概率同目录），
   但严格说应该是「`.hpp` ↔ `.cpp`」这类**语义配对**。暂不收紧。

---

## ZD-031：需求条目被压成一行 —— 验收口径与测试形态全丢

### 场景

nimrtc v1.4 规格阶段（2026-11-21 ~ 11-22）共花 **23.93h**。
实测发现：**LLM 调用只占 2.2%（32 分钟）**，其余 97.8% 是人在改规格与改写集。

拆开看根因：`zelto spec draft` 送进模型的 prompt 实测只有 **470~705 token**，
而需求条目的正文被 `extractCriteria` **压成了一行**。

拿 N2 举例 —— 需求文档里它有 **16 行**不同描述，
旧口径只装下**其中 1 行**（主体描述）。丢掉的恰恰是：

- 「验收：两个只能通过 TCP 互通的 peer 选出 TCP 候选对，被选中对的 protocol 读作 "tcp"」
- 「测试形态：环回测试里让 UDP socket 绑到互相不可路由的地址，TCP 是唯一通路」
- 「N2-1：TCP 在 UDP 失败之后才尝试，不是和 UDP 赛跑」（子条目，整条没进）

**丢的正是规格里「可判定的验收标准」最该照抄的东西。**
模型看不到验收口径，就只能自己编一条更容易做的 —— 于是人又得回去改。

### 根因

`extractCriteria` 的口径是「同一条目多处出现 → 保留**最长**的那份」。
「最长」= 信息量最大 ≠ **信息最全** —— 一条需求的多个侧面
（主体 / 验收口径 / 测试形态 / 子条目）分处不同的行，
每行单独看都不够长，于是那些行全被丢弃。

子条目（`N2-1`）更彻底：它的 id 不在 `wanted` 里，压根不被收集。

### 后果

- 规格草稿的验收标准是**模型编的**，不是需求要求的；
- 人必须逐条把验收口径抄回规格 —— 这是几小时的活；
- 12 次 `spec.drafted` 里绝大多数是**同一个原因**的反复。

### 修复

**已修复（2026-11-23，ADR-099）**：

- `extractCriteria` 的返回值加 `aspects`（`string[]`）——
  装这条需求在文档里的**全部去重后的侧面**；
- 去重**只剥排版**（列表标记 / 勾选框 / markdown 强调 / 引号风格），
  **不动正文** —— 「N2：主体」与「N2 验收：口径」只差三个字，
  而那正是必须区分的信息；
- **子条目并入父需求**：`N2-1` 是 `N2` 的约束而非独立需求，
  必须跟着 `N2` 一起给模型看（它是一条「负向」纪律，
  模型看不到就一定会实现错）；
- **父需求没正文但有子条目时**，主体取第一个侧面 ——
  否则下游会报「找不到这一条的正文」，而明明有内容（假报也是误报）；
- `text` 字段保持向后兼容（仍是主体描述）。

实测：N2 从 **1 行 → 5 个侧面**（主体 + SDP writer + 验收口径 + 测试形态 + 子条目）。

### 回归测试

`tests/zd031-032-spec-drafting-context.test.ts`（8 个用例）

### 剩余问题

1. **需求文档本身的排版冗余**（101 条验收标准里大量重复）
   没有被清理 —— 清洗需求文档是**改人的出处**，不在工具的职责里。
2. **子条目也可能被直接关联**（`trace.requirements = ["N2-1"]`）——
   两种情况不冲突，但「既关联 N2 又关联 N2-1」时侧面会重复出现在
   两个需求下。下游按需求 id 逐条渲染，重复可接受。

---

## ZD-032：规格起草不读设计文档 —— 模块事实明明在仓库里

### 场景

`zelto spec draft` 给模型的 prompt 里**没有任何模块与文件路径的事实** ——
只有切片 id / 标题 / 模块名 / 写集 / 需求的一行正文。

而这些事实**已经在仓库里**：已确认的设计文档
（`.zelto/design/dsg-*.json`）里写着

```json
{ "name": "网络适配层 (ice)",
  "filePatterns": ["src/modules/ice/**"],
  "dependencies": ["core", "engine"] }
```

**规格起草这条路根本没去读它。**

### 根因

`buildSpecInput` 只组装了「切片自身的字段 + 需求正文」，
没有任何一步去读 `.zelto/design/`。

这不是漏了某个字段，是**整条上下文通路没接** ——
设计 → 切片规格这条链上，设计这一端是断的。

### 后果

模型只能凭空猜目录，或者写出一份空泛的骨架。
人要写出一份能判定的规格，得**从零查代码**。

### 修复

**已修复（2026-11-23，ADR-099）**：

新增 `src/llm/design-context.ts`，把已确认设计的模块事实喂进 prompt：

- **只取已确认的设计** —— draft 状态的设计是模型草稿，人没批准，
  拿它当事实就是把「模型的猜测」升级成「输入的真相」；
- **只取与本片相关的模块**（模块名匹配 / 路径与写集有交集 / **依赖闭包**）；
- 模块分两种**角色**：
  - `write` —— 本片所属模块（「归的路径」就是写集该落的位置）；
  - `readonly` —— 依赖闭包里的模块（本片要**对接 / 仿照**的对象）；
- **依赖闭包算传递依赖** —— 设计的依赖名可能指向中间模块
  （`ice → sdp → core`），只取一层的话 `core` 不会出现在只读参考里，
  而它恰恰是最常被参考的那个；
- **模块名匹配认括号里的短名** —— 设计的依赖名是短名（`core`），
  模块名是带括号的标题（`核心基础层 (core)`），两者字面不相等；
- **降级不阻断** —— 读不到设计就照旧走（信息少一点，不是不能干活）。

实测：prompt 从 **470~705 token** 涨到 **2000~2800 字符**，
且含真实模块路径与依赖。

### 回归测试

`tests/zd031-032-spec-drafting-context.test.ts`（9 个用例）

### 剩余问题

1. **「本片所属模块」靠版本计划里的模块名与设计里的模块名**字面**匹配** ——
   写法不一致时匹配不上（此时降级为「按写集交集相关」）。
   可以改成按路径前缀反查模块，但那是另一个改动。
2. **设计正文被裁剪过时**（不是设计模板格式），
   `deriveModules` 退回存的 `modules` 缓存 —— 那份缓存可能是旧口径。

---

## ZD-033：「不在写集里」只说「你有问题」，不给修法

### 场景

冻结被拦时，报错是：

```
规格提到「X」，但它不在写集里 —— agent 改不了它
```

人得自己判断 X 是「本片要改的」还是「只读参考的」——
而两条修法方向**完全相反**：

- 要改 → 加进写集（`zelto set <id> --field writes --value ...`）
- 只读参考 → 在规格里标成「只读 <路径>」

猜错就是再等几小时被门禁打回。

### 根因

报错只陈述了**事实**，没陈述**出路**。
ADR-098 实测：五片规格阶段 **97%** 的闸门失败是同一句 ——
同一句话被反复读，说明它没在帮人做决定。

### 后果

每一次这种往返都是**几小时**的人工时间（实测共 22.23h）。
这是 23.93h 里最大的一块。

### 修复

**已修复（2026-11-23，ADR-099）**：

改动在**编排层**（`core/lifecycle/freeze.ts`）而不是 CLI 侧 ——
CLI 与 Web 共用同一份判定（C3），两份说法不一致人更懵：

```
每个路径都要选一条出路（先想清楚它是「要改的」还是「只读参考的」）：
  ① 本片确实要改它 → 加进写集：zelto set <id> --field writes --value '["路径", …]'
  ② 只是拿来参考 / 仿照 → 在规格的「范围」章节写成「只读 <路径>」
两种改法方向相反，选错会被门禁打回 —— 判据：「这行代码本片会不会改？」
```

同时：

- 未覆盖路径若是**当前不存在**的文件，报错补一句
  「（该文件当前不存在，可能是本片要新建的）」——
  「新建」与「只读」是两种完全不同的意图，这个信息有用；
- **工具不自动改写集**（ADR-098 决策五）——
  写集是人批准的边界（C9），工具替人扩边界就是替人批准；
- CLI 侧**删掉**了重复的「写集」分支（原来说法只有「加进写集」一条，
  还把「只读」出路漏了）—— 一份说法；
- `--json` 输出加上 `advisories` 字段（Web 端要显示）。

### 回归测试

`tests/zd033-freeze-write-set-hints.test.ts`（2 个用例）

### 剩余问题

1. **「只读」前缀要人自己写** —— 工具不替人改规格（对的），
   但人得记住这个约定。ADR-098 的「只读前缀识别」已经能认它，
   前提是人写对了。
2. **报错只列了第一条路径进示例命令** —— 多路径时命令里是
   `["src/b.cpp", …]`，其余路径要人自己补。

---

## ZD-034：「只读 A 与 B」只豁免了 A —— 作用域只认「紧邻」

### 场景

ADR-098 决策一定了「只读」前缀要**条目级**生效，因为实测的 v2-ice 规格
把「写入 / 只读参考 / 新建文件」混在**同一个「范围」章节**里
（人写的规格不会守工具的章节约定）。

落地时实现了「只读标记**紧邻**路径」的判据
（`- 只读 \`src/x/ice.c\`` 能认），**实测有效** ——
v2-ice 那种「一行一个只读条目」的写法不再误报。

但 ADR-098 决策一的完整语义是「**这条前面有没有『只读』这两个字**」，
而「紧邻」判据漏掉了**一个条目里写了多个路径**的写法：

```markdown
- 只读 `src/third_party/libjuice/src/src/ice.c` 与 `docs/adr/ADR-028-….md` —— 参考
```

人写这句话时，`ice.c` 与 `ADR-028.md` **都是**只读参考。
但「紧邻」判据只认第一个 —— `ADR-028.md` 没被豁免
→ D-4 报「规格提到 docs/adr/ADR-028-….md，但它不在写集里」
→ 人回去改写集 → 一次几小时的往返。

**实测确认**（用 `parseReferencedPaths` 直接跑真实规格形态）：

```
「只读参考 `ice.c` 与 `ADR-028.md`」→ 只豁免了 ice.c
```

### 根因

「紧邻」是**实现手段**，不是**语义**。语义是「这个列表条目是只读的」。

把语义实现成「紧邻」，就必然漏掉「一个条目里多个路径」的写法 ——
而「一个条目列多个路径」恰恰是**表格化写法**里最自然的形态。

还有一个连带的坑：**参考章节里的源码不受条目级只读保护**。

章节规则只豁免**文档**（源码豁免 = D-4 漏报），
于是 `- 只读 \`src/x/ice.c\`` 写在「## 参考」章节里时，
**显式的只读标记反而不如章节默认管用** —— 语义倒挂。

### 后果

与 ZD-033 同类：**闸门误报**（规格完全没问题，被拦），
人回去改写集 → 几小时的往返（ADR-098 实测 22.23h 里的又一块）。

而且这次是**修一半**的状态：加了「只读」前缀的建议（ZD-033），
但前缀的作用域不完整 —— 人按提示写了「只读 A 与 B」，
B 仍然被报出来 → 人会以为「我明明标了只读」→ **更困惑**。

### 修复

**已修复（2026-11-24，ADR-098 决策一补完）**：

改动在 `src/core/spec/reference.ts`（判定层，C3 纯计算）：

1. **只读作用域** —— 只读标记在**同一个列表条目内**对后续路径持续生效。
   作用域的边界有三条：
   - **句号**（`。！？`）—— 新句子不再受前面那个「只读」管辖；
   - **反转措辞**（`但要改` / `要改` / `需要改` / `但` / `然而` …）——
     人明确反转了适用范围；
   - **下一个列表项** —— 条目之间不传染。

2. **条目级只读优先于章节规则** —— 参考章节里的
   `- 只读 \`src/x/ice.c\`` 也豁免源码
   （显式标记的语义比章节默认强）。

**为什么反转措辞必须有**（防漏报）：

```markdown
1. 只读 `src/b.cpp`，但要改 `src/c.cpp`。
```

没有反转判据时，「只读」作用域会一路延伸到句末 → `src/c.cpp` 被豁免
→ **D-4 漏报**（真正要改、却没被写集授权的文件被放过，
agent 撞写集守卫时才炸 —— 那是几小时的浪费，不是几分钟）。

**漏报比误报更糟**，所以宁可**多认反转**（多认 = 报出来让人补一句「只读」，
代价几分钟；少认 = 漏报，代价几小时）。

**为什么逗号不是边界**：逗号是**并列**连接符 ——
「只读 A，B」人写的时候两个都是只读。分号同理语义不定，
**不把分号当边界**（宁可漏认，让它走「紧邻」判据）。

### 回归测试

`tests/zd034-readonly-scope.test.ts`（13 项）—— 覆盖：
作用域延续（跨逗号 / 多路径）、边界（不跨句号 / 不跨反转措辞 / 不跨列表项 /
反转后重新生效）、章节优先级（条目级只读优先 / 无标记不豁免）、
与 D-4 覆盖判据合起来的效果。

### 剩余问题

1. **「只读」标记的措辞清单是枚举的** —— 「不得修改」「保持原样」等已覆盖，
   但人可能写「参考即可」「别动」这类没收录的说法。
   没收录 = 不豁免 = 报出来让人补（几分钟），方向是对的。
2. **作用域只到行尾** —— 跨行的列表项续行（长说明换行）里，
   只读标记不延续到下一行。真实规格里少见（人写列表项一般一行写完）。

---

## ZD-035：签字复查看不出「门禁跑的是不是本片」—— 收窄变成了只有工具知道的事

### 场景

ADR-097 让门禁能按写集**收窄**跑哪些用例（实测：`v2-ice` 从 2387 个用例
降到 ~200 个）。收窄这件事在**事件里留了痕**：

```
gate.result
  scoped: true
  scopeLabels: ["ice", "sdp"]
  scopeTestCount: 42
  scopeTotalTestCount: 2387
```

但**签字判据没认这些字段**。

`core/sign-review/evaluate.ts` 的第②项「验收真跑过本片」只看
`acceptanceRan` / `acceptancePassed` —— **看不出这轮跑的是不是本片相关的用例**。

于是收窄之后出现一种**看似合理、实则没闭环**的状态：

- 门禁按写集收窄，只跑了 42 个与本片相关的用例，全绿；
- 签字复查四项确认全过，显示「验收通过 42/42」；
- 但**没有任何一处证据说明「这 42 个就是本片该验的那些」**。

### 根因

这不是「判定错了」，是**判定对了但说不清**。

而且 ADR-097 决策里已经写清楚：**收窄的每一条路径都在门禁侧 fail closed 了**
（标签一个都没匹配到 → 门禁判失败，不是「跑 0 个用例判通过」，
ADR-096 实测 ctest 在没匹配到时退出码是 0，那是假绿）。

所以「门禁过了」这个结论**本身是成立的**。缺的是**证据的可见性**。

而「说不清」在签字这一环有**实际后果**：

| 现状 | 后果 |
|---|---|
| 人看到「验收通过 42/42」 | 以为跑了全量 2387 个里的 42 个 |
| 实际是 | 按写集匹配出的 42 个，而**匹配规则是人自己配的** |
| 规则配窄了 | 本片该验的用例没被验 → **静默漏验** |

**`gate.scope` 的规则是人在 `config.yaml` 里配的** ——
所以「规则配窄了 → 本片该验的用例没被验」是一个**真实存在的**失败模式，
而现在签字复查**没有任何一处能看出规则配得对不对**。

人签字时看不到收窄 = 人在**不知情**的情况下批准。

### 后果

追溯链在**签字这一环**断了。

zelto 的核心价值主张是「agent 的每一行代码都能追溯到一条人批准的规格」，
而「本片该验的用例真的被验了」是这条链上**签字前的最后一节**。

这一节本来有 ADR-097 的证据（事件里有留痕），但**签字侧没有接** ——
证据在，人看不见。

与 ZD-033 / ZD-034 同源：**闸门误报让人困惑**，
但这一条是**闸门没误报、却让人误以为** —— 「我以为验了全量」。

### 修复

**已修复（2026-11-24，ADR-104）**：

1. **事实层**（`core/sign-review/types.ts` + `collect.ts`）：
   `SignReviewFacts.gate` 增 `scope` 段，**只采事件里已有的字段**
   （ADR-097 决策五留的痕）—— **不改 schema、不加事件类型**。

   **老事件降级**：payload 没有作用域字段 → 按「没收窄」处理。
   **为什么这个降级是准确的**（而不是「查不到」）：
   老事件是**收窄功能上线之前**写的，那时的门禁**必然跑的是全量** ——
   全量永远覆盖本片，所以「没收窄」这个描述对老事件是**真的**。

2. **判定层**（`core/sign-review/evaluate.ts`）：
   第②项的**佐证文案**带上作用域。**判据本身不变**（仍是 `ran && passed`）。

   **为什么判据不变**：
   - 收窄的 fail closed **已经在门禁侧**承担了，签字侧再判一次是**重复**；
   - 判据加严会让**老事件**签名失败（老事件必然是全量跑的，没有作用域字段），
     而全量当然完整；
   - 这一项要做的是**让证据可见**，不是**更严** —— 人签字时需要的是**看得见**，
     不是又一道闸门。

3. **呈现层**（`core/sign-review/render.ts` + Web 前端）：
   「验收（门禁②）」段带上作用域说明：

   ```
   ✓ 42/42 passed · 跑的是本片验收文件 · 按写集收窄跑的（标签 ice、sdp） · 全量 2387 个里选了 42 个
   ```

   **为什么放在验收段而不是单独开一段**：签字复查的验收标准是
   「单屏铺开、不分页」（ADR-070 §5.3），多一行就可能超屏；
   而收窄信息紧邻结论处，人**不会漏看**。

   Web 前端直接渲染同一份 `checks[].evidence` → **内容同源**（ADR-104 决策六）。

4. **标签排序**：呈现前把标签**去重 + 排序** —— 规则顺序会变（人改配置），
   但**同一组标签两次签字必须显示成同一个字符串**，
   否则「事件里记的和这次显示的不一样」会让人以为出了 bug。

### 回归测试

`tests/adr104-sign-review-scope-evidence.test.ts`（22 项）——
覆盖：收集层（采字段 / 老事件降级 / 无事件不崩 / 回退路径也带作用域 / 标签去重排序）、
判定层（文案带作用域 / **判据不变的三条反例** / 老夹具不崩）、
措辞层（三种句式 / 不拼「全量 null 个」/ 无 scope 不崩）、
呈现层（验收段完整显示 / 80 与 100 列都完整 / 没收窄不提收窄 / 老夹具不崩）。

### 剩余问题

1. **「规则配得对不对」仍然靠人判断** —— 签字侧呈现了
   「全量 2387 个里选了 42 个」，但**没有**自动判「42 是不是太少」。
   比例大小与本片复杂度无关（有的片就只碰一个模块），
   固定阈值必然误报 —— **人看数字 + 人看规则**比阈值可靠（ADR-104 决策四）。
2. **「本片该验哪些用例」仍然是项目侧的知识** ——
   签字侧拿不到「本片该验什么」的集合，那要等项目侧显式声明
   「模块 → 用例」的映射（ZD-030 剩余问题①：nimrtc 侧还没给用例打标签）。
   在那之前，标签 + 计数 + 原因**已经足够**让人核对。

---

## ZD-036：`.cjs` 验收测试没收窄分支 —— 别的分支的验收契约被拉进本分支的 CI

### 场景

2026-11-24，`v1-version-align` 切片已签字并合并进 `version/v1` 分支
（**不是 main**）。它的验收文件 `tests/acceptance/v1-version-align/acceptance.test.cjs`
在 main 的工作区里是**未跟踪**状态。

跑 `pnpm test`，必红：

```
✖ package.json 的 version 字段为 0.7.1
  '0.6.0' !== '0.7.1'
✖ package-lock.json 根包版本与 package.json 一致
  ENOENT: no such file or directory, open 'D:\MyOpen\Zelto\package-lock.json'
```

**红的原因不是代码坏了** —— 那个切片在自己的版本工作区里
（`.zelto/version-worktrees/v1`）是 6/6 全绿的。红的原因是
**收窄错了范围**：CI 报的是一条**在当前分支上根本不存在**的契约。

### 根因

`scripts/test.mjs` 的 `collectCjsAcceptanceTests()` 扫 `tests/acceptance/**`
下**工作区里所有** `.test.cjs`，不管它属不属于当前分支。

（`.cjs` 不在 `tsconfig.test.json` 的 include 里，所以它们不在 `dist-test/`，
必须原地收集 —— 这部分是对的。问题只在**范围**。）

而「工作区里有」不等于「这个仓库的契约里有」：

- 已合并进 `version/v1` 的切片产物，在 main 的工作区里是未跟踪的；
- main 是 `0.6.0`、用 pnpm、没有 `package-lock.json`；
- 于是那条「断言 `0.7.1` + `package-lock.json` 存在」的验收**在 main 上
  永远不可能成立**。

### 后果

`pnpm test` 在 main 上**必红**，而红的是一个**不存在的契约** ——
CI 报的东西跟 main 的真实状态无关。

更糟的是：**它会掩盖真正的红**。人看到一屏红，会去查「版本号为什么不对」，
而实际上 main 的 `0.6.0` 完全正确。

### 修复

判据：**验收测试没进仓库，就不属于这个仓库的契约。**
所以只收 `git ls-files` 认得的那些 —— 它们随分支走，在哪个分支就在
那个分支的契约里。

拿不到 git（比如从 npm tarball 里跑）时**退回全收**：那时没有分支概念，
「工作区里有什么就验什么」是对的。

实测：main 上收集到 **14 个**（与 `git ls-files` 一致），
两个未跟踪的切片验收（`v1-version-align` / `v1-acceptance-triage`）被排除，
另两个 draft 骨架（`v2-adr-trace` / `v2-tag-namespace`）同样被排除。

### 回归测试

`scripts/test.mjs` 是脚本不是 `src/`，靠**全量测试本身**验证：
`pnpm test` 绿 = 收窄生效。

### 剩余问题

1. **未跟踪的验收文件仍然是「看不见的契约」** ——
   收窄让 CI 不再误报，但人如果想让某个验收在 main 上跑，
   仍然必须**先把它提交进仓库**。这个约束现在是隐式的，
   值得在 `zelto spec draft` 的提示里讲明白。
2. **`.ts` 写的验收测试不受影响** —— 它们走 `tsc` 编译进 `dist-test/`，
   编译产物天然只包含工作区里**有源文件**的那些。
   也就是说两条路径的收窄口径一致，但实现方式不同。

---

## ZD-037：agent 生成的 `package-lock.json` 是**假锁文件** —— pnpm 路径污染 + 零 integrity

### 场景

`v1-version-align` 切片（规格：把 `package.json` 与 `package-lock.json`
的版本号对齐为 `0.7.1`，并新增 `scripts/version-check.mjs` 校验一致性）
已签字并合并进 `version/v1`。它在版本工作区里 6/6 全绿 ——
**但它交付的锁文件本身是坏的**。

### 根因

**这个仓库是 pnpm 仓库**：

- `package.json` 的 `packageManager: "pnpm@9.12.0"`；
- CI（`ci.yml` / `release.yml`）全部用 `pnpm install --frozen-lockfile`；
- 工作区的 `node_modules/.pnpm/` 存在，`node_modules/.modules.yaml` 存在；
- 仓库里的真锁文件是 `pnpm-lock.yaml`，**从没有过 `package-lock.json`**。

切片规格（人批准的）要求改 `package-lock.json`。agent 为了交差，
用 `npm install --package-lock-only` 之类的方式**造**了一个 ——
但它是从 **pnpm 的本地 store** 生成的，于是 14 个条目里有 **7 个**
的 `resolved` 指向 pnpm 的虚拟 store 路径：

```json
"resolved": "../../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.306_.../node_modules/@anthropic-ai/claude-agent-sdk"
```

而且**整份文件没有一个 `integrity` 哈希**。

这不是「格式不对」，是**这份文件根本不是 npm 锁文件** ——
`npm ci` 在别的机器上跑必然失败（`resolved` 指向不存在的相对路径、
没有校验和可验）。

### 后果

1. **规格要求的产物是假的** —— 验收标准第 2 条只校验
   「根包版本 == `0.7.1`」，这个断言**通过了**，但它验证的是一个
   `npm ci` 用不了的文件。**验收标准只覆盖了「字段对」，没覆盖「文件能用」**。
2. **`prepublishOnly` 被改成了只跑版本校验** ——

   ```diff
   -"prepublishOnly": "pnpm clean && pnpm build && pnpm test"
   +"prepublishOnly": "node scripts/version-check.mjs"
   ```

   于是 `npm publish` 前**不再构建、不再跑测试**。原先那条钩子
   （`pnpm clean && pnpm build && pnpm test`）是发布前的最后一道闸，
   现在被换成了一个只查版本号的脚本 —— **闸门被悄悄换小了**。
   而且 `npm publish` 会跑 `prepublishOnly`，这条改动**真的会生效**。
3. **两套锁文件并存** —— `version/v1` 上同时有 `pnpm-lock.yaml`（真的）
   和 `package-lock.json`（假的）。CI 用前者，本地有人用后者。

### 修复

**已修**（2026-11-25，人已批准）—— 见 `docs/adr-108-version-check-pnpm-lockfile.md`
与 `specs/slices/v1-version-align.md` 的「修订记录」。
提交：`version/v1` 的 `2e064a7`。

三个选项的取舍：**取 A 的方向（校验 pnpm 锁文件）+ C 的保留（脚本留着）**，
**同时恢复**被降级的闸门。

**B 方案（用真 npm 锁文件）被否决** —— 等于在 pnpm 仓库里长期维护两套锁文件。
两套锁文件会漂，而「版本一致性校验脚本」的存在意义就是防漂；
用一个需要防漂的机制去引入新的漂移源，方向是反的。
（且 npm 锁文件不含 pnpm 的 peer dependency 解析结果，
`pnpm install --frozen-lockfile` 与 `npm ci` 会装出**不同的依赖树**。）

**关键实测（推翻了原先的假设）**：
「A 方案只要把文件名换成 `pnpm-lock.yaml` 就行」——**不成立**。
实测 `pnpm install --lockfile-only` 生成一份 `lockfileVersion: '9.0'` 的锁文件：

```yaml
importers:
  .:
    dependencies:
      js-yaml:
        specifier: ^5.5.0
        version: 5.5.0
```

`importers` 段里**只有依赖的 specifier 与解析后的版本，没有根包版本字段**。
所以「根包版本一致性」这条断言在 pnpm 锁文件上**没有对应物** ——
必须**重写断言**，而不是换个文件名。

新的判据（比原来那条更强）：`package.json` 的依赖声明 ↔
`pnpm-lock.yaml` 的 `importers['.']` **逐条一致** ——
存在性 + `specifier` 逐字相同 + 反向漂移（锁文件里多出来的也要报）。
而且它比 `pnpm install --frozen-lockfile` **更早**发现漂移：
后者是安装时才发现（那时已经装了半个依赖树），本脚本是发布前、
装任何东西之前。

实际改了什么：

1. **删掉假的 `package-lock.json`** —— `pnpm install --frozen-lockfile` 通过
   （这是对「真锁文件是完整的」的独立验证）。
2. **加反向断言** —— `package-lock.json` / `npm-shrinkwrap.json` 存在即失败。
   **只写正向断言，下一个 agent 还能再造一个。**
3. **`prepublishOnly` 恢复**成
   `pnpm clean && pnpm build && pnpm test && node scripts/version-check.mjs`。
   闸门只能加，不能换小。版本校验放**最后** —— 这样失败时其它检查都已经过了，
   人看到的是「前面都绿了，卡在版本一致性」。
4. **版本校验脚本改用动态 `import()` 加载 `js-yaml`** ——
   装不上时输出可读错误（「跑一次 pnpm install 再试」），
   而不是抛 Node 的 `ERR_MODULE_NOT_FOUND` 堆栈。
   **它自己就是「发布前把话说清楚」的脚本，不能自己先崩在堆栈里。**
5. 验收标准从 6 条扩到 **9 条**（含反向断言、闸门完整性、README 一致性）。

### 回归测试

已加（`tests/acceptance/v1-version-align/acceptance.test.cjs`，8/8 绿）：

- **反向断言**：`package-lock.json` / `npm-shrinkwrap.json` **不存在**，
  而 `pnpm-lock.yaml` 必须存在；
- **闸门完整性**：`prepublishOnly` 逐字等于
  `pnpm clean && pnpm build && pnpm test && node scripts/version-check.mjs`，
  并额外断言三步一步不少、`version-check.mjs` 排在 `pnpm test` **之后**；
- **漂移检测**：版本范围变了 / 多出一条依赖 → 非零退出且报错点明依赖名；
- **沙箱里出现 npm 锁文件** → 非零退出。

### 连带发现：第三个病灶（修 README 时才暴露）

修 ZD-037 时发现 `version/v1` 上还有**第三个**同源缺陷 ——
**版本号提到 `0.7.1`，但中英文 README 都还写 `v0.6.0`**，
`tests/package-availability.test.ts` 因此红（4 条）。

而 `release-status.json` 的 `published: true` + `npmVersion: 0.6.0`
说的也是**另一个版本**的事 —— `0.7.1` 根本没发到 npm（`npm view zelto versions`
只有 `0.6.0`）。这是 ADR-085 那个坑的**同一个形状**：
**声明与现实不一致，而文档是错的那个。**

已一并修：中英文 README 同步到 `v0.7.1` 并改发布措辞、
`release-status.json` 改 `published: false`、CHANGELOG 补 `0.7.1` 条目。
`package-availability` 现在 **9/9 绿**（此前 4 红）。

### 剩余问题

1. **验收标准只覆盖「字段对」不覆盖「文件能用」** ——
   这是更一般的缺陷：写「校验 X 一致」这类验收标准时，
   很容易只断言字段相等，却没断言**这个东西真的能被用**。
   本例中 `package-lock.json` 的字段全对，但文件是废的。
   **本次修订的应对是把「文件能用」写成显式的反向断言。**
2. **没人核对「这个仓库用哪个包管理器」** ——
   规格直接写死了 `package-lock.json`，而仓库是 pnpm 的。
   切片规格生成时**应该能看到** `packageManager` 字段与
   `pnpm-lock.yaml` 的存在 —— 那是判断依据，就在仓库根。
3. **验收通过 ≠ 产物可用**（这条是本条与 §ZD-036 的共同教训）——
   §ZD-036 是「测试范围没收窄，跑到了别人的契约」，
   ZD-037 是「断言只查字段，没查文件能不能用」。
   两者都指向同一个根源：
   **验收标准只断言了「看起来对的东西」，没断言「东西真的能用」。**
   修 ZD-037 时新增的**反向断言**（假锁文件存在即失败）
   是对这条教训的直接落地。

---

## ZD-038：tag 命名空间把「当前版本」和「历史版本」混在一处 —— 升版当天发布闸门自锁

### 场景

2026-11-25 迁移存量裸 tag（`v1` / `v2` / `v3` → `plan-<semver>/v<n>`）
时，逐条核对 git 事实，发现**四个**真缺陷。
不是「迁移做得不干净」—— 是**规则本身有洞**。

### 根因

`v2-tag-namespace` 切片定下的规则是：

```
plan-<semver>/v<n>     <semver> 必须 == package.json 的 version
```

**`<semver>` 在 tag 里表达的是「这一版属于哪个发布批次」，
而 `package.json` 的 `version` 表达的是「**现在**要发的是哪一版」。**
两者必然在某一刻分叉。

### 后果

**① 升版当天，历史 tag 全部变非法，发布闸门自锁。**

实测（2026-11-25，`package.json` = `0.7.1`）：

```
node scripts/tag-namespace.mjs plan-0.7.1/v3   → 合法
node scripts/tag-namespace.mjs plan-0.7.0/v1   → 退出码 1
    [版本号不一致] plan-0.7.0/v1 的 <semver> 是 0.7.0，package.json 当前版本是 0.7.1
```

而 `scripts/build.mjs` 的发布预检第一段**无参**调用它：

```js
const RELEASE_STAGES = [
  { key: 'tag-namespace', label: 'Git Tag 命名空间治理', script: 'scripts/tag-namespace.mjs' },
  // ...
];
// runStage() → spawnSync(process.execPath, [scriptPath])   ← 不传参
```

无参运行 → 读 `git tag` **全量** → `package.json` 一升版，
**历史上完全正常的 tag 会让 `build.mjs --release` 失败**。

**下一次发版必踩**（当前 `package.json` = `0.7.1`，
仓库已有 `plan-0.7.1/v2`、`plan-0.7.1/v3`）。

**② 多个计划各有自己的 v1，同一个 `<semver>/v<n>` 装不下 —— 名字被抢占。**

实测：三个计划各自都有 v1（`plan-1794562105642` / `plan-1795422836717` /
`plan-1795507341754`），都想叫 `plan-0.7.1/v1` —— **只有一个能叫**。

已造成实际后果：裸 tag `v1` 改名成 `plan-0.7.1/v1` 后指向 `532f942`
（sign-review 计划的 v1）。实测 `532f942` **不含** 0.7.0 计划 v1 的四个合并点
（`21a89d9` / `8e2d9b6` / `afa0057` / `e4034af` 全部 `is-ancestor` 为假）。

> **精确表述（避免夸大）**：0.7.0 计划 v1 的四个合并点**都在 main 上**，
> 且都是 `plan-0.7.1/v2` 的祖先 —— **内容没丢**。
> 但**没有任何一个 tag 把它们当作自己的指向** ——
> 「0.7.0 计划 v1」这个版本**从来没有自己的锚点**。
> **内容在 ≠ 锚点在。**

**③ `ship` 默认打出的 tag 是非法 tag —— 工具自己造自己的非法。**

```ts
// src/core/version/branch.ts
export function versionTagName(label: string): string {
  ...
  return sanitized || 'unnamed';       // label 是 "v1" 就返回 "v1"
}
// src/cli/commands/version-ship.ts
const tag = version.tag ?? versionTagName(versionLabel);   // ← 缺省 → 裸 tag
```

实测：`plan-1795422836717` 的 v1/v2/v3 里 `tag` 字段是 `v1`/`v2`/`v3`，
`plan-1794562105642` 的 v1 是 `v1` —— 计划里存的**就是**非法名。
而 `plan-1795507341754` 的 v1/v2 **没填** `tag`，
一旦 ship 就会打出裸 `v1`/`v2` —— **当场违反自己刚定的规则**。

**④ CI 读不到「哪个 tag 属于哪个计划」。**

版本计划在 `.zelto/versions/*.json`，而 `.zelto/` 在 `.gitignore` 里
（实测 `git ls-files .zelto` → **0 个文件**）。
实测：95 个被跟踪的规格文件里**没有一个**带 `version:` frontmatter
（`readVersionFromSpec()` 那条路对现有规格**完全失效**）；
计划 id 在被跟踪文件里只出现 2 次，且都在 `docs/` 和 `policy/` 里，
不是结构化数据。

### 修复

**ADR-110**（`docs/adr/adr-110-version-tag-plan-scoped-namespace.md`）：
tag 命名空间改为**按计划寻址** —— `plan-<planId>/v<n>`，
`<semver>` 从 tag 里**移出去**（它本来就不该在 tag 里）。

一次解决四个缺陷：

| 缺陷 | 新规则下 |
|-----|---------|
| ① 版本漂移致历史 tag 失效 | tag 里没有版本号，**与 `package.json` 无关**，永不失效 |
| ② 多计划抢占同名 | planId 唯一，**每个计划的每个版本都有唯一名字** |
| ③ ship 打出非法 tag | 派生成 `plan-<planId>/v<n>`，**天然合法** |
| ④ CI 读不到 plan↔tag 关系 | planId 在 tag 里，**CI 直接从 tag 名读出计划** |

配套：版本一致性判定移到 `scripts/version-check.mjs`（发布锚点才管版本一致）；
`build.mjs --release` 的 tag 段**带参**（不再全量扫描）；
版本计划**双写**到被跟踪的 `versions/<planId>.json`；
`tag-map.json` 升级为带 `commit` 的台账并**核对 git 事实**。

### 回归测试

`tests/tag-namespace-adr110.test.ts`（新增，ADR-110 验收标准 11 条）。

### 剩余问题

1. **本条只立了 ADR，实施是下一个切片的事** ——
   规则改了但代码没改，`scripts/tag-namespace.mjs` 仍按旧规则判。
   存量裸 tag 已在 2026-11-25 清掉（`node scripts/tag-namespace.mjs` 退出码 0），
   但那是在**旧规则**下合法。
2. **`plan-1794562105642/v1` 指向 `532f942`，它不在 main 上** ——
   sign-review 的**代码内容**都在 main 上（以 `fa8e34e` 等重新提交进入，
   ADR-104 又改进过），丢的只是原始提交历史。
   按人批决定**保留**（宁可让 tag 装历史计划的内容，也不毁掉一个计划的锚点）。
3. **迁移台账仍按「旧名 → 新名」记，不保证内容相同** ——
   ADR-110 决策七要求加 `commit` 字段并核对 git 事实，
   但那只在**实施**之后生效。

---

## ZD-026 新建 worktree 时，**生成的产物**不会跟过去 —— 门禁②在构建阶段炸，而罪魁在 setup 阶段

**场景**：nimrtc-v14 的 `v3-n4-d6-connectivity` 切片，agent 跑完了（101 分钟），
自动门禁②**红了**：

```
❌ build (10700ms, exit 1)
  'vswhere.exe' 不是内部或外部命令
❌ test (231929ms, exit 8)
  Errors while running CTest
Gate: ❌ Failed (518069ms)
```

`vswhere.exe` 那行是**噪声** —— v2-ice 那轮门禁也有同样的 stderr，
但 `exit 0` 通过了（说明 VS 环境本身是好的）。真正的错误被埋在后面几百行里：

```
error MSB3073: "cmake.exe" -E copy_if_different
  .../src/third_party/wolfssl/src/certs/ecc-key.pem
  .../build/tests/Debug/certs/
Error copying file (if different) from ".../certs/ecc-key.pem"
```

**根因**：`ecc-key.pem` 是**生成的**，不是签入的。

```
$ cd src/third_party/wolfssl/src
$ git check-ignore -v certs/ecc-key.pem
.gitignore:109:ecc-key.pem   certs/ecc-key.pem
```

wolfssl 的 `.gitignore` 第 109 行明确忽略它。它由
`scripts/build_dtls_cert.py` 生成（那个脚本把自签的 ECC 证书同时镜像到
wolfssl 自己的 cert 树里，好让 CMake 的 `copy_if_different` 规则能捡到）。

而 CMake 的 `nimrtc_copy_wolfssl_certs()`（`cmake/NimRTCTest.cmake`）
**无条件** `copy_if_different` 这两个文件 —— 源文件不在，POST_BUILD 就炸，
连带整个测试目标构建失败。

**为什么主仓没事、worktree 有事**：主仓的 `src/third_party/wolfssl/src/certs/`
里**有** `ecc-key.pem` —— 一个**未被跟踪的**文件。新建 worktree 时
git 只带**被跟踪**的内容，这个文件不带过去。

于是主仓能构建、任何新 worktree 不能 —— **差异不在代码，在工作区的历史**。

> **更正（2026-11-22 二次实测）**：本节最初断言主仓那份
> `ecc-key.pem` 是「跑过一次 `build_dtls_cert.py` 留下的残留」。**这是错的**。
>
> 判据是**格式** —— 脚本写的是 PKCS8（`BEGIN PRIVATE KEY`），
> 主仓那份是 `ASN1 OID: prime256v1` + `BEGIN EC PRIVATE KEY`，
> 是 **wolfSSL 自己的 keygen 工具**的输出。
> 同样地，主仓的 `server-ecc.pem` 是 `CN=www.wolfssl.com`、**无 SAN**
> 的 **wolfSSL 上游自带**证书（它在 wolfssl 子模块里被 git 跟踪）。
>
> 所以真实情况是：**主仓从来没成功跑过那个脚本**。主仓能构建，
> 靠的是上游自带的那份证书 —— 而它**构建期不需要**（证书只在
> Chrome 互操作的**运行期**才被用到）。
>
> 这不改变本条的结论，但改变了「怎么修」的说法：不是「把主仓那份拷过去就行」
> （那份连 SAN 都没有，拷过去也过不了 Chrome 的 DTLS 握手），
> 而是**必须重新生成**。这正是下面选「生成」而非「拷贝」的理由之一。

> **再更正（2026-11-22 三次实测）：主仓为什么也构建失败？**
>
> 上面的更正解释了「主仓那份证书不是脚本产的」，但没解释
> **为什么主仓自己构建也会炸**。答案查到了，而且要往上游追一层：
>
> ```
> 上游 wolfSSL v5.9.2-stable (commit ac01707)  certs/ 有 161 项，含 ecc-key.pem  ← CI 用这份
> 本地主仓的子模块           (commit da2d676)  certs/ 有 159 项，缺 ecc-key.pem  ← "carbon copy"
> 差集正好两个：certs/ecc-key.pem、certs/ecc-key.der
> ```
>
> CI 日志（run `44688171635`）里明明白白：
>
> ```
> Submodule path 'src/third_party/wolfssl/src': checked out 'ac01707552c611fbd135cc723b2682b3e7f80f2'
> ```
>
> CI 拿到的就是上游那份，带着 `certs/ecc-key.pem`，
> POST_BUILD 拷贝成功，2310 个测试全绿。
> 而**本地主仓的 wolfSSL 是一份「carbon copy」**（提交信息原话），
> 相对上游**少了两个证书文件** —— 所以本地拷贝 `ecc-key.pem` 必然失败。
>
> 所以本条的真实根因链是：
> **本地 vendored 副本与上游不一致 → 缺 `ecc-key.pem` → POST_BUILD 无条件拷贝 → 构建炸。**
>
> **这条怎么改变了「怎么修」：**
> 修复点不在「把缺失的证书补回去」—— 补回去只能补一份**上游的无 SAN 旧证书**，
> 运行期要的是带 SAN 的新证书；
> 修复点在「让构建期产物由项目自己的脚本生成，且不落在别人的仓库里」。
>
> 顺带查出另一条：**「生成物写进 vendored 子模块的跟踪文件」这个做法本身要淘汰。**
> `server-ecc.pem` 在子模块里是**被跟踪**的，脚本覆盖它会让子模块长期显示 `-dirty`。
> nimrtc 侧已改：脚本只写 `tests/wolfssl_dtls/certs/`（该目录被 `.gitignore:227` 忽略），
> CMake 从那里取，CI 显式加一步生成证书（6 个 workflow / 14 个 job）。
>
> 详见 **ADR-095 §2.4.3 / §7.3–§7.6**。


**为什么这是个真缺陷（而不只是「环境没配好」）**：

1. worktree 是 zelto **自己**造的（`core/worktree/`），不是人手工建的。
   zelto 造出来的 worktree 应当是**可构建的** —— 否则门禁②必然红，
   而红的理由跟切片内容毫无关系。
2. 门禁②的失败信息**指向了错的地方**。人看到「build 失败」，
   第一反应是「agent 把代码写坏了」—— 但 agent 一个字节都没碰证书。
3. 更糟的是：门禁②红了之后，agent 已经烧掉的 101 分钟无法复用，
   而**人无法从门禁输出里推出真正的原因**（`MSB3073` 那一坨
   `if %errorlevel% neq 0 goto :cmEnd` 没有任何可读信息）。

**还有一条同源的**：`version/v3` 的树钉住了较老的子模块 commit
（googletest `15460959`、libopus `22244de5`），而本地 module 仓库里
只有较新的「carbon copy」commit。zelto 的 `alignSubmodulesToMainRepo`
按 C3（确定性、不触网）用 `git checkout --force <pin> --no-fetch` ——
pinned commit 在本地**不存在**时**静默失败**，worktree 的子模块目录于是
**是空的**。

现象几乎一样（构建缺东西），但成因不同、修法也不同。

**修复**：已修（2026-11-22），见 **ADR-095**
（`docs/adr-095-worktree-build-prerequisites.md`）。分两处：

**其一（子模块）：钉死的 commit 本地不存在 → 明确报错，不静默**

判据是 `git cat-file -e <sha>` —— 只读本地对象库，不触网（C3），
且是确定性的。

关键点：**这个检查必须放在 `submodule update` 之前**。
原来的失败发生在 update 阶段（被记成一条警告），
而 `alignSubmodulesToMainRepo` 在 update **之后** —— update 失败，
align 根本没机会跑。所以「commit 存在性」的判据必须前置。

另外还有一个坑：`git submodule add` 只把 gitlink **暂存**进 index，
**不提交**。而 worktree 是从 **HEAD** 建出来的 ——
worktree 的 index 里于是**没有**那个 gitlink。
所以「钉死的 commit」要从**主仓的 index** 读，不是 worktree 的。
（这个坑是写集成测试时才发现的：判据写对了但永远读到空。）

报错信息带**三种可执行的修法**（成因不同，修法不同）：

```
本地 module git 目录里没有 index 记录的 commit 15460959（submodule: src/third_party/googletest/src）

这个 worktree 的 vendor 目录会是空的 —— 门禁②的 build 阶段必然失败，
而且报错会指向「找不到头文件」，与真正的原因无关。所以在这里就停下。

三种修法，按适用场景选：
  1) 该 commit 在远程仓库里（推荐）：
     git -C "<主仓>/src/third_party/googletest/src" fetch origin 15460959
  2) 该 commit 只在别的本地副本里：
     git -C "<主仓>/src/third_party/googletest/src" fetch <那个副本的路径> 15460959
  3) 主仓 index 记录的 commit 本来就是错的（少见）：
     在主仓里 git submodule update --init 修正后重新建 worktree
```

**为什么是「抛错」而不是「警告」**：worktree 建出来是**坏的**，
门禁②**必然**失败。让它在**建 worktree 的时候**失败（早几分钟、
信息直达），比在**门禁的时候**失败（信息被几千行编译输出淹没）好得多。
与 C9 同一原则：**依赖缺失时的正确动作是停下**，不是带着缺口继续跑。

**其二（生成物）：新增 `worktree.prepare` 配置节 —— 建 worktree 时跑前置脚本**

```yaml
worktree:
  prepare:
    commands:
      - run: python scripts/build_dtls_cert.py
        timeoutSec: 60
```

**为什么是「生成」而不是「拷贝」**：拷贝旧的生成物可能带来**过期**的
内容（过期的证书、过期的 protobuf），而重新生成保证产物与当前代码一致。

**为什么放 config.yaml 而不是 policy.yaml**：policy 是**策略**
（谁能写什么、什么必须拦），`worktree.prepare` 是**环境准备**。
policy 的规则会被 gate/sched 消费，混进「要跑什么脚本」会让策略层
变成脚本执行器。

**为什么不复用 `gate.commands`**：`gate.commands` 是**判定**用的
（跑测试、验契约），它的失败是「门禁红」；
这里是**准备**用的（生成产物），它的失败是「worktree 不可用」。
时机也不同：准备在 agent 开跑**之前**，判定在 agent 跑完**之后**。
混在一起的话，准备失败会被报成「门禁红」—— 人会去查 agent 的代码，
而问题在准备阶段（就是本条的老毛病：报错指向错的地方）。

**准备阶段的失败 → 不放行到 agent**（fail closed）。
fail fast：前一条失败就不跑后一条 —— 后一条大概率也依赖前一条的产物，
且连着跑一串注定失败的命令，报错会指向最后一条（又是「报错指错地方」）。
每条命令有超时（默认 120 秒），挂死的命令不能无限等。

**没配这一节 = 不做任何准备 = 不产生行为变化**。

**回归测试**：

- `tests/adr095-worktree-build-prerequisites.test.ts`（13 个用例）——
  单元层：判据、报错信息含三种修法、命令在 worktree 目录里跑、
  产物是重新生成而非拷贝、失败不放行、fail fast、超时、空清单不跑、
  配置解析（含 `run:` 为空被跳过、`worktree.prepare` 的 `run:`
  不被 gate 的命令解析吃掉）。
- `tests/adr095-submodule-missing-commit.test.ts`（4 个用例）——
  集成层：**真的 submodule**。本地有 pinned commit → 对齐成功，vendor 有内容；
  本地没有 → 抛错，信息带三种修法 + 点名真正的原因 + 说清后果 + 带短 sha。

**踩坑记录（两条，都值得记）**：

1. **造不出「本地缺 commit」这个状态**。以为 `gc --prune=now` 能把旧 commit
   删掉 —— 实测 expire reflog + gc + repack 之后那个 commit **仍然可读**
   （git 对近期对象有宽限期）。最后改成「把 `.git/modules/<name>` 换成一个
   **无关**的仓库」—— 这反而**更真实**（本地副本与上游脱节本来就是更常见的
   故障形态：有人重新 clone 过、module 仓库被换掉了）。
2. **判据写对了但永远读到空**。`pinnedCommitOf` 最初读 worktree 的 index，
   而 worktree 是从 HEAD 建的，HEAD 里没有 submodule 的 gitlink
   （`git submodule add` 不提交）→ 永远读到 null → 判据形同虚设。
   改成读**主仓**的 index 才对。

（这两条都是**测试逼出来的**，不是想出来的 —— 集成测试的价值就在这儿。）

**剩余问题**（未做）：

1. 子模块的「自动修复」没做：现在只报错并给三种修法，
   不自动 `git fetch` —— 因为自动 fetch **触网**（C3 的地盘），
   且「fetch 哪个 URL」需要项目知识。
2. `worktree.prepare` 没有「校验产物在位」的能力。命令跑完，
   但产物可能在（脚本静默失败、输出到别处）。要严格得再声明一份产物清单。
3. 准备阶段的耗时没进任何统计 —— `zelto status` 里看不出来。

**已落实**：

- nimrtc 侧已配 `worktree.prepare`（`.zelto/config.yaml`）：
  `python scripts/build_dtls_cert.py`（60 秒超时），
  以后建 worktree 不用再手工绕。
- 端到端验证（2026-11-22）：在 nimrtc 主仓用 `WorktreeManager.create()`
  造了**真实**的新 worktree —— prepare 前没有 `ecc-key.pem`，
  prepare 后**有**了，且是**新生成的** PKCS8 格式（241 字节），
  `server-ecc.pem` 解析出 `CN=localhost` + SAN（`DNS:localhost` /
  `IP:127.0.0.1` / 本机各网卡 IP）—— Chrome/BoringSSL 能认的那份。
- **根因收敛（2026-11-22 三次实测）**：本地主仓的 wolfSSL 是一份
  相对上游**少两个证书文件**的「carbon copy」（`da2d676` vs 上游 `ac01707`，
  缺 `certs/ecc-key.pem` 与 `certs/ecc-key.der`）。CI 用的是上游那份，
  所以 CI 绿；本地构建必然炸。详见上面的「再更正」与 ADR-095 §2.4.3。
- **nimrtc 侧修复已落地（2026-11-22）**：
  1. `build_dtls_cert.py` 不再写 vendored 子模块，只写
     `tests/wolfssl_dtls/certs/`（该目录被 `.gitignore:227` 忽略）；
  2. CMake 4 处取证书路径改到新位置，**并移除**运行期查找候选表里的
     wolfSSL 子模块路径（留着它，上游那份无 SAN 的旧证书会在某些 CWD 下
     赢过新证书，Chrome 随即以 alert 46 拒绝握手）；
  3. CI 显式生成证书 —— 6 个 workflow / 14 个 job；
  4. 实测新 worktree 走完 prepare 后，主仓与 worktree 的
     `git submodule status` **都不带 `-dirty`**。
- **未修（留在 nimrtc 侧）**：本地那份碳拷贝与上游的 2 文件差异本身没动。
  修掉之后本地与 CI 的子模块内容一致，构建期就不再依赖
  「本地缺不缺那两个文件」这件偶然的事。

## ZD-027 门禁失败时，真正失败的用例被截掉了 —— agent 只拿到「2333 个里错了，错哪个不知道」

**场景**：用 nimrtc-v14 的真实事件流做效率复盘时发现，5 个切片、14 次门禁，
每次全量跑 2316–2387 个用例、250~400 秒。门禁失败时，`gate.result` 事件里
存下来的 stdout 只有 **500 字符**，而那恰好是**排在最前面、通过了**的用例：

```
Test project D:/MyOpen/nimrtc-v14/.zelto/worktrees/v1-device-policy/build
          Start    1: BwePluginSeam.RegisterDefaultPluginsRegistersAimd
   1/2333 Test    #1: ...  Passed    0.01 sec
```

真正失败的那个用例在中间段（第 300~2000 号之间），**被截掉了**。
stderr 只剩一句 `Errors while running CTest`。

**根因**：`executor.ts` 写 `gate.result` 时是 `stdout: r.stdout.slice(0, 500)`
—— 只存**头部**。测试运行器的失败用例几乎从不排在开头（开头的总是先跑的
一批普通用例），所以这个截断**系统性地**丢掉了最该被看到的那几行。
`feedback.ts` 又只能从 stderr 捞，于是 agent 拿到的失败证据是空的。

**后果**：agent 重跑修 bug 时拿不到「上次为什么失败」，只能从头摸一遍；
人只能自己进 worktree 重跑一遍全量测试去找失败用例 —— 每次 250~400 秒。
这是 nimrtc 开发「经常停下来」的一个直接来源。

**修复（2026-11-23）**：
1. 新建 `src/core/gate/diagnostics.ts`（纯计算，C3）：从测试输出里抽
   `{ test, message, location }[]` 失败用例清单 + 断言尾部，覆盖
   **CTest / node --test（TAP + spec）/ vitest / jest / gtest**。
   抽不出时返回空清单 —— 空不等于通过，只表示没抽到。
2. `GateResult` 增 `failures` / `reportedFailureCount` / `runner` 字段；
   `executor.ts` 在命令失败时补上诊断，`gate.result` 事件随之带上结构化
   失败清单；stdout 失败时改存**尾部**（断言通常在末尾）。
3. `feedback.ts` 优先把失败用例清单作为给 agent 的 `reason`，并渲染完整清单；
   抽到的条数少于运行器声明的总数时明说「还有 N 条没抽到」。
4. CLI（`zelto gate`）与 `autoGateAfterRun` 的失败呈现都先列失败用例名与断言。
5. 新增 `zelto gate <id> --rerun-failed`：读上一次 `gate.result` 的失败 CTest
   用例名，把 ctest 命令收窄成 `ctest -R "^(?:失败1|失败2)$"`（整名精确匹配、
   元字符转义），只重跑上次失败的用例。没有历史 / 识别不出 / 非 ctest /
   已带 `-R` 时**一律退回全量** —— 宁可慢，不漏跑。

**回归测试**：`tests/zd027-gate-failure-diagnostics.test.ts`（28 项）。

**剩余问题**：`--rerun-failed` 依赖上一轮是本版本诊断写出的失败清单（老版本
二进制写的 `gate.result` 没有 `failures` 字段），首次使用退回全量、后续生效。
C++ 侧的「只构建受影响的目标」属于增量门禁（阶段 3），需改配置契约、单独写 ADR。

**顺带查清的 nimrtc 环境问题**（不是 zelto 的缺陷，但挡住了验证）：

`build_dtls_cert.py` 一开始直接崩：

```
ImportError: DLL load failed while importing _rust: 找不到指定的程序。
```

第一直觉是「用错 python 环境」。**实测排除了这个可能**：

- `where python` 只有 `D:\ProgramData\Miniconda3\python.exe`（3.9.1）；
  另有两个 pyenv / uv 的解释器，但**都没装** `cryptography`；
- conda 的包缓存里装的是 **`cryptography-3.3.1-py39hcd4344a_0`**
  （纯 C 实现）—— 它**本来是好的**；
- 但 site-packages 里却是 **`cryptography 42.0.8`** —— 某次 `pip install`
  把它升到了 Rust 实现。

**42.0.8 的 PyPI wheel 不带 `cryptography_rust.dll`**（实测 41.0.7 / 42.0.7 /
42.0.8 / 43.0.3 四个 wheel 全都只有 `_rust.pyd`），而 `_rust.pyd` 静态依赖它
—— 于是 `import cryptography` 直接失败。**只有 conda-forge 的构建才会把那个
dll 打包进去。**

修法：卸掉 pip 装的 42.0.8，把 conda 缓存里的 3.3.1 拷回去
（注意 `_rust.pyd` 可能被别的进程占着 —— 本次是一个 uvicorn 服务占的，
要先停掉才能删）。之后脚本正常。

**这条印证了 ADR-095 的一个设计选择**：`worktree.prepare` 依赖项目自己的
脚本能跑 —— 如果脚本本身跑不起来，准备阶段会**明确报错**并**不放行**到 agent，
而不是让 agent 在缺产物的目录里跑一小时再在门禁②炸掉。


---

## ZD-028 门禁重试是全量重跑 —— 810 秒花在「再确认同一个失败」上

**场景**：ZD-027 落地后复盘 nimrtc-v14 的事件流，发现门禁的**内部重试**
（`gate.retry`）跑的是**完全相同的命令** —— 对 `test` 命令而言，
就是再跑一遍全部 2333 个用例。

实测统计（`.zelto/events` 全量）：

| 门禁命令 | 次数 | 总耗时 | 占比 |
| --- | --- | --- | --- |
| `test` | 15 | **4055s** | **90%** |
| `build` | 15 | 439s | 10% |

门禁墙钟合计 4494s（约 1.25 小时），**九成在 `test` 上**。

重试的明细：

```
RETRY slice=v1-device-policy        cmd=test   attempt=1/1 prevExit=8
RETRY slice=v1-device-policy        cmd=test   attempt=1/1 prevExit=8
RETRY slice=v1-device-policy        cmd=test   attempt=1/1 prevExit=8
RETRY slice=v3-n4-d6-connectivity   cmd=build  attempt=1/1 prevExit=1
RETRY slice=v3-n4-d6-connectivity   cmd=test   attempt=1/1 prevExit=8
RETRY slice=v3-n4-d6-connectivity   cmd=test   attempt=1/1 prevExit=8
```

**根因**：重试的语义本该是「再试一次，看是不是偶发」。但实现上重试跑的是
**同一条命令**的全量 —— 于是「偶发」这个语义退化成了「再跑一遍，再确认一次
同样的失败」。

`v1-device-policy` 一片光 `test` 就花了 1254.6s（5 次全量），其中 3 次是
**纯浪费**（同样的用例、同样的断言，失败是确定性的）。每次约 270s，
合计约 **810s**。

**顺带查出的三个真 bug**（都在 ZD-027 的 `--rerun-failed` 里，都是
**在 nimrtc 上不工作**的）：

1. **`isCtestCommand` 认不出被 `cmd /c` 包起来的 ctest**。旧判据
   `[\s&|;(]` 不含 `"`，于是 nimrtc 的真实命令
   `cmd /c "ctest --test-dir build ..."` 判为**不是** ctest 命令 ——
   收窄逻辑恰好在它被开发出来的那个项目上完全失效。
2. **`-R` 的正则里 `|` 在 Windows cmd 下是管道符**。实测
   `cmd /c "ctest -R "^(?:A|B)$" ..."` 直接把命令打崩（exit 255，
   `'B)$' 不是内部或外部命令`）—— 门禁报的是一个与被测代码毫不相干的错。
3. **`--tests-from-file` 有假绿陷阱**：没匹配到任何用例时 ctest 退出码是
   **0**（stderr 打印 `No tests were found!!!`）。照搬过来会让「筛选用例名
   写错」表现成**门禁假绿**。

**修复（2026-11-23，ADR-096）**：

1. 过滤条件改用 **`--tests-from-file`（精确用例名清单文件）**，不用 `-R` 正则 ——
   用例名本来就是精确串，不需要正则；也就彻底避开了 `|` `(` `)` `.`
   等元字符的 Windows 引号/管道符陷阱。
2. 清单文件写在**门禁工作目录**下（固定名 + 切片 id，避免并行切片互相覆盖），
   跑完即删。命令行里只多一个相对路径，避开 Windows 绝对路径的空格与引号。
3. **假绿堵死**：收窄那一轮若退出码为 0，但输出里看不到任何被筛选用例名
   （或出现 `No tests were found`），判为**失败**并说清「收窄条件可能已过期」。
4. **`isCtestCommand` 放宽**：认 `ctest` **词元**（含扩展名），卡前后边界；
   路径形态按**扩展名**判是不是可执行工具（`exe`/`cmd`/`bat`/`com`/`sh`
   算，`cjs`/`js`/`py` 不算 —— 那是别的工具的脚本）。
5. **门禁内部重试自动收窄**：重试时若上一轮失败且能识别出失败用例，
   把命令收窄成「只跑那些失败用例」。第一轮已全量跑过，覆盖没丢，
   只是把重试的边际成本从 O(全量) 降到 O(失败用例数)。

**预计收益**：nimrtc 的 6 次重试从 6 × 270s 降到 6 × ~5s，省约 **1590s（约 26 分钟）**。

**回归测试**：`tests/adr096-gate-rerun-narrowing.test.ts`（21 项）
+ `tests/zd027-gate-failure-diagnostics.test.ts` 新增 3 项（executor 级端到端：
重试确实只跑失败用例、事件留痕、清单跑完即删）。

**ADR**：`docs/adr-096-gate-rerun-failed-narrowing.md`。

**剩余问题**：「只构建受影响的目标」仍属增量门禁（阶段 3b）——
推导规则藏在项目的 CMake 宏里，工具猜不得（ADR-051 已就同类问题否决）；
要推进必须由**项目侧显式声明**「模块 → 用例」的映射。


---

## ZD-030 门禁第一轮就跑全量 —— 2387 个用例里 2300 个与本片无关

**场景**：ZD-028 修好了「重试」这一轮，但**第一轮**门禁仍然是全量的。
复盘 nimrtc-v14 的事件流：

| 切片 | 门禁次数 | 每次用例数 | 每次耗时 |
| --- | --- | --- | --- |
| v1-device-policy | 5 | 2333 | ~270s |
| v3-n4-d6-connectivity | 3 | 2387 | ~290s |

而 `v2-ice` 的**写集**只有：

```
src/modules/ice/**
src/modules/sdp/**
```

`v2-ice` 只碰了 ice 与 sdp 两个模块，却要跑**全部 2387 个用例** ——
其中 audio、video、webrtc、dtls 的用例**一个都没被这次改动影响**。

**根因**：门禁不知道「这次改动影响哪些用例」。它只有一个「跑哪些命令」
的抽象，命令是**项目级**的（跑全部用例），与**切片级**的写集之间没有连接。

三条已有的路都走不通（详见 ADR-097 的「背景」段）：

1. **`spec.gateCommands`（ADR-051）** —— 让人**手写**本片的门禁命令。
   有效，但要求人知道 CMake 目标名（`nimrtc_add_test` 宏会做
   `string(REPLACE "/tests/" "_test_")` 再拼源文件名，**猜不出来**），
   而且每片都要写一遍。
2. **`--rerun-failed`（ADR-096）** —— 只在**已经失败过**之后收窄。
   救的是「重试的边际成本」，救不了「第一轮就跑全量」。
3. **CTest `-R` 正则** —— nimrtc 的用例名（`test_ice_test.IceCandidateBuild`）
   **不含模块路径**（实测），「从用例名反推源目录」这条路根本不成立。

**后果不只是慢，是信号被稀释**：2337 个用例的通过记录里，agent 找不到
「哪个用例跟我有关」；而且门禁跑全量制造了一个**危险错觉** ——
「门禁过了 = 整个项目都好了」。收窄后这个错觉消失，
门禁过了意味着「**我这片的改动是好的**」—— 这才是我们要的。

**修复（2026-11-23，ADR-097）**：

新增配置段 `gate.scope`，由**项目侧显式声明**「写集路径模式 → 作用域标签」：

```yaml
gate:
  scope:
    rules:
      - match: "src/modules/ice/**"
        labels: ["ice"]
      - match: "src/modules/sdp/**"
        labels: ["sdp"]
    fallback: full
```

工具做的：把切片的写集按规则匹配成标签集合 → 用
`ctest --show-only=json-v1` 枚举出**带这些标签的精确用例名** →
写清单文件 → 用 `--tests-from-file` 只跑它们。
**工具不推导目标名、不推断依赖、不猜**（ADR-051 的教训）。

关键安全约束：

- **匹配不到任何用例 → 门禁判失败**（不是「跑 0 个用例判通过」——
  ctest 在没匹配到时退出码是 **0**，那是假绿）；
- **写集没命中任何规则 → 退回全量**（`scopeSource: "fallback-full"`）；
- **没配 `gate.scope` → 跑全量**（老项目零变化）；
- **收窄跑完验真**：输出里必须看得到被筛选用例名，否则判失败
  （复用 ADR-096 的 `verifyNarrowedTestsRan`）；
- **留痕**：`gate.executed` / `gate.result` 记 `scoped` / `scopeLabels` /
  `scopeTestCount` / `scopeTotalTestCount` / `scopeSource`；
- **人的出口**：`zelto gate <id> --full` 强制跑全量
  （规则可能漏 —— 收窄是工具的判断，全量是人的判断）。

**与 ADR-096 的关系**：两者共用同一套机制（`--tests-from-file` 清单文件）、
同一个坑（Windows 管道符）、同一道假绿防线。ADR-096 治「重试」，
ADR-097 治「第一轮」。

**预计收益**：`v2-ice` 一类切片门禁从 2387 个用例降到 ~200 个，
单次省 200~250s；一片 5 次门禁从 1254s 降到 ~400s。

**回归测试**：`tests/adr097-scoped-gate.test.ts`（22 项）
+ `tests/config-loading.test.ts` 新增 2 项（`gate.scope` 必须被解析出来、
`scope:` 段不能吞掉 `gate:` 的其它键）。

**ADR**：`docs/adr-097-gate-scope-by-write-set.md`。

**剩余问题**：
1. **nimrtc 当前没有给用例打标签** —— `cmake/NimRTCTest.cmake` 的
   `nimrtc_add_test` 只调 `add_test(NAME ...)`，没有
   `set_tests_properties(... LABELS ...)`。要用上这个能力，
   必须**先在项目侧加标签**。这是「能力是协作出来的」——
   工具不猜，但会明确告诉你「标签一个都没匹配到」。
2. ~~**签字判据还没认作用域**~~ —— ✅ **已补（2026-11-24，ADR-104）**：
   签字复查的第②项确认（验收真跑过本片）现在**看得见**收窄
   （标签 + 「全量 N 个里选了 M 个」），且事件流里有留痕。
   **判据本身没变** —— 收窄的 fail closed 已经在门禁侧承担，
   签字侧再判一次是重复。详见 §ZD-035。

---

## ZD-044：「15 片全完成」说的是磁盘，不是分支 —— 驾驶舱里没有「分支证据」，计划也没和盘上并排过

### 场景

2026-11-25，用 zelto 给 nimrtc-v14 规划 v1.4.x 收尾（13 个待做项）。打开驾驶舱看 v3 目录：15 片全 `completed`。同一时刻在命令行核对：

```
git ls-tree --name-only version/v3 .zelto/slices/
.zelto/slices/v0-cmake.json
.zelto/slices/v0-src-log.json
.zelto/slices/v1-cmake.json        ← 只有 3 片基线
```

另外 12 片的「完成」只在 `.zelto/version-worktrees/v3/.zelto/slices/` 里 —— `.zelto/` 在 `.gitignore` 中，**换台机器、换一个 worktree 就查不到**。而版本计划里那 16 项全是 `draft`，与盘上也没并排显示过。

### 根因

驾驶舱（ADR-112 之后已能看见版本目录）只把盘上的 `state` 当事实：
「完成」没有区分「盘上完成」与「**在版本分支里完成**」；
版本计划（`.zelto/versions`）和盘上状态是两个数据源，界面从没把它们放进同一张表。

### 后果

- 人看到「15 片全完成」，以为是这一版的全部 —— 基于错误事实做决定；
- 12 片的完成证据不在分支上，事后审计（换机器重跑驾驶舱）看不到；
- 「计划过期」与「分支缺失」是两种完全不同的处置，界面不区分，人无从下手。

### 修复

- **ADR-114**：切片行带 `onBranch`（true / false / null 三态）+ `committedState`；判据按**这一行所在的根**问 git（`ls-files --error-unmatch` + `diff --quiet HEAD`），纯 git 事实；
- `/api/plan-coverage`：计划 / 盘上 / 分支**分开数**（`planned / onDisk / completed / onBranch`），逐片给出计划状态与盘上状态；前端总览加「版本计划」表（「N 片仅在盘上」徽标），切片列表加「计划」「分支证据」两列，详情页加分支证据一行；
- **ADR-115**：`zelto plan version` 从钉死的切片清单确定性建整版，顺手修 `plan patch` 只写真源、不更新被跟踪副本的问题（ADR-110 双写缺口）。

### 回归测试

`tests/web-branch-evidence.test.ts`（三态 + 按根问 git + 计划对照计数）、`tests/plan-version-deterministic.test.ts`（六类校验 + 双写 + 事件）、`tests/web-multi-root-cockpit.test.ts`（回归）。

### 现场验证

nimrtc-v14 驾驶舱（2026-11-25）：扫到 `root(15) / v1(0) / v2(0) / v3(8) / v4(0)` 五个根；计划对照显示 v1–v6 六版，v3 的「盘上完成 / 分支上完成」分开计数，已完成的片全部标「仅在盘上」。

### 剩余问题

1. **「仅在盘上」的完成片怎么进分支**：现状是要人显式提交状态文件（`.zelto/` 在 gitignore 里，需要 `git add -f` 或改 ignore 策略）。这是一个策略决定，不在本缺陷的修复范围；
2. **切片级合入明细**：现在只给计数，版本分支上「已合入哪几片」仍需 `git ls-tree` 自查。

---

## ZD-039：同一条守卫，merge 放行、ship 拦下 —— 口径分叉把人引去做错事

### 场景

nimrtc-v14 v3 收尾，`zelto version ship v3` 被拦下：

```
⚠️  主仓工作区有未提交改动，已跳过 ship：
     M src/third_party/msquic
     M src/third_party/wolfssl
     ...（共 9 个 vendor submodule）
     先提交或暂存这些改动，再重新跑 zelto version ship。
```

但这 9 个 `M` 是 **submodule 指针与 index 记录不一致**，不是人改的代码。同一份 `git status`，`zelto merge` 早就豁免了（ZD-021），报「ℹ️ 与本次合并无关」后照常合并。

### 根因

`zelto merge` 与 `zelto version ship` 是**同一道守卫的两个入口**，但 ship 的那份没有接 `isSubmoduleOnlyDirty` / `isSubmodulePointerMismatch` 两个判据。

### 后果

人按提示 `git checkout` 那 9 个 vendor 目录 → 指针被 reset 成 index 的旧值 → **版本分支里原本能构建的 vendor 布局被改坏**。误报不是「多拦一次」，而是「照做反而更坏」。

### 修复

`shipBranch` 的守卫接上与 merge 相同的两条豁免，且**只降级为提示、不放过真脏**：指针错位 / 仅内部脏标记 → 打一行 ℹ️ 继续 ship；普通文件真被改 → 仍然拦。

### 回归测试

`tests/zd039-ship-submodule-pointer-guard.test.ts`：①仅指针错位 → ship 成功；②仅内部脏 → 不拦；③普通文件被改 → 仍拦；④两者并存 → 拦且清单只列普通文件。

### 剩余问题

无。

---

## ZD-040：多版本链里 `baseCommit` 不是分叉点 —— 每次 ship 都误报「主干历史被改写」

### 场景

同一次 v3 ship，放下 ZD-039 之后又撞上：

```
⚠️  版本分支与主干**已分叉**（主干历史被改写过，不是单纯的主干前进）。
     版本基点：dd396cd5
     共同祖先：ff9d64b0
```

提示建议 `git rebase --onto feat/v14-turn-tls ff9d64b0 version/v3`。

### 根因

版本链是 v1 → v2 → v3。`version.start` 给 v3 记的 `baseCommit` 是**依赖版本 v2 的 tip**，而 v2 永远不会进主干。原判据「`baseCommit` 是否是主干 HEAD 的祖先」于是恒为假 → 每次都报分叉。

真实的分叉证据是 `git merge-base HEAD version/v3`，它给出的共同祖先与 `baseCommit` 是两个不同的提交。

### 后果

人按提示 rebase 一条本来就干净的历史 → 106 个提交逐个重放、vendor 子模块指针大面积错位。**误报比不报更坏**：不报只是撞一次冲突，误报会让人亲手把历史改坏。

### 修复

判据改为两条同时成立才算「主干已前进」：

1. `baseCommit` 仍是**版本分支**的祖先（版本分支没被 rebase / 改写）；
2. 共同祖先（`merge-base HEAD versionBranch`）等于 `baseCommit`，或是它的祖先（历史线性，主干只是在分叉点之后前进）。

反例仍判分叉：共同祖先为空（主干被 squash 成新根）、共同祖先与 `baseCommit` 无可比关系（版本分支被改写）、`baseCommit` 不在版本分支历史里。

### 回归测试

`tests/zd040-ship-multiversion-base-not-forkpoint.test.ts`：①多版本链不报分叉；②版本分支被 rebase → 仍报；③D-70 真场景（主干 squash 成新根）+ 版本链 → 仍报。

### 剩余问题

「分叉」提示里给出的 `rebase --onto` 建议，在判分叉成立时是否总是最优解，仍需要更多现场数据。

---

## ZD-045：分支证据用同步 spawn 问 git —— 整个驾驶舱被卡在「加载中…」

### 场景

ZD-044 修好、推送前的核对：用新构建的 `zelto web` 打开 nimrtc-v14，页面**一直停在「加载中…」**，等一分钟也不出来。实测各端点：

```
/api/slices         93 秒
/api/plan-coverage  28 秒
/api/summary        > 60 秒
```

同一时刻 `/api/health` 也超时 —— 不是某个端点慢，是**整个服务不再应答**。

### 根因

ADR-114 的分支证据用 `execFileSync('git', …)`：每行切片 3 次调用（`rev-parse` / `ls-files` / `diff`），列表里 24 行 × 2 个根 = 上百次**同步** spawn。

每次同步 spawn 期间事件循环完全停摆 —— 换页、静态资源、`/api/health` 全部排队。更糟的是这台机器上 git 进程启动开销是 **30–200ms 且会抖**（偶发 4 秒），所以总阻塞时间随行数线性膨胀到分钟级。

对照实验（同机同时刻）：

| 方式 | 15 次调用 |
|---|---|
| `execFileSync` 串行 | 几千毫秒，且越跑越慢 |
| 异步 `spawn` 串行 | 954ms |
| 异步 `spawn` 并发 | 138ms |

**慢的不是 git，是我们拿主线程去等它。**

### 后果

- 驾驶舱在「刚打开」这个最该起作用的时刻完全不可用；
- 前端每 30 秒轮询一次，后端的同步阻塞让每次轮询都排在上一次后面，积压越滚越大；
- 任何自动化调 `/api/health` 的对端（外部监控 / 看门狗）也一起被拖死。

### 修复

1. **异步探针**：新增 `annotateBranchEvidenceAsync`，判据与同步版逐字相同（C3：只读文件、纯计算），只是不阻塞事件循环。驾驶舱的 `listSlices` / `getSlice` 改走异步版；
2. **每个根两个进程**：`ls-files -z -- <paths>` 回答「哪些被跟踪」、`diff --name-only -z HEAD -- <paths>` 回答「哪些与 HEAD 不一致」；被跟踪且不在后者里 = `onBranch`。HEAD 内容用 `cat-file --batch` 一次读 N 个；
3. **按行指纹缓存**：键 = `scope|label|id|state|updatedAt`。任何一行变了整批重算——**只缓存 git 进程，不缓存盘上事实**。

结果（同一台机器）：

| 端点 | 修前 | 修后（冷） | 修后（热） |
|---|---|---|---|
| `/api/slices` | 93 000ms | 255ms | 39ms |
| `/api/plan-coverage` | 28 000ms | — | 30ms |
| `/api/summary` | >60 000ms | — | 34ms |

### 回归测试

- `tests/zd045-cockpit-event-loop-blocking.test.ts`：慢请求进行中时 `/api/health` 必须在 3 秒内应答；
- `tests/web-branch-evidence.test.ts` 新增「异步探针与同步探针给出同一份证据」（假表逐条比对）+「探针抛错 → 不知道」。

### 剩余问题

1. **git 启动开销本身没有变**：冷启动首屏仍有约 1.2 秒。要再往下压，需要长期驻留的 `git cat-file --batch` 管道进程——但那是**常驻状态**，与 C1「无驻留进程」冲突，必须先写 ADR 讨论；
2. **缓存没有 TTL**：指纹只盯状态文件与 `updatedAt`。若有人 `git commit` 了状态文件而切片文件本身没动，缓存会短暂显示旧证据（下次任一状态变更即刷新）。

---

## ZD-046：版本工作目录里 merge 的归属解析兜底成「合主干」，`target` 标签与实际落点对不上

### 场景

nimrtc-v14（2026-11-26）核对 v1.4 全部 10 个 v1 切片的分支归属时，发现「计划说 v1、分支说 v3、事件说 main」三方对不上。

追事件的 `merge.planned` / `merge.completed`，`target` 字段的值取决于 **merge 命令是从哪个目录跑的**：

| 切片 | merge 跑的目录 | 事件里的 `target` |
|---|---|---|
| `v1-device-policy` / `v1-audio-p2` / `v1-n5-turn-server` | 仓库根（那儿有 `.zelto/versions/plan-1795166129234.json`） | `version/v1` ✅ |
| `v1-audio-device-engine` / `v1-call-state-surface` / `v1-ice-recovery` / `v1-install-tree-module-closure` / `v1-install-tree-video-deps` / `v1-macos-install-proof` / `v1-path-change-report` / `v1-sdk-sample` / `v1-turn-credentials` / `v1-turn-tls-trust` / `v1-video-render-engine` / `v6-writeset-slice-boundary` | `.zelto/version-worktrees/v3/`（那儿 `.zelto/versions/` 是空的） | **`main`** ❌ |

共 12 条 `merge.completed` 带 `target=main`（在 `.zelto/version-worktrees/v3/.zelto/events/` 里）。

### 根因

`resolveSliceOwnership`（`core/version/branch.ts`）四级回退：

1. `--target` 显式指定
2. 版本计划成员扫描 —— 读 `.zelto/versions/`
3. 规格 frontmatter 的 `version:` 字段
4. **兜底：合入主干当前分支**

第 2 级读的是**当前目录**下的 `.zelto/versions/`。版本工作目录里的那个目录**永远是空的** —— `version start` 建 worktree 时从不复制计划文件进去：

```
$ dir .zelto/version-worktrees/{v1,v2,v3,v4}/.zelto/versions
（四个都是 0 个文件）
```

第 2 级落空、第 3 级规格里也没写 `version:` → **第 4 级兜底生效**。

### 后果：**落点碰巧没错，错的是归属**

这一点必须说准，否则会得出过头的结论。

兜底返回 `kind: 'main'`，`resolveTarget(null)` 据此取 `dir = process.cwd()` —— 而 `process.cwd()` 就是**版本工作目录**，它检出的分支正是 `version/<label>`。所以产物**全都落在版本分支上**：

```
8abb815a  origin/main=False  version/v3=True  version/v1=False
85f142c9  origin/main=False  version/v3=True  version/v1=False
18775f73  origin/main=False  version/v3=True  version/v1=False
b4aa77ec  origin/main=False  version/v3=True  version/v1=False
657941be  origin/main=False  version/v3=True  version/v1=False
3529b44a  origin/main=False  version/v3=True  version/v1=False
c40dd463  origin/main=False  version/v3=True  version/v1=False
```

**主干没有被污染** —— `origin/main` 上一个切片提交都没有。

但兜底绕过了三件事，造成真实伤害：

1. **事件流说谎**（C4 的追溯价值受损）：`merge.completed` 记 `target=main`，实际分支是 `version/v3`。事后按 `target` 审计「这版做完了没有」会得出假结论。
2. **版本归属被跳过**：走兜底 = 跳过第 2 级「计划成员扫描」与第 3 级「规格 frontmatter」。计划里 **v1 的 10 个切片有 7 个从未合进 `version/v1`**（实测 `version/v1` 只含 `v1-device-policy` / `v1-audio-p2` / `v1-n5-turn-server` 三片；另 7 片只在 `version/v3` 上）。这 7 片在计划里属于 **v1**，却落在 **v3** 的分支上。
3. **版本状态同步被跳过**：不走版本整合路径，`version.integrated` 之类的事件不产生 —— `version/v1` 上**一个 `Merge slice` 提交都没有**（tip 停在 `628df8c9`，`origin/main...version/v1` = ahead 8 / behind 41）。

一句话：**代码没丢、落点没错，但「哪片属于哪一版」这条追溯链断了**。

### 修复

ADR-121（`docs/adr/adr-121-version-context-ownership-fail-closed.md`），两处都改：

1. **让解析能成功**：`version start` 建工作目录时，把 `.zelto/versions/<plan-id>.json` 复制进 `<worktree>/.zelto/versions/`。复制的是**整个计划文件**（不是这一版的片段）—— 归属解析要知道「这个切片属于哪个版本」，而切片可能跨版本被引用。复制失败**不阻塞** `version start`（副本是派生的，缺了它可以在 merge 那一刻说清楚）。
2. **让它不许瞎猜**：`resolveSliceOwnership` 新增 `versionContext` 选项。在版本上下文里第 4 级兜底**不再生效**，改为抛 `UnresolvedOwnershipError`。判据是 **git 事实**（当前检出分支是 `version/<label>`），不看目录路径 —— worktree 可能被人挪过。
3. **显式 `--target` 反查不到计划时仍然用它**：分支名本身是权威的。「合哪儿」是明确的，不该因为「这分支属于哪份计划」不知道就改主意。
4. **基点解析同样不许兜底**（ADR-067）：基点错到主干比停下来更坏 —— agent 会在错误的基础上重写代码。所以 `resolveSliceBaseCommit` 也接受 `versionContext`，解析不出归属时抛错，不退回 HEAD。

老项目（不在版本上下文，无版本计划）行为不变 —— 这是 ADR-056 §3.2 的向后兼容承诺。

### 回归测试

- `tests/adr-121-version-context-ownership.test.ts`：14 条断言 —— 版本上下文里解析不出归属就抛错 / 老项目仍兜底合主干 / 显式 `--target` 不被兜底吞掉 / 计划复制后归属解析成功 / 歧义与「解析不出」是两种错。

### 剩余问题

1. **已投错的 12 个切片不重放**（fix-forward 决策）：重写版本分支历史的风险远大于收益。实情记在 `docs/v14-切片-分支对照.md`。
2. **那 7 个「计划说 v1、实际在 v3」的切片暂不搬移**：正解是重新按归属合进 `version/v1`，但 `version/v1` 与 `version/v3` 已分叉 104 个提交，且重做合并会撞 spec 冲突。**留作后续决定，本次只修机制 + 记录实情。**
3. **`VersionSlice.state` 从不回写**：计划里的片级状态始终是 `draft`。这是另一个问题（ADR-114 已把「计划态」与「盘上事实」分开呈现），本次没动。

---

## ZD-049：detach 主管「半转一圈」就没了 —— 状态、任务 pid、写集预约三处同时说谎，事件流里一条都没有

**场景**：`v1-rtcp-processor-collaborator`（nimrtc-v14 `version/v3`）从上午跑到晚上，
人的感受是「卡住很久了」。逐个查下去，是**几段「没人管」的时间叠在一起**：

| 时刻（本地） | 事实 | 记录 |
| --- | --- | --- |
| 13:10 | detach 主管 pid 39800 起 agent | 主管日志正常 |
| 16:24 | pid 39800 消失（谁杀的无从得知） | 切片仍是 `running`；预约锁 `pid=39800` 永不过期 |
| 17:24 | 看门狗自动恢复把状态退回 `frozen` | 事件写「进程 **28600** 已经不在了」（会话里的 pid，**不是主管 pid**） |
| 17:45 | 前台那一轮 agent 退出 | `status=failed`，**`run.finished` 没写** |
| 17:56 | 主管几秒内又起一个 agent 然后**自己也退了** | 无事件、无收尾，状态停在 `running` |

**根因**：

1. **detach 路径只有启动时的存活确认，没有运行期看门狗**。前台 `zelto run` 有活进程
   看门狗（ADR-074），主管没有 —— 它半路退出时，写集审计 / 收尾 / 任务状态 / 预约释放
   **一个都没跑**，而没有任何地方能看见这件事。
2. **看门狗报错了对象**：`run.aborted` 里的 pid 取自会话文件，不是主管的 pid；
   拿着日志去 kill 的那个人会以为「杀的就是看门狗说死的那个」。
3. **`run.aborted` 与 `task` 的 pid 不在一条引用链上**（会话 → 事件 → 任务三者各说各的）。

**后果**：最坏的一条是「running 是假的」—— 三处状态同时说谎，事件流里却没有一条
「它已经不管了」。与 ADR-123 同一个病灶，只是这次说谎的是 **detach 主管**。
这一轮实际是我人工核实「主管与被拉起的 agent 都已不在」之后，才敢按人工接管处理。

**修复**（待做）：

1. detach 主管**运行期心跳**（写事件或心跳文件）；驾驶舱 / `zelto status` 发现
   「主管 pid 不在、任务仍 running」→ 落 `run.finished`（`phase=supervisor`）并退回 `frozen`。
2. `run.aborted` 的 pid 拆成 `supervisorPid` / `agentPid`，两者都在日志里打印。

**回归测试**：待修复落地时补 —— kill 主管后 30s 内必须出现收尾事件，且 `pid` 字段是主管 pid。

## ZD-050：没跑完的 post-run 让 worktree 裸奔 —— 「结果不明」的一轮被当成了「新的一轮」，同一片被跑了两遍

**场景**：同一片。17:30Z 那一轮（前台）：会话 17:57Z 记 `failed`，**`run.finished` /
`run.aborted` 一条都没有**；进程全部消失后，状态与预约锁仍停在 `running`。
磁盘上的 claude 原生会话有三个（17:26 / 17:30 / 17:45），**其中两段运行时间重叠**，
都在改同一个 worktree。

**根因**：

1. **post-run 不是原子的**：`run.finished` 落在收尾的**最后**、预约释放之前；主管 / CLI
   在收尾中途消失时，**「这一轮结束了」这个事实本身丢了** —— 之后的人只能看到
   `run.started`，好像这一轮**还在跑**。
2. **「结果不明」没有参与者**：`exitCode=null && !processAlive` 本应走到收尾，
   但收尾没跑完 → 下一轮准入时看到的是「running」，**没有任何东西判定它已经没人管**。
3. **后起的那一轮又丢了**（见 ZD-049）。

**后果**：

- 同一个 worktree 上**两个 agent 共享同一个 `.claude/settings.local.json` 钩子** ——
  钩子指向**先死的那个**进程，后来的 agent 从此被「指向死进程的钩子」挡住（或绕过，
  取决于 harness 对钩子失败的处理），**这正是「守卫在不在」变得不可知的时刻**。
- 事后回顾：真正的写集守卫是在**人都以为没人跑**的时候失效的 —— 这是 C9 意义上的
  最坏时刻，而它之所以没造成更大破坏，纯属运气。

**修复**（待做）：收尾与预约释放**先落事实、后释放**，并把落盘顺序写进 ADR：
`run.finished`（或 `run.aborted`）必须在 `reservation.released` **之前**；
主管在两者之间崩溃时，下次准入用「事件流里有无本轮收尾」而不是「会话文件状态」
判定这一轮是否结束。

**回归测试**：待修复落地时补 —— kill 主管进程后，事件流里**必须有**收尾事件，
**且**它为 release 之前；`zelto run` 对「running 但没有收尾事件、主管不在」的切片**拒绝**并提示 `zelto resume`。

## ZD-051：同一天五轮运行，事件流里只有两轮有「结束」—— 会话文件名、任务 pid、事件三者没有一条引用链

**场景**：同一片一天里被拉起 5 次：

| 起跑（本地） | 方式 | 事件流 |
| --- | --- | --- |
| 10:58 | detach | `run.started` → watchdog `run.aborted` |
| 13:38 | detach | `run.started` → `run.finished`（ok） |
| 14:05 | detach | `run.started`，**无结束事件** |
| 17:30 | 前台 | `run.started`，**无结束事件** |
| 17:45 | 前台 retry-1 | **无事件**（会话记录里才有 `retryCount=1`） |

**根因**：

1. **会话文件名的数字是「启动时刻」**，retry 会话靠后缀 `-retry-1` 区分；
   但**取「当前那轮」的逻辑**（看门狗、`status`）用的是「最新文件」——
   retry 的文件可能比主会话**先落盘**，于是「最新」指向的是**已经死掉的那一轮**。
2. **事件流里没有「第几轮」这个维度**：`run.started` 与 `run.finished` 只能靠时间戳配对；
   缺一端就是「没有结论」，而**门禁 / 驾驶舱都把「缺一端」当成了「还在跑」或「没跑完」**。

**后果**：事后审计能数出「5 次」，但**答不出「17:30 那轮是怎么结束的」** —— 这正是
「可追溯」在这一片上的缺口。

**修复**（待做）：每次运行带 `runId`（`sliceId + startedAt + attempt`），写进
`run.started` / `run.finished` / `run.aborted` 与 gotchas 相关的钩子事件；`task` 只记**当前轮**的 `runId`。
**禁止**用「最新文件」推断「当前轮」。

**回归测试**：待修复落地时补 —— 连续 retry 两次后三段 `runId` 互不相同；按 `runId` 聚时，
每一轮都有起跑与结束两端（或显式 `unknown`）。

---

## ZD-052：写集守卫挡住了 `build/` 里的日志、挡不住写集内的「大削」—— 被拦的往往是无害的那一下

**场景**：同一片。agent 在前几轮里：

1. 想 `cmake --build` 并把日志落到 `/tmp/nimrtc_configure.log` 或 `build/configure.log` ——
   被判「越界写入」，理由是「不在写集里」；
2. 随后**转向大改工作区文件**（`engine_media.cpp` 被大段重写、`engine_media.cpp` 里某个
   分发分支被削到只剩骨架），这些**都在写集里**，钩子照常放行。

**根因**（口径，不是 bug 本身）：

- 写集的语义是「防止 agent 动**别人的文件**」，但实现上它同时**挡住了构建 / 日志这类
  「一次运行自己的一次性产物」**。结果是 agent 不得不在「没有日志」和「不许构建」之间二选一 ——
  逼着它把调试信息丢进工作区里**合法但危险**的文件。
- 写集内的**大规模改写**没有「可见度」：门禁只问「构建过不过、测试绿不绿」；
  「一个文件被删掉 40% 行数」在摘要里**不出现**。

**后果**：这一片最危险的一次改写（`handle_rtcp` 从约 243 行被压成 10 行的一次中间态）
**全程合法**；而真正被拦下的是「写日志」。**守卫拦住的不是有害动作。**

**修复**（待做）：

1. 写集判定区分「工作区文件」与「运行期一次性产物」：`build/`、`/tmp/`、
   agent 的临时输出**显式 allow**，并让 `policy.decision` 带上**被判定的是同一个目标**；
2. 收尾报告**列出写集内每个文件的增删行数**（不是拦，是让人第一眼看到「哪里有异常削除」）。

**回归测试**：待修复落地时补 —— `tee /tmp/x.log` 与 `build/` 下的日志 allow 且带目标；
写集之外的真实仓库文件仍 deny。

## ZD-053：验收文件里的断言**与规格条目没有编号对应** —— 门禁只问「有没有真断言」

**场景**：同一片。验收文件 `tests/acceptance/v1-rtcp-processor-collaborator/acceptance.test.cjs`
由 agent 写（todo 已替换为真断言）。但规格的验收标准是**四节若干条**：
协作类纪律、行为不变、守则、公共头未动、文档。其中「`engine_impl.hpp` ≤ 400 行」、
「公共头 diff 为空」、「CHANGELOG 有条目」**不是测试能表达的**；门禁的验收环节
只验「有没有非 todo 的断言」，**不验「规格里的每一条是否都被验到」**。

**根因**：验收标准的「条目」与验收文件「断言」之间**没有任何编号或标记关联**。
同一件事、两种载体，**没有核对机制**。

**后果**：门禁绿 ≠ 规格达成。这一片之所以能放心签，是因为我**逐条手工量过**
（行数 371 ✅、公共头无 diff ✅、`handle_rtcp` 恰 60 行 ✅）。
下一次如果没有这次那样逐条量，**「门禁绿、人以为全验了」会成为默认路径**。

**修复**（待做）：

- 规格验收点**必须编号**（`AC-01 …`），验收断言名带同一编号；
  门禁核对「规格编号集合 ⊆ 验收文件编号集合」，缺一即 failed；
- 非测试可表达的条目，规格里写明**谁验**（checker / gate / 人），
  门禁摘要里逐条输出 `verified` / `unverified`，**不许省略**。

**回归测试**：待修复落地时补 —— 故意删掉一个编号断言 → 门禁 failed；
非测试条目未在摘要里出现 → 视为摘要失败。

## ZD-054：规格点 2（「`engine_media.cpp` 中皆无具体 `rtp::` RTCP 类型」）与实现存在**口径分叉**，需要 owner 裁决

**场景**：同一片签字前的逐条核对。结果是：

- 规格验收点 2 字面要求：`engine_media.cpp` **中皆无** `rtp::RrBuilder` /
  `rtp::demux_rtcp` / `rtp::RtcpBlock` / `rtp::ReportBlock`；
- 实现：这四个**确实都没有** ✅，但 `engine_media.cpp` 里**仍然**有一个
  `feed_timeline_sr(rtp::SenderReportTracker&, …)` 会重建 `rtp::SenderReport`
  （`engine_media.cpp` 中 `rtp::` 出现 8 处，其中 4 处是注释、4 处在 `feed_timeline_sr` 里）；
- checker 的守则（`tools/check_engine_layering.py`）**是绿的** —— 它的符号清单
  与规格点 2 的符号清单**不是同一份**，`SenderReport` 不在任何一方的「禁止清单」里。

**根因**：**同一个架构约束被写了两份**：一份在规格验收点、一份在 checker 规则里。
两份清单靠人同步，**没有自动对齐**。于是「checker 绿」与「规格点满足」不是同一句话。

**后果**：这一片**没有因此被拦下**（门禁绿、人核过），但「行为不变 / 类型收口」的
证明里**混进了一个例外**，而例外**没有被任何一方登记**。下一次同类切片会继承这个
「隐蔽的绿」。

**需要 owner 裁决**（三选一，**不替 owner 选**）：

1. 把 `feed_timeline_sr` 搬进 `rtcp_processor.cpp`（`engine_media.cpp` 彻底清零 `rtp::`）；
2. 规格点 2 增加与 `engine_scratch.hpp × rtp::RtcpBlock` 同形的窄豁免
   （`engine_media.cpp × rtp::SenderReport`）；
3. 修改 checker 规则，把 `SenderReport` 纳入 / 显式排除，并**让规格引用 checker 的清单**。

**修复方向（机制层面，与裁决无关）**：架构约束的判据**只写一处**；规格的验收点**引用它**，
由工具核对「checker 的例外表」与「规格的窄豁免」**完全一致**，不一致就红。

**回归测试**：待修复落地时补 —— 给 checker 加一条例外而规格没加 → 门禁 failed（反向亦然）。

---

## ZD-055：人在版本工作目录里，`zelto merge --target version/<同一版>` 永远「找不到工作目录」—— 版本目录在**外层**

**场景**：`v1-rtcp-processor-collaborator` 签字后，人在 `version-worktrees/v3`
（版本工作目录，检出 `version/v3`）里跑两条命令：

```
zelto merge v1-rtcp-processor-collaborator
  → ❌ 解析不出归属：版本工作目录里没有版本计划文件（.zelto/versions/ 是空的）
zelto merge v1-rtcp-processor-collaborator --target version/v3
  → ❌ 版本 "v3" 的工作目录不存在：.zelto\version-worktrees\v3
    先跑 zelto version start v3
```

而那个目录**就是脚下这一层**。

**根因**：`WorktreeManager.versionPathFor(label)` 固定按
`<repoRoot>/.zelto/version-worktrees/<label>` 拼。切片 worktree 是**相对** repoRoot 的
（在版本工作目录里跑 `zelto run` 时正确），但版本工作目录是**绝对**的 ——
`zelto version start` 永远在仓库顶层建 `<顶层>/.zelto/version-worktrees/<label>/`。
两边约定互相咬死：

- 在版本工作目录里跑 → 版本目录拼成 `v3/.zelto/version-worktrees/v3`（不存在）；
- 人手工 `cd` 到顶层跑 → 切片 worktree（`<顶层>/.zelto/worktrees/<id>`）又找不到。

于是**「在版本分支上合并」这件事在 CLI 里几乎做不成**。

**后果**：人只能手工 `git merge`（`zelto merge` 自己在失败时也是这么建议的）——
而手工 merge **不走** zelto 的合并路径：不写 `merge.completed`、不做版本状态同步、
不清理 worktree —— 正是 ADR-121 / ZD-048 那条「归属解析被绕过」的老路。

**修复（已落地，2026-11-26）**：`versionWorktreeBaseDir()` —— 判据先看 **git 事实**
（当前检出 `version/<label>`，与 ADR-121 一致），再从 repoRoot 的祖先目录逐级向上找
`<祖先>/.zelto/version-worktrees/<label>`（**同名且存在**才算）。逃逸防护不变：
`versionPathFor` 先按**子仓基准**做一次包含性判定，逃出 repoRoot 的 label 一律抛错。

**回归测试**：`tests/path-escape-guard.test.ts` 新增「版本工作目录里 merge」用例；
实测 `versionPathFor('v3')` 在 `version-worktrees/v3` 下返回真实目录（exists=true），
`zelto merge … --target version/v3` 成功 fast-forward 并清理了 worktree 与切片分支。

---

## ZD-056：`milestones` 之前的规格副本让 fast-forward 合并必失败，建议的修法又打死 next

**场景**：同一片。`zelto merge --target version/v3` 走到最后一步：

```
⚠️ specs/slices/<id>.md：工作区副本与 refs/heads/slice/<id> 上的版本内容不同（保留工作区的）
❌ 合并失败：error: The following untracked working tree files would be overwritten by merge
   手动解决：git merge slice/<id>
```

**根因**：版本工作目录里的 `specs/slices/<id>.md` 是一份**未跟踪的工作区副本**，
它与切片分支上提交的版本**内容不同**：

- 切片分支那份**多出**「实施发现」一节（agent 在被丢弃的那一轮里补的 —— 规格点 12
  要求的就是这一节）；
- 工作区的副本是**较旧的**冻结版（14:02 落盘），**没有**这一节。

合并逻辑对「规格副本与待合分支不一致」的处理是「**保留工作区的副本，请人确认**」——
副本留在原地，`git merge` 于是被未跟踪文件挡住，**合并不可能成功**。
而它给出的建议「手动 `git merge`」同上 ZD-055 —— 绕过 zelto。

更糟：`zelto run` 每次开跑都会把版本工作目录里的规格**覆盖成冻结版**（D-47：
顶层规格是「人的产出」，同步时覆盖是对的）—— 于是「agent 的实现在切片分支上、
规格的实施发现在切片分支上、而工作区又把规格盖回旧版」这三件事会**再次**撞在一起。

**后果**：**在任何「agent 改了规格副本」的切片上，ff 合并都要人工先手动对齐副本**；
不一致时「保留工作区的」这个默认会让合并**必然失败**（不是偶发）。

**修复（待做）**：合并前若「目标分支上已提交的规格」与「工作区未跟踪副本」不同，
应**以分支上那份为准**（它是本切片的产物，且已由门禁签名覆盖），把工作区副本
**先移走/备份**再合并；或直接拒绝并给出**可执行的**修复命令（`git checkout -f` 之类），
而不是「保留 + 请人确认」这种**必然失败**的组合。

本次实情：人工把分支版规格同步到工作区（内容完全一致）后再跑 merge 才成功。

---

## ZD-057：驾驶舱「分支上完成」恒为 0，把「这版全做完了」说成了「一片都没进分支」（ADR-126）

**场景**：同一项目的驾驶舱「版本计划」表（2026-11-26）：

| 版本 | 计划片数 | 盘上有片 | 盘上完成 | **分支上完成** |
|---|---|---|---|---|
| v1 | 11 | 11 | 11 | **0** |
| v3 | 14 | 14 | 14 | **0** |

**根因**：ADR-114 那列判的是**切片状态文件**（`.zelto/slices/<id>.json`）
是否提交进了所属分支；而 `.zelto/` 整体被 `.gitignore` 忽略（ADR-121 的设计），
状态文件**永远不会**进版本分支 —— 这一列按定义恒为 0。可它叫「分支上完成」、
紧挨着「盘上完成」，读者一定把它当完成度。

**后果**：事实相反 —— 按 `Refs-Slice:` trailer 实测，产物一直在分支上
（version/v1 → 4 片，v3 → 21 片）。一个「永远 0」的列会让驾驶舱得出「这版没做完」的假结论。

**修复**：ADR-126，`core/project/artifact-evidence.ts` ——
「分支上有产物」按 `Refs-Slice:` 提交判（不依赖 `.zelto/` 是否进 git），
查的是**所属版本分支**，归属错位不会被「哪儿有算哪儿」藏起来；ADR-114 那列保留并改名为
「状态文件进分支」，诚实地说自己是 0。

**回归测试**：`tests/adr-126-artifact-evidence.test.ts`（三态 / 多提交 /
归属错位 / 祖先分支）。

**剩余问题**：栈式版本（v3 从 v2 切）里祖先片的产物不在本版分支上 ——
已按「随祖先版本并入」并排给出（ADR-126 §五，实测 v3：本版 1 片 + 祖先 20 片）。
v1 的片落在 v3 上的**归属错位**本身另见 ZD-046 / ADR-127。

## ZD-058：监督进程收尾完成后永远不退出 —— 进程表里挂着 11 个线程的「僵尸主管」（ADR-125）

**场景**：同一片的 17:26 那一轮。17:45 agent 退出（码 0），监督日志打出
「✅ Agent completed successfully」，切片写回 `frozen`、预约释放、签字请求发出 ——
**收尾全对**。但监督进程 pid 43956 过了一小时仍在进程表里：CPU 时间几秒（空闲）、
11 个线程、父进程早已消失。

**根因**：`supervisor-entry.ts` 只在 `runSupervisor()` 的 Promise **resolve 后**才
`process.exit`。而适配器的心跳 `setInterval` **没有 `unref`**；收尾流水线里的
`markProgress` → `resetIdleTimer` 恰好在「会话已不在」守卫不成立时**又装一个新心跳**，
事件循环于是永不空 —— `process.exit` 永远不被调用。所以是**条件性**的：
下一轮不留残留定时器就不复现（18:58 那一轮即如此）。

**后果**：切片状态是对的，但「以为还在跑」的人会被进程表骗；
而被 `zelto resume` 要求「先确认没人在跑」的流程也会多一步不必要的排查。

**修复**：ADR-125。根因层：三个适配器的心跳 / 空转定时器一律 `unref()`；
契约层：收尾返回后 `process.exitCode` + 3 秒宽限后强制 `process.exit`，
异常路径直接退出。

**回归测试**：`tests/adr-125-supervisor-exit.test.ts`。

**剩余问题**：收尾**过程中**挂住（与「收尾之后挂住」不是一回事）仍只有日志可看，
ADR-125 第二节的 watchdog 未实现。

---

## 记录格式约定

新增缺陷时按上方的「场景 / 根因 / 后果 / 修复 / 回归测试 / 剩余问题」六段写。不要只记「修了」—— 要说清楚**当时怎么踩到的**、**怎么复现**、**不修的话会在哪一步暴露**。

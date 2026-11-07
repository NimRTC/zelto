# zelto 实用化改造路线图

> 最后更新: 2026-11-06
> 本文件记录**历史改造路线**的完成情况。每条已落地项都标注了对应的 ADR，
> 以当前实现为准——冲突时以 ADR 与 `docs/zelto-技术架构.md` 为准。
> 项目当前状态与剩余差距见 `docs/zelto-项目目标.md` §6。

## 阶段一：基础设施（Gap 2 + Gap 1 前半）✅
- ✅ 拆分 commands.ts → `src/cli/commands/*.ts`
- ✅ Agent 会话持久化（实现 SessionPort）
- ✅ Agent 超时/重试机制

## 阶段二：Agent 闭环（Gap 1 后半 + Gap 6）✅
- ✅ 并行多 agent 执行 —— 后续已演进为**阶段化执行**
  （依赖分层 + 写集冲突降级，ADR-019；`core/sched/batch.ts` 的
  `planExecutionPhases()` 是唯一排法，CLI 入口 `cli/commands/execution-plan.ts`）
- ✅ 执行完自动触发 gate（`run`/`start` 后 auto-gate）
- ✅ gate 通过自动发起签名请求
- ✅ **签字只改状态，合入主干必须人显式跑 `zelto merge`**（ADR-018）
  —— 本条早期版本写的是「sign approve 自动 merge（commit + merge to main）」，
  该行为已按 ADR-018 移除：签字回答「这份改动可不可以合入主线」，
  合并回答「现在就合」，两者是不同的事，混在一起事件流里就只剩「批准」，
  没有「合了什么、按什么顺序合、撞了哪些文件」，追溯链在合并处就断了。
  当前实现：`core/gate/sign.ts` 只写 `sign.approved` 事件；
  合并是独立命令 `zelto merge`（`cli/commands/merge.ts` + `merge-runner.ts`）。

## 阶段三：补核心模块（Gap 3）✅
- ✅ artifacts（制品管理）
- ✅ contracts（契约验证）
- ✅ spec（规格引擎）

## 阶段四：外部验证 + CI/CD（Gap 4 + Gap 5）✅
- ✅ 找真实项目跑接管流程
- ✅ GitHub Action / Docker / pre-commit 集成

## 阶段五：体验打磨（Gap 7）✅
- ✅ 进度指示、颜色输出、错误美化
- ✅ `zelto suggest` 引导命令
- ✅ help 文本与实际同步

## 阶段六：规划与交付闭环（2026-11 起）✅
- ✅ 版本级编排，单一并行执行路径（ADR-017）
- ✅ 写集预约的运行时强制（ADR-014）—— PreToolUse 钩子逐写判定为主，
  运行后 git 审计兜底，缺预约 fail closed（C9）
- ✅ worktree 隔离（ADR-011）与并行协调（ADR-012）
- ✅ agent 提问回路（ADR-013）
- ✅ 规格章节契约收敛为单一真源（ADR-016）
- ✅ 签字可撤销（ADR-021）、拉闸暂停批次（ADR-020）
- ✅ 规划确认体验：摘要 + diff + 只看决策点（ADR-023）
- ✅ 亲和分组调度（ADR-024）、trace 判定单一真源（ADR-025）
- ✅ 凭据优先走环境变量（ADR-022）
- ✅ 架构护栏：只读报告（G-4/B）+ `policy.yaml` 可配置定级（G-4/A，ADR-027）

## 阶段七：策略解析语义修正（2026-11-06）✅
- ✅ 策略 YAML 解析：引号风格无关、行内 `match` 键序无关（ADR-028）
- ✅ 三处解析器语义一致（core / hook / hook pretool），并有等价性测试锁住

## 阶段八：契约演进与跨版本回归（2026-11-08）✅
- ✅ 契约演进检查：当前契约 vs 人工确认过的基线，算出破坏性变化并分清
  写入方 / 读取方两个方向（ADR-036）
- ✅ 契约基线由人显式更新（`zelto contract baseline`），不自动签掉破坏
- ✅ 跨版本回归基线：版本交付时记录 TAP 用例状态，与上一个已交付版本对比，
  检出「用例消失 / 退化成空壳 / 直接变红」三类回归
- ✅ 两项都接进 `zelto version deliver` 作为交付前置闸门

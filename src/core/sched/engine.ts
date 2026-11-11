// Scheduler engine — parallel admission control
// C3: deterministic only — no model calls, no network
// C1: state in files only — reads from SliceStore

import type { SliceData, SliceStore } from '../slice/store.js';
import type { EventStream, EventType } from '../events/stream.js';
import type { PolicyConfig, PolicyRule } from '../policy/types.js';
import type { SchedResult, SchedBlock, SchedDecision, ConstraintBundle, AffinityContext, GateCommandSummary } from './types.js';
import { QUESTION_INSTRUCTIONS } from '../question/index.js';
import { blockingViolations, judgeTrace, traceCountsOf } from '../trace/index.js';
import { pathMatches, writeSetsOverlap } from './paths.js';

/**
 * 找出写集里那个「全是 test.todo 的验收骨架」。
 *
 * 判据是**路径形态**而不是读文件内容：骨架固定叫 `acceptance.test.cjs`，
 * 落在 `tests/acceptance/` 下面。读内容反而更脆（agent 改了一半，
 * 文件里有真断言也有 todo，那就不是「只有 todo」了）。
 */
function acceptanceSkeletonInWriteSet(slice: SliceData): string | null {
  for (const w of slice.writes) {
    const normalized = w.replace(/\\/g, '/');
    if (normalized.endsWith('acceptance.test.cjs')) return w;
  }
  return null;
}

export class Scheduler {
  private readonly store: SliceStore;
  private readonly events: EventStream;
  private readonly policy: PolicyConfig;

  constructor(store: SliceStore, events: EventStream, policy: PolicyConfig) {
    this.store = store;
    this.events = events;
    this.policy = policy;
  }

  /**
   * Check if a slice can be admitted for parallel execution.
   * A slice is blocked if its write-set overlaps with another running slice's write-set.
   */
  async admit(sliceId: string, actor: string = 'zelto'): Promise<SchedResult> {
    const slice = await this.store.read(sliceId);

    // Must be frozen or completed to run
    if (slice.state !== 'frozen' && slice.state !== 'completed') {
      // 卡在 running 且带停机分类 = 死切片（ADR-047）。
      //
      // 光说「must be frozen or completed」是**假话**：人是照着这句话去
      // 找「为什么不是 frozen」的，而答案不在状态机里 —— 在停机分类里。
      // 所以这里把出路直接说出来。
      //
      // 提问回路（`agent_question`）是另一回事：那不是「跑挂了」，
      // 是 agent 停下来等人数码 —— 该答的是问题，不是 resume。
      let reason = `Slice is in state "${slice.state}", must be "frozen" or "completed"`;
      if (slice.state === 'running' && slice.stall.class !== null) {
        reason = slice.stall.class === 'agent_question'
          ? `Slice is waiting for an answer (agent_question) — answer it first: zelto ask`
          : `Slice is stalled (${slice.stall.class}) and stuck in "running" — resume it first: zelto resume ${sliceId}`;
      }
      return {
        sliceId,
        decision: 'blocked',
        reason,
        blockedBy: [],
      };
    }

    // Must have a frozen spec
    if (!slice.spec.frozenHash) {
      return {
        sliceId,
        decision: 'blocked',
        reason: 'Slice has not been frozen (no frozenHash)',
        blockedBy: [],
      };
    }

    // 追溯准入（ADR-032 §3.1）：需求追溯为空 = 这段代码没有出处 → 不许开跑。
    // 判据唯一真源在 core/trace/；这里只做呈现翻译。
    // 基线切片不参与追溯链（它只描述现状、不改代码）。
    const traceJudgment = judgeTrace({ trace: traceCountsOf(slice.trace), waiver: slice.traceWaiver });
    const traceBlocking = slice.baseline ? [] : blockingViolations(traceJudgment);
    if (traceBlocking.length > 0) {
      const reason = `Trace incomplete: ${traceBlocking.map((v) => v.message).join('；')}`;
      await this.appendEvent(sliceId, 'sched.blocked', actor, {
        sliceId,
        reason,
        issues: traceBlocking.map((v) => v.code),
      });
      return {
        sliceId,
        decision: 'blocked',
        reason,
        blockedBy: [],
      };
    }

    // Check write-set conflicts with running slices (skip for baseline slices)
    const allSlices = await this.store.list();
    const runningWrites = new Map<string, string[]>(); // sliceId → writes
    const blockedBy: string[] = [];

    if (slice.baseline) {
      // Baseline slices don't write new code — they only capture existing state
      // Skip writes reservation check to avoid blocking on unrelated running slices
      await this.appendEvent(sliceId, 'sched.admitted', actor, {
        sliceId, baseline: true, note: 'Baseline slice — writes reservation check skipped',
      });
      return {
        sliceId,
        decision: 'admitted',
        reason: null,
        blockedBy: [],
      };
    }

    for (const id of allSlices) {
      if (id === sliceId) continue;
      try {
        const s = await this.store.read(id);
        if (s.state === 'running') {
          // 停机切片大多不算「正在跑」（ADR-047）。
          //
          // 它状态还是 running 的原因有两个：要么是历史切片（修复前留下的
          // 死切片），要么是停机发生在退状态之前的那一瞬间。
          // 两种情况下它的 agent 都已经不在跑了 —— 继续拿它的写集
          // 挡别的切片，就是「一片失败挡住整个队列」。
          //
          // **例外：提问回路**（`agent_question`）。那不是「跑挂了」——
          // agent 还活着，只是停下来等人数码，答完就在原地续跑
          // （ADR-013）。它的会话仍然会写文件，仍然占着写集。
          // 把它排除掉 = 两个 agent 同时改同一批文件。
          //
          // 判据是**停机分类**（纯读文件，C3）。
          if (s.stall.class !== null && s.stall.class !== 'agent_question') continue;
          runningWrites.set(id, s.writes);
        }
      } catch {
        // Skip unreadable slices
      }
    }

    // Check for write-set overlap
    for (const [runningId, writes] of runningWrites) {
      if (this.hasOverlap(slice.writes, writes)) {
        blockedBy.push(runningId);
      }
    }

    if (blockedBy.length > 0) {
      const block: SchedBlock = {
        sliceId,
        blockedBy,
        blockedAt: new Date().toISOString(),
        reason: `Write-set conflicts with: ${blockedBy.join(', ')}`,
      };

      await this.appendEvent(sliceId, 'sched.blocked', actor, block as unknown as Record<string, unknown>);

      return {
        sliceId,
        decision: 'blocked',
        reason: block.reason,
        blockedBy,
      };
    }

    await this.appendEvent(sliceId, 'sched.admitted', actor, { sliceId });

    return {
      sliceId,
      decision: 'admitted',
      reason: null,
      blockedBy: [],
    };
  }

  /**
   * Build a constraint bundle for an agent session.
   * Contains: spec path, frozen hash, acceptance dir, write-set, protected paths, policy rules.
   *
   * affinity 只读建议（ADR-024 §3.3）：调用方把算好的上下文传进来，
   * 这里只装包、不判定。null/缺省表示无亲和，语义与原来完全一致。
   *
   * gateCommands（ADR-045）：门禁命令原文也装进包里。agent 验证自己的
   * 产物时必须用同一套命令 —— 否则门禁②会在 agent 留下的现场上失败
   * （CMake 生成器不一致是最典型的例子）。
   */
  buildConstraints(
    slice: SliceData,
    affinity?: AffinityContext | null,
    gateCommands?: GateCommandSummary[],
  ): ConstraintBundle {
    // Collect relevant policy rules (exclude deny-all defaults, include specific rules)
    const relevantRules = this.policy.rules.filter((r) => {
      // Include rules that match the slice's write paths or are general allow/deny
      if (!r.match.path) return true;
      return slice.writes.some((w) => pathMatches(w, r.match.path!));
    });

    return {
      sliceId: slice.id,
      specPath: slice.spec.path,
      frozenHash: slice.spec.frozenHash,
      acceptanceDir: slice.acceptance.dir,
      writes: slice.writes,
      protectedPaths: [
        'policy/**',
        '.zelto/**',
        'AGENTS.md',
        '.cursor/rules/**',
      ],
      policyRules: relevantRules,
      instructions: this.buildInstructions(slice, affinity ?? null, gateCommands),
      affinity: affinity ?? null,
      ...(gateCommands && gateCommands.length > 0 ? { gateCommands } : {}),
    };
  }

  /**
   * 组装亲和上下文（ADR-024 §3.3，只读建议）。
   *
   * 只读三样东西：前片的冻结规格（frozenHash + 标题 + 写集）、
   * 已合入 commit（merge.* 事件里的 mergeCommit）、门禁结论不单独存
   * （前片能进到这里即视为可引用）。不读 worktree 中间态、不调模型（C3/C7）。
   *
   * @param sliceId 本片 id（仅用于校验，不参与摘要）
   * @param groupId 亲和组 id
   * @param previousSlices 组内排在本片之前的切片 id（按执行序，已按 id 排序）
   */
  async buildAffinityContext(
    sliceId: string,
    groupId: string,
    previousSlices: string[],
  ): Promise<AffinityContext | null> {
    if (!groupId || previousSlices.length === 0) return null;
    // 本片不在前序里才有意义；调用方保证顺序，这里只做防御
    const prev = previousSlices.filter((id) => id !== sliceId);
    if (prev.length === 0) return null;

    const summaries: AffinityContext['summaries'] = [];
    for (const id of prev) {
      let data: SliceData | null = null;
      try {
        data = await this.store.read(id);
      } catch {
        continue;
      }
      const frozenHash = data.spec.frozenHash;
      const commit = await this.readMergedCommit(id);
      const shortHash = frozenHash ? frozenHash.replace(/^sha256:/, '').slice(0, 12) : 'unfrozen';
      const summary = `${data.title} | writes: ${data.writes.join(', ') || '(none)'} | frozen: ${shortHash}`;
      summaries.push({ sliceId: id, frozenHash, commit, summary });
    }

    if (summaries.length === 0) return null;
    return {
      groupId,
      previousSlices: summaries.map((s) => s.sliceId),
      summaries,
    };
  }

  /** 读某片的已合入 commit：只认 merge.* 事件，不读 worktree 中间态 */
  private async readMergedCommit(sliceId: string): Promise<string | null> {
    try {
      const evts = await this.events.read(sliceId);
      for (let i = evts.length - 1; i >= 0; i--) {
        const p = evts[i].payload as Record<string, unknown>;
        const c = p?.['mergeCommit'];
        if (typeof c === 'string' && c.length > 0) return c;
      }
    } catch {
      /* 读不到事件就没有合入记录 */
    }
    return null;
  }

  /**
   * Mark a slice as running and record the admission.
   *
   * 开跑即意味着「停机结束了」：如果切片还带着停机分类（比如人工拉闸
   * 回退后留下的 `human_halt`），这里把它清掉并留一条 `run.resumed` 事件。
   *
   * 为什么必须在这里清：`zelto next` 会把停机切片排在最前面。
   * 如果开跑不清，下次 `zelto next` 还是指着这个已经跑过的切片 ——
   * 人会陷入「resume → run → next 还在说 resume」的死循环。
   */
  async startRun(sliceId: string, actor: string = 'zelto'): Promise<SliceData> {
    const slice = await this.store.read(sliceId);

    if (slice.stall.class !== null) {
      const previousStallClass = slice.stall.class;
      await this.appendEvent(sliceId, 'run.resumed', actor, {
        resolution: 'run_restart',
        previousStallClass,
      });
      slice.stall.class = null;
      await this.store.write(slice);
    }

    return this.store.transit(sliceId, 'RUN_START', actor);
  }

  /**
   * Resume a stalled slice.
   *
   * 三件事，顺序不能换（ADR-047）：
   *
   * 1. **退状态** —— `running` → `frozen`（`RUN_FINISH`）。
   *    只清停机分类是**半截修复**：切片仍卡在 `running`，而准入只认
   *    `frozen` / `completed` —— 于是 `zelto run` 仍然拒绝它，
   *    「可以重跑了」这句话是假的。历史切片（修复前留下的）正是这个状态，
   *    所以 resume 必须把状态一并迁走，不能只清分类。
   *
   *    已经在 `frozen` 的切片不动 —— 那本来就是可重跑的状态，
   *    硬转会撞「Invalid transition」。
   *
   * 2. **清停机分类** —— 「停机」这个结论到此结束。
   *
   * 3. **写 `run.resumed` 事件** —— 人做的决定要留痕（C4）。
   *
   * @param sliceId - The slice to resume
   * @param options - Resume options
   * @param options.skip - If true, mark the stall as resolved without re-execution
   * @param options.abandon - If true, abandon the slice instead of resuming
   * @param options.resetRetry - If true, reset the auto-retry budget
   *   (`stall.autoResolved`) back to 0 — see ADR-052
   */
  async resume(
    sliceId: string,
    options: { skip?: boolean; abandon?: boolean; resetRetry?: boolean },
  ): Promise<{ retryBudgetReset: boolean }> {
    const slice = await this.store.read(sliceId);

    // `--reset-retry` 独立于停机状态（ADR-052）。
    //
    // 为什么必须独立：预算重置的**时机**通常晚于 resume —— 人看到
    // 「重跑后第一次失败就停机」的警告时，切片已经 resume 过了，
    // 停机分类已经清掉。这时候再跑 `resume --reset-retry` 会撞上
    // 「not stalled」—— 建议给的是一条走不通的命令。
    //
    // 所以：带 `--reset-retry` 时，即使没有停机分类也允许执行；
    // 它做的只是把预算清零。
    if (slice.stall.class === null && !options.resetRetry) {
      throw new Error(`Slice "${sliceId}" is not stalled`);
    }

    if (options.abandon) {
      if (slice.stall.class === null) {
        throw new Error(`Slice "${sliceId}" is not stalled`);
      }
      await this.appendEvent(sliceId, 'run.resumed', 'zelto', {
        resolution: 'manual_abandon',
        previousStallClass: slice.stall.class,
      });
      await this.store.transit(sliceId, 'ABANDON');
      return { retryBudgetReset: false };
    }

    const resolution = options.skip ? 'manual_skip' : 'manual_retry';

    // 只有「恢复停机」才动状态。纯粹的重置预算不动状态 ——
    // 切片可能正跑着（人只是想把预算腾出来），把它退成 frozen 是副作用。
    const resumingStall = slice.stall.class !== null;

    // 先迁状态，再清分类。
    //
    // 顺序理由：`transit` 内部自己 read 一份最新快照再写回，
    // 所以「先清分类再迁移」也不会把分类弄丢 —— 但反过来（先迁移再清）
    // 更稳：迁移失败（状态被改过）时分类还在，切片仍标记为「待人处理」，
    // 不会变成「什么都没发生」。
    if (resumingStall && slice.state === 'running') {
      try {
        await this.store.transit(sliceId, 'RUN_FINISH', 'zelto');
        await this.appendEvent(sliceId, 'slice.state.changed', 'zelto', {
          sliceId, from: 'running', to: 'frozen', event: 'RUN_FINISH',
        });
      } catch {
        // 状态被别处改过 —— 不强改，分类照清，事件照写。
      }
    }

    if (resumingStall) {
      await this.appendEvent(sliceId, 'run.resumed', 'zelto', {
        resolution,
        previousStallClass: slice.stall.class,
      });
    }

    // Clear stall info for retry or skip.
    //
    // 必须**重新读一遍**再写：上面那次 `transit` 改了状态，
    // 而 `slice` 还是迁移前的那份快照 —— 直接写回去会把刚迁好的
    // 状态改回 `running`，正好把这次修复抵消掉。
    const current = await this.store.read(sliceId);
    if (resumingStall) {
      current.stall.class = null;
    }

    // 自动重试预算重置（ADR-052）——**只在人显式要求时**才做。
    //
    // 为什么需要它：`stall.autoResolved` 是切片级计数，只在自动重试时 +1，
    // resume 不清它。于是「环境故障 → 自动重试耗尽 → 停机 → 人修好环境 →
    // resume → run」之后，计数器还停在 maxRetries —— **第一次失败就直接停机**，
    // 再也不自动重试了。这在 ADR-047 修好「卡在 running」之前根本触发不了
    // （那时压根跑不了第二次），是那次修复顺带暴露出来的。
    //
    // 为什么必须显式而不能悄悄清：悄悄清 = 「重跑一次预算就无限」——
    // zelto 会对同一片同一个失败无限重试，那是真问题。预算是有限的，
    // 但**重置必须是人的动作**。
    let retryBudgetReset = false;
    if (options.resetRetry && current.stall.autoResolved > 0) {
      await this.appendEvent(sliceId, 'run.resumed', 'zelto', {
        resolution: 'retry_budget_reset',
        previousAutoResolved: current.stall.autoResolved,
      });
      current.stall.autoResolved = 0;
      retryBudgetReset = true;
    }

    await this.store.write(current);

    return { retryBudgetReset };
  }

  /**
   * Check write-set conflicts between multiple slices.
   * Returns pairs of indices (into writesList) that conflict.
   * Useful for parallel admission: verify no two slices write the same files.
   */
  checkConflicts(writesList: string[][]): Array<[number, number]> {
    const conflicts: Array<[number, number]> = [];
    for (let i = 0; i < writesList.length; i++) {
      for (let j = i + 1; j < writesList.length; j++) {
        if (this.hasOverlap(writesList[i], writesList[j])) {
          conflicts.push([i, j]);
        }
      }
    }
    return conflicts;
  }

  private hasOverlap(a: string[], b: string[]): boolean {
    return writeSetsOverlap(a, b);
  }

  private buildInstructions(
    slice: SliceData,
    affinity?: AffinityContext | null,
    gateCommands?: GateCommandSummary[],
  ): string {
    const lines = [
      `You are implementing slice "${slice.id}": ${slice.title}`,
      '',
      `## Spec`,
      `Read the spec at \`${slice.spec.path}\` (frozen at ${slice.spec.frozenHash ?? 'N/A'}).`,
      '',
      `## Write-set`,
      `You may only modify these paths:`,
      ...slice.writes.map((w) => `  - \`${w}\``),
      '',
      `## Protected paths (DO NOT MODIFY)`,
      `  - policy/`,
      `  - .zelto/`,
      `  - AGENTS.md`,
      `  - .cursor/rules/`,
      '',
      `## Acceptance tests`,
      `Run \`${slice.acceptance.dir}\` tests to verify your implementation.`,
      '',
    ];

    // 验收骨架要变成真断言（ADR-046）。
    //
    // 骨架里全是 `test.todo` —— 门禁②不认 todo（「todo 与 skip 不算
    // 验证」），所以骨架不改，这片就永远过不了门禁②。
    //
    // 骨架在写集里（`zelto spec draft` 时自动加入），所以 agent 改它
    // 不会被 hook 拦。但「在写集里」不等于「会去改」—— 指令不说，
    // agent 就可能只写实现、把骨架留成 todo，然后门禁②判 failed。
    const skeleton = acceptanceSkeletonInWriteSet(slice);
    if (skeleton) {
      lines.push(
        `The acceptance file \`${skeleton}\` contains only \`test.todo\` placeholders.`,
        `**Replace every \`test.todo\` with a real assertion** that actually checks`,
        `the behaviour described in its name. The gate rejects an acceptance file`,
        `where no test really ran — todos and skips do not count as verification.`,
        '',
      );
    }

    // 门禁命令原文（ADR-045）：agent 必须用同一套命令验证自己的产物。
    // 否则门禁②会在 agent 留下的现场上失败 —— 而失败的报错指向
    // 「环境不对」，不指向「产物不对」，白跑一轮。
    if (gateCommands && gateCommands.length > 0) {
      lines.push(
        `## How the gate will verify your work`,
        `The gate runs these commands, in this order, in this directory:`,
        '',
      );
      for (const cmd of gateCommands) {
        lines.push(`- \`${cmd.name}\`: \`${cmd.run}\``);
      }
      lines.push(
        '',
        `Use the **same** commands to verify your implementation. Do not reconfigure`,
        `the build tree with a different generator or a different binary directory —`,
        `the gate reuses the tree you leave behind, and a mismatched configuration`,
        `makes the gate fail for reasons that have nothing to do with your code.`,
        '',
      );
    }

    // 亲和上下文只是只读建议（C7）：前片做了什么、供参考，不参与任何判定
    if (affinity && affinity.summaries.length > 0) {
      lines.push(`## Related slices (read-only context, advisory only)`);
      lines.push(`Same affinity group \`${affinity.groupId}\` — earlier slices in this group:`);
      for (const s of affinity.summaries) {
        lines.push(`  - \`${s.sliceId}\`: ${s.summary}`);
      }
      lines.push(`Do NOT modify their files; follow your own frozen spec.`);
      lines.push('');
    }
    lines.push(
      `## Rules`,
      `1. Do not modify files outside your write-set.`,
      `2. Do not modify protected paths.`,
      `3. All code must trace back to the spec.`,
      `4. Run acceptance tests before declaring completion.`,
      '',
      QUESTION_INSTRUCTIONS,
    );
    return lines.join('\n');
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Event stream failure is non-fatal
    }
  }
}

// 续跑编排（ADR-086）
//
// `resume` 的判定本来就住在 core（`core/sched/engine.ts` 的 `Scheduler.resume`），
// 所以本模块是个**薄封装**：补上「结果分类」与「面向人的说明」。
//
// 为什么还要包一层：CLI 与 Web 要**同一份**「结果怎么说」。
// `Scheduler.resume` 返回 `{ retryBudgetReset }` ——
// 它没告诉调用方「这次到底做了什么」（是放弃了、跳过了、还是恢复重跑）。
//
// C3: 判定确定性 —— 委托给 Scheduler，本模块不另立判据。

import { Scheduler } from '../sched/engine.js';
import type { ArchGuardRule, PolicyConfig, PolicyRule } from '../policy/types.js';
import type { LifecycleContext, LifecycleOutcome } from './types.js';
import { fail, ok } from './types.js';

/** 续跑的选项。 */
export interface ResumeOptions {
  /** 标记停机已解决，但**不**重跑 */
  skip?: boolean;
  /** 直接放弃这片 */
  abandon?: boolean;
  /** 重置自动重试预算 */
  resetRetry?: boolean;
}

/**
 * 续跑一片停机的切片。
 *
 * 与 CLI `zelto resume` **同一份判定**（直接调 `Scheduler.resume`）。
 */
export async function resumeSlice(
  ctx: LifecycleContext,
  sliceId: string,
  options: ResumeOptions = {},
): Promise<LifecycleOutcome> {
  const { store, events, via } = ctx;

  // 策略是准入判定的一部分 —— `Scheduler` 要读它来判追溯准入。
  // 用 core 的 `loadPolicy`（不依赖 CLI 的 `loadPolicyConfig`）。
  const policyConfig = await buildPolicyConfig(ctx.repoRoot);

  const scheduler = new Scheduler(store, events, policyConfig);

  const before = await store.read(sliceId);
  const autoResolvedBefore = before.stall.autoResolved;

  try {
    // `via` 传进去 —— `Scheduler` 写的 `run.resumed` 事件里就带着它。
    //
    // **为什么不在这里补写第二条 `run.resumed`**：
    // 「人做的决定要留痕」（C4）不等于「同一次决定留两条痕」。
    // 补写会让「这片被续跑了几次」翻倍 —— 而 `rework_rate` 之类
    // 「事件条数 ÷ 门禁次数」的指标会被这个翻倍直接带偏。
    // `via` 是**同一条事件的第二个维度**（ADR-084 §4），不是第二条事件。
    const result = await scheduler.resume(sliceId, {
      skip: options.skip,
      abandon: options.abandon,
      resetRetry: options.resetRetry,
      via,
    });

    const after = await store.read(sliceId);

    const advisories: string[] = [];

    // 重试预算：说清楚人自己在重置什么。
    //
    // 「预算已重置」是这次动作**唯一**的效果，混在一堆话里容易被忽略。
    if (options.resetRetry) {
      advisories.push(
        result.retryBudgetReset
          ? `自动重试预算已重置（${autoResolvedBefore} → 0）—— 本次重跑会重新获得自动重试`
          : '自动重试预算本来就是 0，无需重置',
      );
    } else if (autoResolvedBefore > 0) {
      // 预算已用尽却不重置 —— 人重跑后会发现「第一次失败就停机」，
      // 而原因在这里。不说，等于让下一个 agent 轮次白跑。
      const maxRetries = await readMaxRetries(ctx.repoRoot);
      if (maxRetries !== null && autoResolvedBefore >= maxRetries) {
        advisories.push(
          `自动重试预算已用尽（${autoResolvedBefore}/${maxRetries}）—— 重跑后第一次失败就会停机`,
        );
        advisories.push(
          `修好问题后若要恢复自动重试：zelto resume ${sliceId} --reset-retry`,
        );
      }
    }

    if (options.abandon) {
      return ok('切片已放弃', { sliceId, state: after.state, resolution: 'manual_abandon' }, advisories);
    }
    if (options.skip) {
      return ok('停机已标记为解决（未重跑）', { sliceId, state: after.state, resolution: 'manual_skip' }, advisories);
    }
    if (before.stall.class !== null) {
      return ok('已恢复以便重跑', { sliceId, state: after.state, resolution: 'manual_retry' }, advisories);
    }
    // 没有停机可恢复、也没别的动作时，只报预算那一句就够了 ——
    // 说「已恢复以便重跑」是假话（它本来就没停机）。
    return ok('未执行状态变更', { sliceId, state: after.state, resolution: 'none' }, advisories);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`续跑失败：${message}`);
  }
}

/**
 * 构造 Scheduler 要的策略配置。
 *
 * 与 CLI 的 `loadPolicyConfig` 同口径：**没有项目策略就用兜底**，
 * 但兜底的 `source` 必须是 'fallback'（写集×策略判定只认 'project'）。
 */
async function buildPolicyConfig(repoRoot: string): Promise<PolicyConfig> {
  const { loadPolicy } = await import('../policy/data-access.js');
  const loaded = loadPolicy(repoRoot);
  if (loaded && loaded.rules.length > 0) {
    return {
      rules: loaded.rules as unknown as PolicyRule[],
      protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
      ...(loaded.arch ? { arch: loaded.arch as unknown as ArchGuardRule[] } : {}),
    };
  }
  return {
    rules: [
      {
        id: 'allow-src-ts',
        match: { path: 'src/**/*.ts', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-src-ts',
      },
      {
        id: 'allow-tests',
        match: { path: 'tests/**/*.ts', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-tests',
      },
    ],
    protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
  };
}

/**
 * 读配置里的 agent.maxRetries —— 用来判断「预算是否已用尽」。
 *
 * 读不到就返回 null（**不编一个默认值**）：
 * 「不知道上限」与「上限是 2」是两件事，前者不该让人以为预算用尽了。
 */
async function readMaxRetries(repoRoot: string): Promise<number | null> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const configPath = join(repoRoot, '.zelto', 'config.yaml');
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf-8');
    // 配置是 YAML —— 这里只取一个数字字段，不引第三方解析器（core 零依赖，C2）。
    // 用行扫描而不是完整 YAML 解析：只需要 agent.maxRetries 这一个值，
    // 而完整 YAML 解析会把 core 拖进第三方依赖。
    const lines = content.split(/\r?\n/);
    let inAgent = false;
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, '').trimEnd();
      if (/^agent:\s*$/.test(line)) {
        inAgent = true;
        continue;
      }
      if (inAgent) {
        if (/^\S/.test(line)) break; // 离开 agent: 段
        const m = /^\s+maxRetries:\s*(\d+)/.exec(line);
        if (m) return Number.parseInt(m[1]!, 10);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Shared utilities, types, and store instances for CLI commands

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LlmAdapter } from '../../core/ports/llm.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { DeepSeekAdapter } from '../../adapters/llm/index.js';
import { EventEmittingLlmAdapter, type PricingTable } from '../../adapters/llm/event-emitting-adapter.js';
import { ClaudeAgentAdapter } from '../../adapters/claude-agent/index.js';
import { ClaudeAgentSdkAdapter } from '../../adapters/claude-agent-sdk/index.js';
import { CursorAgentAdapter, DEFAULT_CURSOR_COMMAND } from '../../adapters/cursor-agent/index.js';
import { EventStream } from '../../core/events/stream.js';
import type { PolicyConfig, PolicyRule } from '../../core/policy/types.js';
import { parsePolicyYaml, stripSurroundingQuotes } from '../../core/policy/yaml.js';
import type { GateAcceptanceConfig } from '../../core/gate/types.js';
import { parseBlockScalarHeader, readBlockScalar } from '../../core/config/blocks.js';
import { SliceStore, checkSliceId } from '../../core/slice/store.js';
// ADR-086：规格哈希的**唯一实源**在 core —— CLI 与 Web 调同一份。
// 两份实现哪怕只差一个 `sha256:` 前缀，就会表现为「刚冻结完就报 hash mismatch」。
import { hashSpecFile as hashSpecFileCore } from '../../core/lifecycle/freeze.js';
import { WorktreeManager, type WorktreeInfo } from '../../core/worktree/index.js';
import {
  resolveSliceOwnership,
  versionBranchTip,
  checkVersionLabel,
} from '../../core/version/branch.js';
import { buildDeterministicSliceSpec } from '../../llm/generators/slice-spec.js';

// 策略解析的唯一实现在 core/policy/yaml.ts（ADR-014 §4）。
// 这里转出去是为了不破坏既有调用方。
export { parsePolicyYaml } from '../../core/policy/yaml.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const ZELTO_DIR = '.zelto';
export const SLICES_DIR = join(ZELTO_DIR, 'slices');
export const EVENTS_DIR = join(ZELTO_DIR, 'events');

// ─── Shared Instances ────────────────────────────────────────────────────────

export const store = new SliceStore(SLICES_DIR);
export const events = new EventStream(EVENTS_DIR);

// ─── Types ───────────────────────────────────────────────────────────────────

export type Command = (args: string[]) => Promise<number>;

// ─── Command Registry ────────────────────────────────────────────────────────

export const commands: Record<string, Command> = {};

export function register(name: string, fn: Command) {
  commands[name] = fn;
}

// ─── Policy Config ───────────────────────────────────────────────────────────

/**
 * 加载策略配置。
 *
 * **来源很重要** —— 调用方要区分「项目自己的策略」与「zelto 的兜底策略」：
 *
 * - 项目有 `policy/policy.yaml` → 用它，`source: 'project'`
 * - 项目没有 → 回落到 zelto 内置的兜底策略，`source: 'fallback'`
 *
 * 为什么必须区分：兜底策略是**给 zelto 自己（TypeScript 项目）**用的
 * （`src/` 与 `tests/` 下的 `.ts` 文件）。拿它去判一个 C++ 项目的写集
 * （`src/engine/src/foo.cpp`）会得出「不在任何允许规则覆盖范围内」——
 * **一个纯误判**：那个路径在项目自己的策略里很可能被允许，
 * 只是这个项目还没写策略而已。
 *
 * 所以：**阻断性判定只能用 `source: 'project'` 的策略**。
 * 兜底策略只够用来做「读总是允许」「保护域是什么」这类不依赖项目语义的判断。
 */
export interface LoadedPolicy extends PolicyConfig {
  /** 策略的来源：项目自己的 / zelto 兜底的 */
  source: 'project' | 'fallback';
}

export function loadPolicyConfig(root?: string): LoadedPolicy {
  const policyPath = join(root ?? process.cwd(), 'policy', 'policy.yaml');
  if (existsSync(policyPath)) {
    try {
      const content = readFileSync(policyPath, 'utf-8');
      const parsed = parsePolicyYaml(content);
      if (parsed.rules.length > 0) {
        return {
          rules: parsed.rules,
          protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
          ...(parsed.arch ? { arch: parsed.arch } : {}),
          source: 'project',
        };
      }
    } catch {
      // Fall through to defaults
    }
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
      {
        id: 'allow-read-all',
        match: { path: '**', operation: 'read' },
        action: 'allow',
        basis: 'policy.yaml#allow-read-all',
        priority: 0,
      },
      {
        id: 'allow-docs',
        match: { path: 'docs/**', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-docs',
      },
      {
        id: 'allow-config',
        match: { path: '.zelto/config.yaml', operation: 'write' },
        action: 'ask',
        basis: 'policy.yaml#allow-config',
      },
      {
        id: 'deny-acceptance-direct',
        match: { path: 'tests/acceptance/**', operation: 'write' },
        action: 'deny',
        basis: 'AGENTS.md#禁区-5',
        guidance: 'Acceptance tests are frozen with the spec.',
      },
    ],
    protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
    source: 'fallback',
  };
}

// ─── Spec Hash ───────────────────────────────────────────────────────────────

/**
 * 规格文件的哈希。
 *
 * **唯一实源在 `core/lifecycle/freeze.ts`** —— 那里的一份是**真源**，
 * 这里只是转发。
 *
 * 为什么必须只有一份：冻结时写进切片文件的哈希，与 `zelto check`
 * 算出来比对的哈希，**必须逐字节相同**。
 * 两份实现哪怕只差一个 `sha256:` 前缀，就会表现为
 * 「规格刚冻结完就报 hash mismatch」——
 * 而症状离病因很远，人会先去查规格、查 git、查 worktree，
 * 唯独想不到是两份实现的格式悄悄不一样。
 *
 * 这正是 ADR-086 §实施记录 2 记的那个坑（当时真的踩了）。
 */
export function hashSpecFile(specPath: string): string | null {
  return hashSpecFileCore(specPath);
}

// ─── Option Parsing ──────────────────────────────────────────────────────────

/**
 * 读取一个「带值选项」的值。
 *
 * 为什么需要这个（实测缺陷 D-2）：
 *
 *   `args.includes('--agent') ? args[args.indexOf('--agent') + 1] : fallback`
 *
 * 这种写法在 `--agent` 是**最后一个参数**时，`args[index + 1]` 是
 * `undefined` —— 值没给，却把 `undefined` 当成了「用户指定的值」传下去。
 * 后果是 `Agent: undefined` 被打印出来，`checkAgentAvailable(undefined)`
 * 拿着 undefined 去检查，而真正的兜底（配置里的默认 agent）根本没被用上。
 *
 * 演练里之所以没炸，是因为 `createExecutorAdapter` 对 undefined 又兜了一层
 * 回退到 `cfg.agent.command` —— **兜底掩盖了 bug**，征兆只剩日志里的
 * `Agent: undefined`。
 *
 * 本函数的口径：
 * - 选项不存在 → 返回 fallback
 * - 选项存在但**后面没有值** → 返回 fallback（并让调用方能识别出「值缺失」）
 * - 选项存在且有值 → 返回该值
 *
 * @param args 参数数组
 * @param name 选项名（如 `--agent`）
 * @param fallback 选项缺失时的回退值
 */
export function optionValue(
  args: string[],
  name: string,
  fallback: string,
): string {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const value = args[idx + 1];
  // 值缺失，或下一个 token 其实是另一个选项 → 当没给
  if (value === undefined || value.startsWith('--')) return fallback;
  return value;
}

/**
 * `optionValue` 的「严格」变体：选项给了但没值时返回 null。
 *
 * 用于「值缺失要报错」的场景 —— 比如 `--agent` 给了名字但后面是别的选项，
 * 人多半是想传名字，只是打漏了；这时静默回退到默认 agent 会让人以为
 * 自己指定生效了。
 */
export function optionValueStrict(
  args: string[],
  name: string,
): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

// ─── Config ──────────────────────────────────────────────────────────────────
// ADR-086：配置解析下沉到 core/config/loader.ts ——
// CLI 与 Web 读同一份配置（配置语义不许漂移）。
// 这里保留 re-export，CLI 侧所有 `from './shared.js'` 的调用点不用改。
export {
  expandConfigEnvRefs,
  loadConfig,
  loadConfigAt,
  parseConfigYaml,
  parseEnvRef,
  resolveApiKey,
  type ZeltoConfig,
} from '../../core/config/loader.js';

// shared.ts 自己也要用 loadConfig —— re-export 不产生本地绑定，
// 所以这里单独 import 一次（同一份实现，不会分叉）。
import { loadConfig } from '../../core/config/loader.js';

/**
 * Resolve the target project directory if configured.
 * Returns the absolute path to the target project root, or null if not configured.
 * When a target project is configured, this is the directory where gate commands
 * and spec operations should execute.
 */
export function resolveTargetDir(): string | null {
  const cfg = loadConfig();
  if (!cfg.targetProject?.path) return null;
  const resolved = resolve(process.cwd(), cfg.targetProject.path);
  return existsSync(resolved) ? resolved : null;
}

/**
 * Get the spec directory for the target project, or the default.
 * Returns the absolute path.
 */
export function resolveSpecDir(): string {
  const cfg = loadConfig();
  if (cfg.targetProject?.path) {
    const projectDir = resolve(process.cwd(), cfg.targetProject.path);
    const specDir = cfg.targetProject.specDir ?? 'specs/slices';
    return resolve(projectDir, specDir);
  }
  return resolve(process.cwd(), 'specs', 'slices');
}

// ─── 标识符校验（CLI 边界）─────────────────────────────────────────────────

/**
 * 校验版本 label，不合法就报错并返回 false。
 *
 * 为什么要有这道：版本 label 会进 `.zelto/version-worktrees/<label>/`，
 * 而 `join` 会把 `..` **归一化掉** —— 于是 `..` 能让工作目录落出 base。
 * core 层有兜底断言（`resolveWithin`），但那时人看到的已经是
 * 「路径逃逸：标识符 ".." 拼出的路径落在 ... 之外」——
 * 说清了机制，没说清「你该写什么」。
 *
 * 这里在**入口**就说清楚：label 只能是什么形状。
 */
export function validateVersionLabelArg(
  label: string,
  f: { error(code: string, message: string): void },
): boolean {
  const check = checkVersionLabel(label);
  if (check.valid) return true;
  f.error('INVALID_VERSION_LABEL', check.reason ?? `Invalid version label: "${label}"`);
  return false;
}

/**
 * 校验切片 id，不合法就报错并返回 false。
 *
 * 与 `validateVersionLabelArg` 同理：切片 id 会进
 * `.zelto/slices/<id>.json`、`specs/slices/<id>.md`、
 * `tests/acceptance/<id>/`、`.zelto/worktrees/<id>/`。
 */
export function validateSliceIdArg(
  id: string,
  f: { error(code: string, message: string): void },
): boolean {
  const check = checkSliceId(id);
  if (check.valid) return true;
  f.error('INVALID_SLICE_ID', check.reason ?? `Invalid slice ID: "${id}"`);
  return false;
}

// ─── Worktree Helpers ─────────────────────────────────────────────────────────

/**
 * Shared worktree manager rooted at the current working directory.
 * Path convention: `.zelto/worktrees/<sliceId>`, branch `slice/<sliceId>`.
 */
export function worktreeManager(): WorktreeManager {
  return new WorktreeManager(process.cwd());
}

/**
 * Return the absolute path of a slice's worktree if it exists, else null.
 * Used by gate / diff / merge paths that must operate inside the isolated directory.
 */
export function existingWorktreePath(sliceId: string): string | null {
  const manager = worktreeManager();
  return manager.exists(sliceId) ? manager.pathFor(sliceId) : null;
}

/**
 * Remove a slice's worktree and write a `worktree.removed` event (C4).
 * Never swallows errors — the caller decides how to report them.
 */
export async function removeWorktree(sliceId: string, options: { force?: boolean } = {}): Promise<void> {
  const manager = worktreeManager();
  await manager.remove(sliceId, options);
  await events.append(sliceId, 'worktree.removed', 'zelto', {
    sliceId,
    path: manager.relativePathFor(sliceId),
    branch: manager.branchFor(sliceId),
  });
}

/**
 * 切片的基点解析（ADR-067 D1）。
 *
 * 基点 = 「这片从哪里长出来的」。它决定了三件事：
 * 1. agent 在 worktree 里**能看到什么**（基点里没有的文件就是不存在）
 * 2. 写集审计的 diff 范围（基点..HEAD）
 * 3. 合并时 fast-forward 是否可用
 *
 * 解析顺序（与 ADR-056 §3.2 的归属解析同一优先级）：
 * 1. `override` —— 调用方显式指定（版本流水线算好了版本分支 tip）
 * 2. `pinned` —— 切片文件里已钉死的基点（ADR-041 §3.2 的可复现保证）
 * 3. `version-branch` —— 归属版本分支的 tip
 * 4. `head` —— 主干 HEAD（兜底）
 *
 * 第 2 条不能省：切片跑过一次之后基点就不再重算，否则重跑同一个切片
 * 会回到不同的基点，审计范围漂移、越界判据不稳定。
 *
 * 归属解析失败（命中多个版本计划）**不阻塞** —— 退回主干 HEAD 并
 * 由调用方写事件说明（D2）。基点解析发生在建 worktree 时，
 * 那时还没有「归属歧义」的报错路径。
 */
export type BaseCommitSource = 'override' | 'pinned' | 'version-branch' | 'head';

export interface ResolvedBaseCommit {
  commit: string | null;
  source: BaseCommitSource;
  /** 归属的版本 label（source === 'version-branch' 时有值） */
  version: string | null;
  /** 归属歧义等降级原因（供事件留痕） */
  note: string | null;
}

export function resolveSliceBaseCommit(
  sliceId: string,
  sliceBaseCommit: string | null,
  options: {
    override?: string | null;
    repoRoot?: string;
    versionsDir?: string;
    specPath?: string | null;
  } = {},
): ResolvedBaseCommit {
  // 1. 显式覆盖
  if (options.override) {
    return { commit: options.override, source: 'override', version: null, note: null };
  }

  // 2. 已钉死的基点 —— 可复现优先
  if (sliceBaseCommit) {
    return { commit: sliceBaseCommit, source: 'pinned', version: null, note: null };
  }

  const repoRoot = options.repoRoot ?? process.cwd();
  const versionsDir = options.versionsDir ?? join(ZELTO_DIR, 'versions');

  // 3. 归属版本分支的 tip
  try {
    const ownership = resolveSliceOwnership(sliceId, {
      versionsDir,
      specPath: options.specPath ?? null,
    });
    if (ownership.kind === 'version') {
      const tip = versionBranchTip(ownership.branch, repoRoot, gitRefCommit);
      if (tip) {
        return { commit: tip, source: 'version-branch', version: ownership.version, note: null };
      }
      // 版本分支还不存在 —— 退回主干 HEAD，但说清楚原因
      return {
        commit: null,
        source: 'head',
        version: ownership.version,
        note: `版本分支 ${ownership.branch} 不存在，基点退回主干 HEAD`,
      };
    }
  } catch (err) {
    // 归属歧义 —— 不阻塞执行（D2），退回主干 HEAD 并留痕
    const message = err instanceof Error ? err.message : String(err);
    return {
      commit: null,
      source: 'head',
      version: null,
      note: `归属解析失败（${message}），基点退回主干 HEAD`,
    };
  }

  // 4. 兜底：主干 HEAD
  return { commit: null, source: 'head', version: null, note: null };
}

/**
 * 取一个 ref 的 commit 号（用于版本分支 tip）。
 * 分支不存在时返回 null —— 调用方据此决定降级。
 */
function gitRefCommit(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * Create (or reuse) the isolated worktree for a slice.
 *
 * Returns null when the current directory is not inside a git repository —
 * worktree isolation is then impossible, and the caller degrades to running
 * in the current directory (same behaviour as before isolation existed).
 *
 * Emits a `worktree.created` event (C4) when a new worktree is created.
 *
 * @param id 切片 id
 * @param options.baseCommitOverride 基点覆盖（ADR-056 §3.3）。
 *   版本里的切片基点来自**版本分支的 tip**，而不是主仓 HEAD ——
 *   否则同版本的切片看不到本版本其它切片的改动。
 *   传 null 表示不覆盖（用切片文件里已有的基点）。
 */
export async function ensureWorktree(
  id: string,
  options: { baseCommitOverride?: string | null } = {},
): Promise<WorktreeInfo | null> {
  const manager = worktreeManager();
  if (!manager.isGitRepo()) return null;

  const slice = await store.read(id);

  const existed = manager.exists(id);

  // 基点解析（ADR-067 D1）：显式覆盖 → 已钉死 → 归属版本分支 tip → 主干 HEAD。
  //
  // 第 3 条是本 ADR 的核心：**单片路径也必须知道自己属于哪个版本**。
  // 不解析归属的话，同版本的第二片会从主干 HEAD 建 worktree，
  // 看不到前一片的产物 —— agent 被迫重新实现上一片（实测 D-28）。
  const base = resolveSliceBaseCommit(id, slice.baseCommit, {
    override: options.baseCommitOverride ?? null,
    repoRoot: process.cwd(),
    specPath: slice.spec.path,
  });

  if (base.note) {
    await events.append(id, 'worktree.base_resolved', 'zelto', {
      sliceId: id,
      source: base.source,
      version: base.version,
      note: base.note,
    });
  }

  const info = await manager.create(id, {
    baseCommit: base.commit ?? slice.baseCommit ?? null,
    specPath: slice.spec.path,
    acceptanceDir: slice.acceptance.dir,
  });

  // 基点回写（ADR-041 §3.2）：worktree 管理器知道基点是谁，但没人把它记下来。
  // `baseCommit` 为 null 时合并守卫的「基点漂移就拦合并」判据形同虚设。
  if (slice.baseCommit === null && info.baseCommit) {
    slice.baseCommit = info.baseCommit;
    await store.write(slice);
  }

  if (!existed) {
    await events.append(id, 'worktree.created', 'zelto', {
      sliceId: id,
      path: info.relativePath,
      branch: info.branch,
      baseCommit: info.baseCommit,
      kind: 'slice',
    });
  }

  // ── 规格副本对齐校验（D-47 的硬闸门）───────────────────────────────
  //
  // 为什么同步完了还要再校验一次：
  //
  //   同步动作本身可能没跑（老版本二进制、路径写错、copy 抛错被吞），
  //   而**判据分裂的后果极重**：门禁按主仓的新规格判，agent 按 worktree 里的
  //   旧规格干 —— 拦住的是「实现的是另一个需求」，不是「实现有 bug」。
  //
  //   实测（nimrtc-zelto v2-ai-decision，2026-11-17）：
  //     主仓规格 = 9 条验收标准（partial / barge_in / agent-control / framed /
  //              IASR / ILLM …）
  //     worktree 里的副本 = 4 条（LLM 草稿：延迟 <50ms / 准确率 ≥90% / 3 种策略 / 日志）
  //     → agent 老老实实实现了那 4 条
  //     → 门禁按 9 条判 → 判定分裂，两边都「正常工作」
  //
  // 所以：**起跑前**必须确认 worktree 里的规格副本与主仓真源一致。
  // 不一致 → 直接拦下，不让 agent 拿着旧规格去干活。
  const specSync = verifyWorktreeSpecSync(id, info.path, slice.spec.path, slice.spec.frozenHash);
  if (!specSync.ok) {
    await events.append(id, 'slice.drift_detected', 'zelto', {
      sliceId: id,
      expectedHash: slice.spec.frozenHash,
      actualHash: specSync.worktreeHash,
      reason: specSync.reason,
      scope: 'worktree-spec-copy',
    });
    throw new Error(
      `worktree 里的规格副本与主仓真源不一致 —— 拒绝起跑。\n` +
      `  ${specSync.reason}\n` +
      `  主仓：${slice.spec.path}\n` +
      `  worktree：${info.relativePath}/${slice.spec.path}\n` +
      `  修法：删掉 worktree 目录（zelto 会在下次起跑时重建并同步），` +
      `或确认二进制是最新构建。`,
    );
  }

  return info;
}

/**
 * 校验 worktree 里的规格副本与主仓真源是否一致（D-47）。
 *
 * 判据：**内容哈希**相同。不比大小、不比时间戳 ——
 * 时间戳会被 git checkout 改、会被复制改，只有内容哈希是判据本身。
 *
 * @param frozenHash 冻结时的哈希；主仓规格漂移（人改过规格但没重冻）
 *   由门禁①另行报，这里**不**重复报 —— 两件事、两处出口。
 */
export function verifyWorktreeSpecSync(
  sliceId: string,
  worktreePath: string,
  specPath: string,
  frozenHash: string | null,
): { ok: boolean; worktreeHash: string | null; reason: string } {
  const sourcePath = join(process.cwd(), specPath);
  const destPath = join(worktreePath, specPath);

  if (!existsSync(sourcePath)) {
    return { ok: true, worktreeHash: null, reason: '主仓没有规格文件 —— 无从比对' };
  }
  if (!existsSync(destPath)) {
    return {
      ok: false,
      worktreeHash: null,
      reason: `worktree 里没有规格副本（${specPath}）—— agent 会拿不到规格`,
    };
  }

  const sourceHash = hashSpecFile(specPath);
  const destHash = hashSpecFile(join(worktreePath, specPath));
  if (sourceHash === null || destHash === null) {
    return { ok: false, worktreeHash: destHash, reason: '规格副本无法读取，无法比对' };
  }
  if (sourceHash === destHash) {
    return { ok: true, worktreeHash: destHash, reason: '规格副本与主仓真源一致' };
  }

  return {
    ok: false,
    worktreeHash: destHash,
    reason:
      `worktree 里的规格副本是旧版（主仓 ${sourceHash.slice(0, 12)}… / ` +
      `worktree ${destHash.slice(0, 12)}…）—— agent 会照旧规格干活` +
      (frozenHash ? `（冻结哈希 ${frozenHash.slice(0, 12)}…）` : ''),
  };
}

// ─── Policy YAML Parser ─────────────────────────────────────────────────────
// 实现已收敛到 core/policy/yaml.ts；此处保留转出以兼容既有调用方。

// ─── LLM Helper ──────────────────────────────────────────────────────────────

export function createLlmFromConfig(
  sliceId?: string,
  actor?: string,
): LlmAdapter | null {
  const cfg = loadConfig();
  if (!cfg.llm?.apiKey) return null;
  const adapter: LlmAdapter = new DeepSeekAdapter({
    apiKey: cfg.llm.apiKey,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model ?? 'deepseek-chat',
  });

  // Wrap with event-emitting adapter if tracking context is provided
  if (sliceId && actor) {
    const pricing = cfg.llm.pricing as PricingTable | undefined;
    return new EventEmittingLlmAdapter(adapter, events, sliceId, actor, pricing);
  }

  return adapter;
}

// ─── Executor Adapter Factory ──────────────────────────────────────────────

export type AdapterType = 'claude-agent' | 'claude-agent-sdk' | 'cursor-agent';

/**
 * 某个 adapter 对应的 **hook harness**。
 *
 * adapter 决定「谁在跑 agent」，harness 决定「agent 的钩子协议长什么样」。
 * 两者一一对应：Cursor CLI 用 `preToolUse` + `permission` 信封，
 * Claude Code 用 `PreToolUse` + `hookSpecificOutput`。
 *
 * 配错的后果是**静默失效**：hook 收到自己看不懂的信封，
 * 解析失败 → 判不了 → 要么全部拒绝（agent 完全不能动），
 * 要么在 Cursor 的 fail-open 默认下全部放行（闸门形同虚设）。
 * 所以这里用一张显式的表，而不是到处写 if。
 */
export function harnessForAdapter(
  adapterType: string | undefined,
): 'claude-code' | 'cursor' | 'codex' {
  switch (adapterType) {
    case 'cursor-agent':
      return 'cursor';
    case 'codex':
      return 'codex';
    default:
      return 'claude-code';
  }
}

/**
 * 解析某个 adapter 要用的 agent 命令。
 *
 * 优先级：**显式覆盖 > adapter 默认值 > 配置里的 command**。
 *
 * 注意 Cursor 的默认命令是 `cursor-agent` —— 配置里的 `agent.command`
 * 默认是 `npx claude-code`，那是给 Claude 用的；
 * 直接复用的话，切到 Cursor 后会起一个 claude 进程，
 * 表面上「适配器是 Cursor」，实际跑的还是 Claude。
 */
export function resolveAgentCommand(
  adapterType: string | undefined,
  override: string | undefined,
  cfg: { agent: { command: string } },
): string {
  if (override && override.trim()) return override.trim();
  if (adapterType === 'cursor-agent') return DEFAULT_CURSOR_COMMAND;
  return cfg.agent.command;
}

/**
 * 把 `agent.env` 合并进当前进程环境（ADR-090）。
 *
 * 优先级：`process.env` < `agent.env`。
 * 空对象直接返回 `process.env`，避免无谓的拷贝。
 */
export function mergeAgentEnv(
  agentEnv: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!agentEnv || Object.keys(agentEnv).length === 0) return base;
  return { ...base, ...agentEnv };
}

/**
 * 算出 Cursor CLI 要用的网关参数（ADR-090）。
 *
 * 三种凭证方式在这里归一：
 *   1. `agent.cursor.endpoint` → `--endpoint`
 *   2. `agent.cursor.apiKeyEnv` 指向的**环境变量**取到的值 → `--api-key`
 *   3. 都没配 → 返回 `{}`，完全交给 CLI 自己的登录态
 *
 * 为什么 apiKey 只从环境变量读、不从配置读：
 * 配置文件是要进版本库的，密钥不能进（同 ADR-022）。
 *
 * 为什么不回退到 `CURSOR_API_ENDPOINT` / `CURSOR_API_KEY`：
 * 那两个是 **cursor-agent 自己**认的环境变量，CLI 会自己读 ——
 * zelto 再读一遍转成旗标反而会**覆盖**用户 shell 里的设置，
 * 制造「配了个空值把有值的都盖掉了」这种 bug。
 * zelto 只在用户**显式**配置时才介入（见 ADR-090 §3 优先级表）。
 */
export function resolveCursorGateway(
  cursor: { endpoint?: string; apiKeyEnv?: string } | undefined,
  agentEnv: Record<string, string> | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { endpoint?: string; apiKey?: string } {
  const out: { endpoint?: string; apiKey?: string } = {};

  const endpoint = cursor?.endpoint?.trim();
  if (endpoint) out.endpoint = endpoint;

  const keyVar = cursor?.apiKeyEnv?.trim();
  if (keyVar) {
    // agent.env 优先于 process.env —— 与 mergeAgentEnv 的覆盖方向一致。
    const value = agentEnv?.[keyVar] ?? baseEnv[keyVar];
    if (typeof value === 'string' && value.trim()) out.apiKey = value.trim();
  }

  return out;
}

/**
 * Create an executor adapter based on config and optional override.
 * @param overrideType — Optional override from CLI --adapter flag
 * @param agentCommand — Agent command string (for claude-agent adapter)
 * @param timeoutSec — Optional agent timeout in seconds (from slice or config)
 * @param cwd — Optional working directory (e.g. an isolated worktree). Defaults to process.cwd().
 */
export function createExecutorAdapter(
  overrideType?: string,
  agentCommand?: string,
  timeoutSec?: number,
  cwd?: string,
): ExecutorAdapter {
  const cfg = loadConfig();
  const type = (overrideType ?? cfg.agent.adapter ?? 'claude-agent') as AdapterType;
  const timeoutMs = (timeoutSec ?? cfg.agent.timeout ?? 900) * 1000;
  const workDir = cwd ?? process.cwd();

  if (type === 'cursor-agent') {
    return new CursorAgentAdapter({
      cwd: workDir,
      agentCommand: resolveAgentCommand(type, agentCommand, cfg),
      timeoutMs,
      maxRetries: cfg.agent.maxRetries ?? 2,
      // ADR-090：凭证/网关透传。用户用哪种方式（本地登录 / API key /
      // 自建端点）由配置决定，适配器不关心。
      env: mergeAgentEnv(cfg.agent.env),
      gateway: resolveCursorGateway(cfg.agent.cursor, cfg.agent.env, process.env),
    });
  }

  if (type === 'claude-agent-sdk') {
    return new ClaudeAgentSdkAdapter({
      cwd: workDir,
      model: cfg.llm?.model,
      // ADR-090：`agent.env` 对所有适配器生效 —— 这样「把凭证放配置里」
      // 这条规则不会变成「只有 Cursor 能这么干」的特例。
      env: mergeAgentEnv(cfg.agent.env) as Record<string, string>,
    });
  }

  // Default: claude-agent (shell spawn)
  return new ClaudeAgentAdapter({
    cwd: workDir,
    agentCommand: resolveAgentCommand(type, agentCommand, cfg),
    timeoutMs,
    env: mergeAgentEnv(cfg.agent.env),
  });
}

// ─── Slice Spec Generator ────────────────────────────────────────────────────

/**
 * 生成一份切片规格正文（**确定性降级路径**）。
 *
 * 内容的唯一实现在 `src/llm/generators/slice-spec.ts`（ADR-034）。
 * 这里的薄壳保留是为了兼容既有调用方与测试。
 *
 * 注意：这条路径产出的规格**不含任何自造的验收标准** —— 没有已批准的
 * 需求条目时，验收标准章节只留占位说明（不写编号条目）。
 * 写了编号条目就会被物化成本片的需求追溯，于是「追溯合格」变成
 * zelto 替人批准的需求（ADR-032 §4 方案四）。
 */
export function generateSliceSpecContent(
  sliceId: string,
  title: string,
  module: string,
  writes: string[],
  version: string,
): string {
  return buildDeterministicSliceSpec({
    sliceId,
    title,
    module,
    writes,
    version,
    requirements: [],
    prerequisites: [],
  });
}

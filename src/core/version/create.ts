// 从一份**明确的切片清单**确定性建一个版本 —— 不经 LLM
//
// 为什么需要它：
//
//   `zelto plan add-version` 走 LLM：给它一段自然语言描述，它**生成**
//   版本号、依赖、切片清单与写集。对「计划里还没有这一版」的场景合适，
//   但它有一个结构性问题 —— **一个请求只能建一个版本，而且建出来的
//   切片清单人没法事先钉死**。
//
//   实测（2026-11-25，nimrtc-v14 的 v1.4.x 补齐）：13 个待做项要按
//   「写哪个文件」分波（模块内 → engine.hpp → CI/样例），每一波的
//   切片清单、写集、依赖都是**从 git 现场逐项核实出来**的、可以逐字
//   钉死的 —— 让模型再「创作」一遍只会引入漂移。
//
//   于是只剩两条路：调 LLM 三次（每次八百字描述，还得逐个核对它编的
//   写集），或者手改 `.zelto/versions/<id>.json`。手改是**追溯链上的
//   谎言**（C4：文件变了、事件流里没有记录）。
//
// 所以这里做**确定性**的建版本：
//   - 版本号 / 依赖 / 描述 / 每个切片的 id / 标题 / 模块 / 写集 / 规格路径
//     全部由调用方给出；
//   - 只做**校验**（版本号格式、重复、依赖必须已存在且不成环）与
//     **归一化**（写集去重、缺省规格路径）；
//   - 不猜、不补、不改别的版本。
//
// C1: 状态只在文件里（本函数不写盘，写盘与事件由调用方负责）
// C3: 纯计算，不调模型、不触网

import type { VersionPlan, Version, VersionSlice, VersionStatus } from './types.js';
import { normalizeWriteSet } from './patch.js';
import { isValidVersionLabel } from './branch.js';

/** 一个要建的切片（调用方给出的**全部**字段，不做任何补全猜测）。 */
export interface NewVersionSlice {
  id: string;
  title: string;
  module: string;
  /** 写集（glob 或具体路径）—— 会被去重、统一正斜杠 */
  writes: string[];
  /** 规格路径；缺省 `specs/slices/<id>.md` */
  specPath?: string;
}

/** 一个要建的版本。 */
export interface NewVersionSpec {
  /** 版本 label（`v1` / `v4` …） */
  version: string;
  /** 依赖的前置版本（必须已存在于计划里，且不能成环） */
  dependsOn?: string[];
  description: string;
  slices: NewVersionSlice[];
  /** 缺省 `planned` —— 与 `add-version` 一致，只有 planned 能被 `version start` 启动 */
  status?: VersionStatus;
  /** 版本集成测试目录；缺省 `tests/version/<version>` */
  integrationTestDir?: string;
}

/** 建版本失败的原因 —— 每一条都点名具体是什么、该怎么修。 */
export interface CreateVersionProblem {
  kind:
    | 'invalid-label'
    | 'duplicate-version'
    | 'invalid-dep'
    | 'missing-dep'
    | 'cycle'
    | 'duplicate-slice'
    | 'empty-slices'
    | 'invalid-slice';
  message: string;
}

export interface CreateVersionResult {
  /** 建好之后的计划（**不改入参**） */
  plan: VersionPlan;
  /** 新建的版本（校验失败时为 null） */
  version: Version | null;
  problems: CreateVersionProblem[];
}

/**
 * 切片 id 的字符集：小写字母 / 数字，词之间用 `-`。
 *
 * 不放宽：切片 id 会进 `.zelto/slices/<id>.json`、`.zelto/worktrees/<id>/`
 * 与规格路径 `specs/slices/<id>.md`，三个地方都按「一段安全的路径」用。
 */
const SLICE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 校验依赖图里有没有环（新建的这一版参与的环）。
 *
 * 判据是「从新版本出发、沿 dependsOn 走，能不能回到自己」。
 * 已有的版本之间存在环不在本函数的职责里（那是计划本身的病，
 * `applyPlanPatch` 与 `version start` 各自会暴露）—— 这里只保证
 * **不引入新的环**。
 */
function introducesCycle(plan: VersionPlan, spec: NewVersionSpec): string[] | null {
  const deps = new Map<string, string[]>();
  for (const v of plan.versions) deps.set(v.version, v.dependsOn ?? []);
  deps.set(spec.version, spec.dependsOn ?? []);

  const path: string[] = [];
  const seen = new Set<string>();
  const walk = (node: string): string[] | null => {
    if (seen.has(node)) return null;
    if (path.includes(node)) return [...path.slice(path.indexOf(node)), node];
    path.push(node);
    for (const d of deps.get(node) ?? []) {
      const hit = walk(d);
      if (hit) return hit;
    }
    path.pop();
    seen.add(node);
    return null;
  };
  return walk(spec.version);
}

/**
 * 往计划里加一个新版本。
 *
 * **不改入参** —— 返回一份新的计划对象（与 `applyPlanPatch` 同口径）。
 *
 * 调用方负责：确认计划已确认、把返回的 `plan` 落盘、写 append-only 事件
 * （C4）。本函数只做纯计算（C3）。
 */
export function createVersion(plan: VersionPlan, spec: NewVersionSpec): CreateVersionResult {
  const problems: CreateVersionProblem[] = [];

  // label 的判据与版本分支、版本集成目录**同一份**（isValidVersionLabel）——
  // 在 core 里另立一条正则的后果是「计划建得出来、version start 建不出目录」。
  if (!isValidVersionLabel(spec.version)) {
    problems.push({
      kind: 'invalid-label',
      message: `版本 label "${spec.version}" 不合法 —— 只允许字母、数字、点、下划线、连字符（且不能是 . / ..），与 version start 同一口径。`,
    });
  }
  if (plan.versions.some((v) => v.version === spec.version)) {
    problems.push({
      kind: 'duplicate-version',
      message: `版本 "${spec.version}" 已存在于计划 "${plan.id}" —— 改已有版本用 zelto plan patch。`,
    });
  }

  const existing = new Set(plan.versions.map((v) => v.version));
  for (const dep of spec.dependsOn ?? []) {
    if (!isValidVersionLabel(dep)) {
      problems.push({ kind: 'invalid-dep', message: `依赖 "${dep}" 不是合法版本 label。` });
      continue;
    }
    if (!existing.has(dep)) {
      problems.push({
        kind: 'missing-dep',
        message: `依赖 "${dep}" 不在计划里 —— 前置版本必须先建出来（否则 version start 会因依赖未 integrated 而拦下）。`,
      });
    }
  }

  const cycle = introducesCycle(plan, spec);
  if (cycle) {
    problems.push({ kind: 'cycle', message: `依赖成环：${cycle.join(' → ')}` });
  }

  if (spec.slices.length === 0) {
    problems.push({ kind: 'empty-slices', message: `版本 "${spec.version}" 没有切片 —— 空版本没有可执行的东西。` });
  }

  // 切片 id 的重复检查：计划内**全局**唯一（resolveSliceOwnership 靠它消歧）
  const allSliceIds = new Set<string>();
  for (const v of plan.versions) for (const s of v.slices) allSliceIds.add(s.id);

  const seenInVersion = new Set<string>();
  const slices: VersionSlice[] = [];
  for (const s of spec.slices) {
    if (!SLICE_ID_RE.test(s.id)) {
      problems.push({
        kind: 'invalid-slice',
        message: `切片 id "${s.id}" 不合法 —— 小写字母/数字，词之间用 "-"。`,
      });
      continue;
    }
    if (seenInVersion.has(s.id)) {
      problems.push({ kind: 'duplicate-slice', message: `切片 "${s.id}" 在本版本里出现了两次。` });
      continue;
    }
    if (allSliceIds.has(s.id)) {
      problems.push({
        kind: 'duplicate-slice',
        message: `切片 "${s.id}" 已在计划的另一个版本里 —— 同一 id 出现在两版会让合并归属歧义（AmbiguousOwnershipError）。`,
      });
      continue;
    }
    seenInVersion.add(s.id);
    slices.push({
      id: s.id,
      module: s.module,
      title: s.title,
      writes: normalizeWriteSet(s.writes),
      specPath: s.specPath ?? `specs/slices/${s.id}.md`,
      state: 'draft',
    });
  }

  if (problems.length > 0) {
    return { plan, version: null, problems };
  }

  const version: Version = {
    version: spec.version,
    dependsOn: [...(spec.dependsOn ?? [])],
    description: spec.description,
    slices,
    integrationTestDir: spec.integrationTestDir ?? `tests/version/${spec.version}`,
    status: spec.status ?? 'planned',
  };

  const next: VersionPlan = JSON.parse(JSON.stringify(plan)) as VersionPlan;
  next.versions.push(version);
  return { plan: next, version, problems: [] };
}

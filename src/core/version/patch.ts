// 版本计划的**确定性修正** —— 不经 LLM
//
// ADR-063 的设计（`core/design/patch.ts`）在版本计划这一层的对应物。
//
// 为什么需要它：
//
//   `zelto plan add-version` 走 LLM，而且只能**加整个版本**。
//   于是「计划已确认之后，改一个切片的写集 / 加一个切片 / 拆一个版本」
//   这三件事都走不通 —— 唯一的办法是手改 `.zelto/versions/<id>.json`。
//
//   手改状态文件是**追溯链上的谎言**：文件变了，事件流里没有记录；
//   谁改的、为什么改、原来是什么，全都查不到（C4 要求每个动作写事件）。
//   而且 `body`/`modules` 那类「真源 vs 缓存」的分叉，
//   在版本计划里同样存在（切片的 `writes` 与 `.zelto/slices/<id>.json` 里的
//   `writes` 必须一致，否则 `version start` 建出来的切片写集是错的）。
//
// 所以这里做**确定性**的修正：
//   - 只改人明确指定的字段（写集 / 标题 / 模块 / 规格路径 / 依赖）
//   - 只改人明确指定的那一处（版本 / 切片）
//   - 改完仍然要人确认（改的是已确认的计划）
//
// **不经 LLM 的理由**与设计补丁一样：LLM 会「顺手」改别的东西。
// 修正一个写集，结果它把三个切片的范围也重写了 —— 那不是修正，是创作，
// 而创作需要人重新从头确认。
//
// C1: 状态只在文件里；C3: 纯计算，不调模型、不触网；
// C4: 每次修正写 append-only 事件（由 CLI 层负责）。

import type { VersionPlan, Version, VersionSlice } from './types.js';

/** 一处要改的地方：某个版本里的某个切片 */
export interface SlicePatch {
  /** 切片 id（已存在的切片用） */
  sliceId?: string;
  /** 新的写集（不传 = 不改写集） */
  writes?: string[];
  /** 新标题 */
  title?: string;
  /** 新模块归属 */
  module?: string;
  /** 新规格路径 */
  specPath?: string;
}

/** 一个版本层面的修正 */
export interface VersionPatch {
  /** 版本 label */
  version: string;
  /** 这个版本要加的切片 */
  addSlices?: VersionSlice[];
  /** 这个版本要移除的切片 id */
  removeSlices?: string[];
  /** 逐个切片的修正 */
  slices?: SlicePatch[];
  /** 新描述 */
  description?: string;
  /** 新的依赖版本列表 */
  dependsOn?: string[];
  /** 新的版本状态 */
  status?: Version['status'];
}

/** 一次计划修正 */
export interface PlanPatch {
  /** 逐个版本的修正 */
  versions: VersionPatch[];
}

/** 修正结果 */
export interface PlanPatchResult {
  /** 修正后的计划（不改动入参） */
  plan: VersionPlan;
  /** 实际改了哪些字段（给人看） */
  changed: Array<{
    version: string;
    slice: string | null;
    field: string;
    before: string | string[];
    after: string | string[];
  }>;
  /** 找不到的版本 */
  missingVersions: string[];
  /** 找不到的切片 */
  missingSlices: string[];
}

/** 写集归一化：统一正斜杠、去重、去空白（ADR-051 配套）。 */
export function normalizeWriteSet(writes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of writes) {
    const p = raw.trim().replace(/\\/g, '/');
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * 对版本计划应用一批修正。
 *
 * **不改入参** —— 返回一份新的计划对象。
 */
export function applyPlanPatch(plan: VersionPlan, patch: PlanPatch): PlanPatchResult {
  const next: VersionPlan = JSON.parse(JSON.stringify(plan)) as VersionPlan;
  const changed: PlanPatchResult['changed'] = [];
  const missingVersions: string[] = [];
  const missingSlices: string[] = [];

  for (const vPatch of patch.versions) {
    const version = next.versions.find((v) => v.version === vPatch.version);
    if (!version) {
      missingVersions.push(vPatch.version);
      continue;
    }

    // ── 版本层面的字段 ──
    if (vPatch.description !== undefined && version.description !== vPatch.description) {
      changed.push({
        version: vPatch.version,
        slice: null,
        field: 'description',
        before: version.description,
        after: vPatch.description,
      });
      version.description = vPatch.description;
    }

    if (vPatch.dependsOn !== undefined) {
      const before = version.dependsOn.join(', ');
      const after = vPatch.dependsOn.join(', ');
      if (before !== after) {
        changed.push({
          version: vPatch.version,
          slice: null,
          field: 'dependsOn',
          before,
          after,
        });
        version.dependsOn = [...vPatch.dependsOn];
      }
    }

    if (vPatch.status !== undefined && version.status !== vPatch.status) {
      changed.push({
        version: vPatch.version,
        slice: null,
        field: 'status',
        before: version.status,
        after: vPatch.status,
      });
      version.status = vPatch.status;
    }

    // ── 加切片 ──
    for (const add of vPatch.addSlices ?? []) {
      if (version.slices.some((s) => s.id === add.id)) {
        // 已存在 → 不重复加（改用 slices 里的逐片修正）
        continue;
      }
      version.slices.push({
        ...add,
        writes: normalizeWriteSet(add.writes),
      });
      changed.push({
        version: vPatch.version,
        slice: add.id,
        field: 'added',
        before: '(不存在)',
        after: add.title,
      });
    }

    // ── 移除切片 ──
    for (const removeId of vPatch.removeSlices ?? []) {
      const idx = version.slices.findIndex((s) => s.id === removeId);
      if (idx === -1) {
        missingSlices.push(`${vPatch.version}/${removeId}`);
        continue;
      }
      const [removed] = version.slices.splice(idx, 1);
      changed.push({
        version: vPatch.version,
        slice: removeId,
        field: 'removed',
        before: removed.title,
        after: '(已移除)',
      });
    }

    // ── 逐片修正 ──
    for (const sPatch of vPatch.slices ?? []) {
      if (!sPatch.sliceId) continue;
      const target = version.slices.find((s) => s.id === sPatch.sliceId);
      if (!target) {
        missingSlices.push(`${vPatch.version}/${sPatch.sliceId}`);
        continue;
      }

      if (sPatch.writes !== undefined) {
        const before = target.writes.join(', ');
        const after = normalizeWriteSet(sPatch.writes);
        target.writes = after;
        changed.push({
          version: vPatch.version,
          slice: target.id,
          field: 'writes',
          before,
          after: after.join(', '),
        });
      }

      if (sPatch.title !== undefined && target.title !== sPatch.title) {
        changed.push({
          version: vPatch.version,
          slice: target.id,
          field: 'title',
          before: target.title,
          after: sPatch.title,
        });
        target.title = sPatch.title;
      }

      if (sPatch.module !== undefined && target.module !== sPatch.module) {
        changed.push({
          version: vPatch.version,
          slice: target.id,
          field: 'module',
          before: target.module,
          after: sPatch.module,
        });
        target.module = sPatch.module;
      }

      if (sPatch.specPath !== undefined && target.specPath !== sPatch.specPath) {
        changed.push({
          version: vPatch.version,
          slice: target.id,
          field: 'specPath',
          before: target.specPath,
          after: sPatch.specPath,
        });
        target.specPath = sPatch.specPath;
      }
    }
  }

  return { plan: next, changed, missingVersions, missingSlices };
}

/**
 * 计划里每个切片 id 的唯一性检查。
 *
 * 同一个切片 id 出现在两个版本里 → `resolveSliceOwnership` 会抛
 * `AmbiguousOwnershipError`，合并时人得先消歧。
 * 这是**计划层面的错**，在这里查出来比在合并时炸掉好。
 */
export function findDuplicateSliceIds(plan: VersionPlan): string[] {
  const seen = new Map<string, number>();
  for (const v of plan.versions) {
    for (const s of v.slices) {
      seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    }
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

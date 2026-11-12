// Version branch naming and slice-to-version resolution
//
// ADR-056: 版本成为 git 的一等分支实体（`version/<label>`）
//
// C1: 状态只在文件里 —— 版本计划文件 + git 自身承担分支元数据
// C2/C6: core/ 内，只用 Node 内置，不依赖 adapters/
// C3: 纯确定性判定 —— 字符串运算 + 读文件，不调模型、不触网
//
// 归属解析的顺序（ADR-056 §3.2）：
//   1. 命令行显式指定（`--target` / `--plan`）—— 最高优先
//   2. 版本计划成员扫描
//   3. 规格 frontmatter 的 `version:` 字段
//   4. 兜底：合入主干当前分支（= 改造前的行为）
//
// 第 4 条是向后兼容的关键：不在任何版本计划里的切片（老项目、手工建的切片）
// 行为与改造前完全一致。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Version, VersionPlan } from './types.js';

/** 版本分支名前缀 */
export const VERSION_BRANCH_PREFIX = 'version/';

/** 版本工作目录 base（相对仓库根）—— 与切片的 `.zelto/worktrees/` 分开 */
export const VERSION_WORKTREE_BASE_DIR = join('.zelto', 'version-worktrees');

/**
 * 版本分支名。
 *
 * 默认 `version/<label>`。label 里的非法 git 分名字符被替换成 `-`，
 * 避免拼出来的分支名建不出来。
 */
export function versionBranchName(label: string): string {
  const sanitized = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${VERSION_BRANCH_PREFIX}${sanitized || 'unnamed'}`;
}

/** 版本工作目录的相对路径 */
export function versionWorktreeRelativePath(label: string): string {
  const sanitized = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return join(VERSION_WORKTREE_BASE_DIR, sanitized || 'unnamed');
}

/**
 * 版本自己的分支名（计划里显式写了 `branch` 就用它，否则派生）。
 */
export function branchOfVersion(version: Version): string {
  return version.branch && version.branch.trim() ? version.branch.trim() : versionBranchName(version.version);
}

/**
 * 版本 tag 名（ADR-056 D6）—— 版本交付后的不可变锚点。
 *
 * 与分支名刻意分开：`v2` 与 `version/v2` 是两个东西。
 *
 * 不再加 `v` 前缀 —— 版本 label 通常已经是 `v2` 这种形式，
 * 再加就成 `vv2` 了。label 是什么就用什么（`2.0` → tag `2.0`）。
 */
export function versionTagName(label: string): string {
  const sanitized = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unnamed';
}

/** 切片归属解析的结果 */
export type SliceOwnership =
  | {
      kind: 'version';
      /** 所属版本在计划里的 label */
      version: string;
      /** 所属计划的 id */
      planId: string;
      /** 目标分支 */
      branch: string;
    }
  | {
      kind: 'main';
      /** 兜底：合入主干当前分支 */
      branch: null;
    };

/** 归属解析失败（命中多个计划且没指定 --plan） */
export class AmbiguousOwnershipError extends Error {
  constructor(
    readonly sliceId: string,
    readonly plans: string[],
  ) {
    super(
      `切片 "${sliceId}" 同时属于多个版本计划：${plans.join('、')}。` +
      `请用 --plan <id> 指定是哪个计划。`,
    );
    this.name = 'AmbiguousOwnershipError';
  }
}

/** 读版本计划目录里的全部计划文件 */
export function readVersionPlans(versionsDir: string): VersionPlan[] {
  if (!existsSync(versionsDir)) return [];
  const plans: VersionPlan[] = [];
  let names: string[];
  try {
    names = readdirSync(versionsDir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(versionsDir, name), 'utf-8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as VersionPlan;
      if (parsed && Array.isArray(parsed.versions)) plans.push(parsed);
    } catch {
      // 读不动的计划文件跳过 —— 归属解析不该被一份坏文件卡死
    }
  }
  return plans;
}

/**
 * 从规格 frontmatter 里读 `version:` 字段。
 *
 * 规格的 frontmatter 由人写（或 `llm/` 生成的草稿经人确认后落盘），
 * 是「这个切片属于哪个版本」的第二来源。
 */
export function readVersionFromSpec(specPath: string): string | null {
  if (!existsSync(specPath)) return null;
  let content: string;
  try {
    content = readFileSync(specPath, 'utf-8');
  } catch {
    return null;
  }
  if (!content.startsWith('---')) return null;

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const frontmatter = content.slice(4, endIdx);
  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    if (key !== 'version') continue;
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }
  return null;
}

/**
 * 解析一个切片归属哪个版本。
 *
 * @param sliceId 切片 id
 * @param options.versionsDir 版本计划目录（`.zelto/versions`）
 * @param options.specPath 切片规格路径（可选，用于 frontmatter 兜底）
 * @param options.planId 显式指定的计划 id（`--plan`）—— 命中多个计划时消歧
 * @param options.targetBranch 显式指定的目标分支（`--target`）—— 最高优先
 */
export function resolveSliceOwnership(
  sliceId: string,
  options: {
    versionsDir: string;
    specPath?: string | null;
    planId?: string | null;
    targetBranch?: string | null;
  },
): SliceOwnership {
  // 1. 命令行显式指定
  const branch = options.targetBranch && options.targetBranch.trim();
  if (branch === 'main' || branch === 'HEAD') {
    // 显式要求合主干 —— 不管这个切片属于哪个版本，都合主干
    return { kind: 'main', branch: null };
  }
  if (branch) {
    // 显式给了版本分支名 —— 反查它对应哪个版本（找不到也不拦，
    // 合并照样能做，只是没有版本级归属信息）
    const plans = readVersionPlans(options.versionsDir);
    for (const plan of plans) {
      for (const version of plan.versions) {
        if (branchOfVersion(version) === branch || version.version === branch) {
          return { kind: 'version', version: version.version, planId: plan.id, branch };
        }
      }
    }
    return { kind: 'main', branch: null };
  }

  // 2. 版本计划成员扫描
  const plans = readVersionPlans(options.versionsDir).filter(
    (p) => !options.planId || p.id === options.planId,
  );
  const hits: Array<{ plan: VersionPlan; version: Version }> = [];
  for (const plan of plans) {
    for (const version of plan.versions) {
      if (version.slices.some((s) => s.id === sliceId)) hits.push({ plan, version });
    }
  }

  if (hits.length > 1) {
    const planIds = [...new Set(hits.map((h) => h.plan.id))];
    throw new AmbiguousOwnershipError(sliceId, planIds);
  }
  if (hits.length === 1) {
    const hit = hits[0];
    return {
      kind: 'version',
      version: hit.version.version,
      planId: hit.plan.id,
      branch: branchOfVersion(hit.version),
    };
  }

  // 3. 规格 frontmatter
  if (options.specPath) {
    const fromSpec = readVersionFromSpec(options.specPath);
    if (fromSpec) {
      for (const plan of readVersionPlans(options.versionsDir)) {
        const version = plan.versions.find((v) => v.version === fromSpec);
        if (version) {
          return {
            kind: 'version',
            version: version.version,
            planId: plan.id,
            branch: branchOfVersion(version),
          };
        }
      }
    }
  }

  // 4. 兜底：合入主干当前分支
  return { kind: 'main', branch: null };
}

/**
 * 取一个版本分支的 tip commit。
 *
 * 返回 null 表示分支不存在 —— 调用方据此报错（「前置版本的分支还不存在」）。
 */
export function versionBranchTip(
  branch: string,
  repoRoot: string,
  git: (args: string[], cwd: string) => { ok: boolean; stdout: string },
): string | null {
  const res = git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot);
  if (!res.ok) return null;
  const commit = res.stdout.trim();
  return commit || null;
}

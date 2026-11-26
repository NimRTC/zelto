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
 * 版本 label 的合法字符白名单。
 *
 * 允许：字母、数字、点、下划线、连字符。
 * 拒绝：路径分隔符、空格、以及其它一切可能被解释成路径结构的字符。
 *
 * 为什么比切片 id 的白名单宽一点（切片 id 不允许点）：
 * 版本 label 会进 **git 分支名**（`version/<label>`）与 **tag 名**，
 * `v1.2.3` 这种带点的 label 在 git 里完全合法，且是常见写法。
 * 但点带来的 `.` / `..` 必须单独拒掉 —— 见 `isValidVersionLabel`。
 */
const VERSION_LABEL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * 版本 label 是否合法。
 *
 * 白名单之外还专门拒掉 `.` 与 `..`：
 * 它们在字符上「合法」（只由点组成，匹配上面的 pattern），但语义上是
 * **父目录**——`join('.zelto/version-worktrees', '..')` 会归一化成
 * `.zelto`，路径直接逃出 base。
 *
 * 为什么这条必须在这里挡：
 * `versionPathFor()` 用的是**原始 label**（不是清洗过的），
 * 而清洗函数（`versionWorktreeRelativePath` 里的 replace）**允许点**，
 * 所以 `..` 不会被替换成 `-` —— 只能靠显式拒掉。
 */
export function isValidVersionLabel(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  return VERSION_LABEL_PATTERN.test(trimmed);
}

/**
 * 版本 label 的清洗结果 —— 与 label 本身不一致时带原因。
 *
 * 给 CLI 边界用：报错信息要说清「哪里不对」，而不是只说「不合法」。
 */
export interface VersionLabelCheck {
  valid: boolean;
  /** 不合法的原因（valid 为 true 时为 null） */
  reason: string | null;
}

/**
 * 校验版本 label，给出可读的原因。
 *
 * 与 `isValidVersionLabel` 同一套判据，只是多说了「为什么」。
 */
export function checkVersionLabel(label: string): VersionLabelCheck {
  const trimmed = label.trim();
  if (!trimmed) {
    return { valid: false, reason: '版本 label 不能为空' };
  }
  if (trimmed === '.' || trimmed === '..') {
    return { valid: false, reason: `版本 label "${label}" 是路径结构符号，不能作为 label` };
  }
  if (!VERSION_LABEL_PATTERN.test(trimmed)) {
    return {
      valid: false,
      reason: `版本 label "${label}" 含非法字符 —— 只允许字母、数字、点、下划线、连字符，且必须以字母/数字/下划线开头`,
    };
  }
  return { valid: true, reason: null };
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
 *
 * ⚠️ **不要拿它当 ship 的默认 tag 名** ——
 * 它只做字符清洗，会把 `v1` 原样返回成 `v1`（**裸 tag**，ADR-110 认定为非法）。
 * ship 的默认 tag 名用 {@link planVersionTagName}。
 */
export function versionTagName(label: string): string {
  const sanitized = label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unnamed';
}

/**
 * 版本 tag 名（ADR-110）—— `plan-<planId>/v<label>`。
 *
 * 命名空间**按计划寻址**，不按发布批次：
 *
 * ```
 * plan-1795507341754/v3
 * ^^^^^^^^^^^^^^^^ 计划 id（唯一）
 *         ^ 版本序号
 * ```
 *
 * **为什么不带 semver**（ADR-110 决策一）：
 * tag 是**历史**，`package.json` 的 `version` 是**现在** ——
 * 两者必然在某一刻分叉。若把 semver 写进 tag 并要求它等于当前版本，
 * 升版当天所有历史 tag 全部变非法，`build.mjs --release` 直接失败
 * （它无参跑 tag 校验，读的是全量 `git tag`）。
 * **tag 里不该有「当前」概念。**
 *
 * **为什么按计划寻址**（ADR-110 决策一）：
 * 历史上多个计划各自都有自己的 v1/v2/v3。
 * 用 `plan-<semver>/v<n>` 时，同一个 `<semver>/v<n>` 装不下它们 ——
 * 名字被抢占，而**每个版本的锚点只有一个**。
 * planId 唯一（`plan-${Date.now()}` 生成，实测无一重复），
 * 于是每个计划的每个版本都有唯一合法名。
 *
 * **副作用（好的）**：CI 能从 tag 名直接读出计划 ——
 * 不再需要「版本计划在 `.zelto/`（被 gitignore）导致 CI 读不到」那套补丁。
 */
export function planVersionTagName(planId: string, label: string): string {
  // planId 形如 `plan-1795507341754` —— **自带 `plan-` 前缀**。
  // 直接套 `plan-${plan}` 会产出 `plan-plan-1795507341754/...`（双前缀）。
  const plan = planId.trim().replace(/^plan-/, '');
  // label 形如 `v1` / `v3` —— **自带 `v` 前缀**。
  // 直接套 `v${label}` 会产出 `.../vv1`（双前缀）。
  const version = label
    .trim()
    .replace(/^v/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `plan-${plan}/v${version || 'unnamed'}`;
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
 * 归属解析失败（切片在版本上下文里，但解析不出归属）。
 *
 * 病灶（实测 nimrtc-v14，2026-11-26）：版本工作目录里的 `.zelto/versions/`
 * 是**空的** —— 版本计划从不复制进 worktree。于是
 * `resolveSliceOwnership` 的第 2 级（计划成员扫描）落空，
 * 第 3 级（规格 frontmatter）也没写 `version:`，
 * 第 4 级兜底「合入主干当前分支」就生效了。
 *
 * 后果：**落点碰巧没错，错的是归属。**
 *
 * 兜底返回 `kind='main'`，`resolveTarget(null)` 据此取 `dir = process.cwd()` ——
 * 在版本工作目录里那就是**版本分支本身**。所以产物全落在版本分支上
 * （实测 nimrtc-v14：12 个切片全在 `version/v3`，`origin/main` 上一个都没有）。
 *
 * 但兜底绕过了三件事：
 *   - 事件流写 `target=main`，实际分支是 `version/v3` —— 追溯链说谎（C4）
 *   - 跳过「计划成员扫描」与「规格 frontmatter」—— 计划里 v1 的 7 个切片
 *     落在 `version/v3` 上，`version/v1` 上一个都没有
 *   - 跳过版本状态同步 —— `version/v1` 上一个 `Merge slice` 提交都没有
 *
 * 兜底本身不是错的（老项目没有版本计划，需要一个「合哪儿都能跑」的默认），
 * 错的是它在**版本上下文**里也生效：人明明站在版本工作目录里、
 * 这个版本分支明明存在，切片的归属却说不清。
 *
 * 「不知道」不等于「合主干」（ADR-033 的同一原则）。
 * 所以这里抛错，让调用方明确说清「解析不出归属」。
 */
export class UnresolvedOwnershipError extends Error {
  constructor(
    readonly sliceId: string,
    readonly versionsDir: string,
    readonly reason: string,
  ) {
    super(
      `切片 "${sliceId}" 解析不出归属：${reason}\n` +
        `   计划目录：${versionsDir}\n` +
        `   要合进哪个版本分支，说清楚：zelto merge ${sliceId} --target version/<label>\n` +
        `   （显式合主干：zelto merge ${sliceId} --target main）`,
    );
    this.name = 'UnresolvedOwnershipError';
  }
}

/**
 * 解析一个切片归属哪个版本。
 *
 * @param sliceId 切片 id
 * @param options.versionsDir 版本计划目录（`.zelto/versions`）
 * @param options.specPath 切片规格路径（可选，用于 frontmatter 兜底）
 * @param options.planId 显式指定的计划 id（`--plan`）—— 命中多个计划时消歧
 * @param options.targetBranch 显式指定的目标分支（`--target`）—— 最高优先
 * @param options.versionContext 处于版本上下文（版本工作目录）——
 *   此时解析不出归属**抛错**而不是兜底合主干（见 `UnresolvedOwnershipError`）
 */
export function resolveSliceOwnership(
  sliceId: string,
  options: {
    versionsDir: string;
    specPath?: string | null;
    planId?: string | null;
    targetBranch?: string | null;
    versionContext?: boolean;
  },
): SliceOwnership {
  // 1. 命令行显式指定
  const branch = options.targetBranch && options.targetBranch.trim();
  if (branch === 'main' || branch === 'HEAD') {
    // 显式要求合主干 —— 不管这个切片属于哪个版本，都合主干
    return { kind: 'main', branch: null };
  }
  if (branch) {
    // 显式给了版本分支名 —— 反查它对应哪个版本
    const plans = readVersionPlans(options.versionsDir);
    for (const plan of plans) {
      for (const version of plan.versions) {
        if (branchOfVersion(version) === branch || version.version === branch) {
          return { kind: 'version', version: version.version, planId: plan.id, branch };
        }
      }
    }
    // 反查不到 —— 但**分支名本身是权威的**：人明确说了「合 version/v3」。
    //
    // 旧实现在这里兜底成「合主干」，那是**不听指令**：
    // 人指定了版本分支，zelto 却把切片合去了别处。
    // 版本上下文里更不能这样 —— 计划文件缺失时反查必然落空，
    // 兜底的后果就是「版本分支里的切片被静默合进主干」
    // （实测 nimrtc-v14，2026-11-26）。
    //
    // label 从分支名反推（`version/<label>`），planId 留空 ——
    // 「这个分支属于哪份计划」确实不知道（计划文件不在），
    // 但「合哪儿」是明确的，不该因此改主意。
    const label = branch.startsWith(VERSION_BRANCH_PREFIX)
      ? branch.slice(VERSION_BRANCH_PREFIX.length)
      : branch;
    return { kind: 'version', version: label, planId: '', branch };
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
  //
  // **版本上下文里不许兜底**（见 `UnresolvedOwnershipError`）：
  // 人站在版本工作目录里、版本分支明明存在，切片归属却解析不出来 ——
  // 静默兜底会让「哪片属于哪一版」这条追溯链断掉（实测 nimrtc-v14，2026-11-26：
  // 12 个切片的事件 `target` 记成 `main`，而实际分支是 `version/v3`；
  // 计划里 v1 的 7 个切片因此落在 `version/v3` 上，`version/v1` 上一个都没有）。
  //
  // 老项目（不在版本上下文里）仍然兜底：那里没有版本分支，
  // 「合哪儿都能跑」是唯一说得通的行为。
  if (options.versionContext) {
    const why =
      readVersionPlans(options.versionsDir).length === 0
        ? '版本工作目录里没有版本计划文件（.zelto/versions/ 是空的）'
        : '版本计划里没有这个切片';
    throw new UnresolvedOwnershipError(sliceId, options.versionsDir, why);
  }
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

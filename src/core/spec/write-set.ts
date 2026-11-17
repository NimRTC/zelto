// 写集判定 —— 门禁① 对「写集路径」的确定性检查
//
// C3: 纯文件存在性 + 路径判定，不调模型、不触网
// C6: core/ 内，不依赖 adapters/、不依赖 cli/
//
// 为什么要有这个模块（ADR-042 §3.1）：
//
//   门禁①原来把「写集里的路径在仓库里不存在」直接列为**阻断项**。这条规则
//   对「修改已有文件」的切片成立，对**新建文件**的切片则是死结 ——
//   新文件在 agent 动手之前本来就不存在，于是门禁①永远报同一个问题，
//   agent 永远拿不到「可以跑」的结论。
//
//   真实案例：nimrtc-zelto 的 `v1-exception-handling` 要新建
//   `safety_check.hpp` / `safety_check.cpp`，门禁①连报七次
//   「Write-set paths not found」，切片卡在 draft 一步都走不出去。
//
// 判定分成两路（两者不可混为一谈）：
//
//   - **写集本身有问题** → 阻断：写集要写进保护域（policy/**、.zelto/**、
//     AGENTS.md、.cursor/rules/**）、或者路径逃出项目根。这是**运行前**
//     就能确定、且一定会出事的问题 —— 拦住它才是门禁①的价值。
//
//   - **写集路径还不存在** → 提示：这是 agent 要**新建**的文件。
//     门禁①不替 agent 判断「该不该建」，只是把清单摆给人看。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { PROTECTED_PATTERNS, matchPath } from '../policy/engine.js';

/** 一次写集判定的结果 */
export interface WriteSetCheckResult {
  /** 写集里已经存在的路径（agent 要改的已有文件） */
  existing: string[];
  /** 写集里尚不存在、预期由 agent 新建的路径 */
  toCreate: string[];
  /** glob 写集（写的是一片路径，无法逐个核实） */
  globs: string[];
  /** 阻断项：写集本身有问题 */
  issues: string[];
  /** 提示项：需要人看一眼，但不该拦住 */
  advisories: string[];
  /**
   * 「路径可能写错了」的候选 —— 写集里的路径不存在，
   * 但仓库里**有同名文件在别的目录**。
   *
   * 这不是阻断项（agent 大概率会新建一个同名文件），
   * 但它几乎总是「写集路径写错了」的信号：真实路径多了一层
   * `include/nimrtc/xxx/` 之类的目录段。
   */
  nearMisses: Array<{ path: string; candidates: string[] }>;
}

/** 判定选项 */
export interface WriteSetCheckOptions {
  /** 写集路径列表（相对项目根，或绝对路径） */
  writes: string[];
  /** 项目根目录；缺省用 process.cwd() */
  projectRoot?: string;
}

/** 路径归一化：统一成正斜杠（跨平台比较的前提） */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 取写集路径里**不含通配符的那一段前缀**。
 *
 * 通配符之前的部分一定是字面路径，而保护域判定需要的是字面部分
 * （`policy/**` 的字面前缀是 `policy/`，落在 `policy/**` 这个保护域里）。
 */
function literalPrefix(pattern: string): string {
  const normalized = toPosix(pattern);
  const wildcardAt = normalized.search(/[*?]/);
  const prefix = wildcardAt === -1 ? normalized : normalized.slice(0, wildcardAt);
  // 截到最后一个目录分隔符之前（`src/modules/x*` → `src/modules/`）
  const lastSlash = prefix.lastIndexOf('/');
  return lastSlash === -1 ? '' : prefix.slice(0, lastSlash + 1);
}

/**
 * 字面路径是否落在保护域里。
 *
 * 保护域是硬约束（C5 / C8），不可被任何策略规则覆盖。
 * 写集要写进保护域 = 这片注定跑不起来（hook 会逐条 deny），
 * 所以在门禁①（agent 还没跑）就该拦下来。
 */
export function writeSetHitsProtectedDomain(pattern: string): boolean {
  const normalized = toPosix(pattern);
  const prefix = literalPrefix(normalized);

  // 字面前缀命中保护域 → 整条写集都命中
  if (prefix && PROTECTED_PATTERNS.some((p) => matchPath(p, prefix) || matchPath(p, prefix.replace(/\/$/, '')))) {
    return true;
  }

  // 无通配符的整条路径直接判
  if (!normalized.includes('*') && !normalized.includes('?')) {
    return PROTECTED_PATTERNS.some((p) => matchPath(p, normalized));
  }

  // 带通配符且前缀不命中：交给逐文件判定（运行时守卫会兜住）
  return false;
}

/**
 * 路径是否逃出项目根。
 *
 * 与 `core/policy/engine.ts` 的第 2 步（路径逃逸）同义，
 * 但那一步判的是**归一化后**的相对路径；这里判的是**写集声明本身**。
 */
export function writeSetEscapesRoot(pattern: string, projectRoot: string): boolean {
  const normalized = toPosix(pattern);
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    // 绝对路径：只要还在项目根之下就算没逃
    const abs = resolve(pattern);
    const rel = relative(resolve(projectRoot), abs);
    return rel.startsWith('..') || isAbsolute(rel);
  }
  const resolved = resolve(projectRoot, pattern);
  const rel = relative(resolve(projectRoot), resolved);
  return rel.startsWith('..') || isAbsolute(rel);
}

/**
 * glob 模式 → 正则（与 `core/policy/engine.ts` 的 matchPath 同一套语义）。
 *
 * 单独抽出来是因为「glob 写集的判定」在三处出现：字面前缀提取、
 * 覆盖判定、存在性核实。三处各抄一份的话，语义一旦漂移就会出现
 * 「准入层认为命中、运行时层认为不命中」。
 */
function globToRegExp(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\*\*\//g, '<<<DS>>>/')
    .replace(/\*\*/g, '<<<DSB>>>')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DS>>>\//g, '(.+/|)')
    .replace(/<<<DSB>>>/g, '.*');
  return new RegExp(`^${regexStr}$`);
}

/**
 * glob 写集是否命中了至少一个已有文件。
 *
 * 只扫通配符之前的**字面目录前缀**（`src/**` → 扫 `src/`），
 * 所以代价与前缀目录的大小有关，不会全仓库遍历。
 */
function globMatchesSomething(pattern: string, projectRoot: string): boolean {
  const normalized = toPosix(pattern);
  const prefix = literalPrefix(normalized);
  const scanRoot = resolve(projectRoot, prefix || '.');

  if (!existsSync(scanRoot)) return false;

  const regex = globToRegExp(normalized);

  const stack: string[] = [scanRoot];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const dir = stack.pop()!;
    visited++;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      const rel = toPosix(relative(resolve(projectRoot), full));
      if (regex.test(rel)) return true;
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  return false;
}

/**
 * 在仓库里找「同名文件在别的目录」的候选。
 *
 * 病灶（实测于 nimrtc-zelto v2-input-binder）：
 *
 *   写集写的是 `src/modules/rd_input/ref_frame_binder.hpp`，
 *   仓库里真实的文件在 `src/modules/rd_input/include/nimrtc/rd_input/ref_frame_binder.hpp`。
 *   写集路径「不存在」→ 门禁①只提示「agent 会新建」→ 放行 →
 *   agent 找到真实文件去改 → hook 按写集判定越界 → 拒绝。
 *
 *   也就是说：**写集路径写错 = agent 注定被拒**，但门禁①看不出来。
 *
 * 做法：按**文件名**（不含目录）在仓库里找同名文件。
 * 命中且路径不同 → 报成提示项（不阻断，但要说清「大概你想写的是那个」）。
 *
 * 代价控制：只扫有限深度、跳过常见的忽略目录、总量封顶。
 */
function findSameNameElsewhere(
  pattern: string,
  projectRoot: string,
  limit = 5,
): string[] {
  const fileName = pattern.slice(pattern.lastIndexOf('/') + 1);
  if (!fileName || fileName.includes('*') || fileName.includes('?')) return [];

  const skipDirs = new Set([
    'node_modules', '.git', '.zelto', 'dist', 'dist-test', 'build',
    'target', '__pycache__', 'coverage', '.cache', 'out', '.claude',
  ]);

  const found: string[] = [];
  const stack: string[] = [resolve(projectRoot)];
  let visited = 0;

  while (stack.length > 0 && visited < 20000 && found.length < limit) {
    const dir = stack.pop()!;
    visited++;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      const rel = toPosix(relative(resolve(projectRoot), full));
      if (rel === toPosix(pattern)) continue; // 它自己不算「在别处」
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (skipDirs.has(entry)) continue;
        stack.push(full);
        continue;
      }
      if (entry === fileName) {
        found.push(rel);
        if (found.length >= limit) break;
      }
    }
  }

  return found;
}

/**
 * 判定写集。
 *
 * 返回的 `issues` 是阻断项（写集本身有问题），`advisories` 是提示项
 * （路径还不存在 = agent 要新建的文件）。门禁①把前者计入退出码，后者只打印。
 */
export function evaluateWriteSet(options: WriteSetCheckOptions): WriteSetCheckResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  const existing: string[] = [];
  const toCreate: string[] = [];
  const globs: string[] = [];
  const issues: string[] = [];
  const advisories: string[] = [];
  const nearMisses: WriteSetCheckResult['nearMisses'] = [];

  for (const raw of options.writes) {
    const pattern = raw.trim();
    if (!pattern) continue;

    // ── 保护域：写集要写进 policy/ / .zelto/ / AGENTS.md → 阻断 ──
    if (writeSetHitsProtectedDomain(pattern)) {
      issues.push(`Write-set path is inside the protected domain: ${pattern}`);
      continue;
    }

    // ── 路径逃逸：写出项目根 → 阻断 ──
    if (writeSetEscapesRoot(pattern, projectRoot)) {
      issues.push(`Write-set path escapes the project root: ${pattern}`);
      continue;
    }

    // ── glob 写集：写的是一片路径，无法逐个核实 ──
    if (pattern.includes('*') || pattern.includes('?')) {
      globs.push(pattern);
      if (!globMatchesSomething(pattern, projectRoot)) {
        advisories.push(`Write-set glob matches no existing file (will be created): ${pattern}`);
      }
      continue;
    }

    // ── 具体路径 ──
    if (existsSync(resolve(projectRoot, pattern))) {
      existing.push(pattern);
      continue;
    }

    // 不存在 —— 这是 agent 要**新建**的文件，不是错误。
    toCreate.push(pattern);
    advisories.push(`Write-set path does not exist yet (agent will create it): ${pattern}`);

    // ── 近名文件在别处 → 「路径可能写错了」的提示 ──
    // 见 findSameNameElsewhere 的说明：写集路径写错 = agent 注定被 hook 拒绝。
    const candidates = findSameNameElsewhere(pattern, projectRoot);
    if (candidates.length > 0) {
      nearMisses.push({ path: pattern, candidates });
      advisories.push(
        `Write-set path "${pattern}" does not exist, but a file with the same name exists at: ` +
          `${candidates.join(', ')} — the write-set path is likely wrong (agent would be denied on the real path)`,
      );
    }
  }

  return { existing, toCreate, globs, issues, advisories, nearMisses };
}

/**
 * 写集里「agent 应当产出但没产出」的文件。
 *
 * 门禁①（跑之前）不看这个 —— 跑之前这些文件本来就不存在。
 * 这个函数给**跑完之后**的检查用：agent 说做完了，但写集里的文件一个都没动，
 * 那就是没做。
 *
 * @param writes 写集路径列表
 * @param changedPaths agent 实际改动过的路径（相对项目根）
 */
export function findUnproducedWriteSetPaths(writes: string[], changedPaths: string[]): string[] {
  const changed = new Set(changedPaths.map(toPosix));
  const missing: string[] = [];

  for (const raw of writes) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.includes('*') || pattern.includes('?')) continue; // glob 不逐个核

    const normalized = toPosix(pattern);
    if (changed.has(normalized)) continue;

    // 目录式写集（`src/foo/`）：目录里有任何改动就算动过
    if (pattern.endsWith('/')) {
      const prefix = normalized;
      if ([...changed].some((c) => c.startsWith(prefix))) continue;
    }

    missing.push(pattern);
  }

  return missing;
}

/** 写集里某个具体路径是否被声明（用于「这个文件是不是本片该产的」判定） */
export function isInWriteSet(filePath: string, writes: string[]): boolean {
  const normalized = toPosix(filePath);
  for (const raw of writes) {
    const pattern = toPosix(raw.trim());
    if (!pattern) continue;
    if (pattern.includes('*') || pattern.includes('?')) {
      if (globToRegExp(pattern).test(normalized)) return true;
      continue;
    }
    const dir = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/**
 * 写集里是否含某个目录前缀（用于「本片是否该动某个目录」的判定）。
 *
 * glob 写集用**字面前缀**判定：`src/modules/demo/**` 的字面前缀是
 * `src/modules/demo/`，所以它覆盖 `src/modules/demo` 这个目录。
 */
export function writeSetCoversDir(writes: string[], dir: string): boolean {
  const target = toPosix(dir).replace(/^\/+|\/+$/g, '');
  return writes.some((raw) => {
    const pattern = toPosix(raw.trim()).replace(/^\/+|\/+$/g, '');
    if (!pattern) return false;
    if (pattern.includes('*') || pattern.includes('?')) {
      const prefix = literalPrefix(pattern).replace(/^\/+|\/+$/g, '');
      if (prefix && (target === prefix || target.startsWith(`${prefix}/`))) return true;
      return globToRegExp(pattern).test(target);
    }
    return pattern === target || target.startsWith(`${pattern}/`) || pattern.startsWith(`${target}/`);
  });
}

/** 供诊断用：某个写集路径的绝对位置 */
export function resolveWriteSetPath(pattern: string, projectRoot: string = process.cwd()): string {
  return resolve(projectRoot, pattern);
}

/** 供诊断用：写集路径的目录部分 */
export function writeSetDirname(pattern: string): string {
  return dirname(pattern);
}

/**
 * 写集覆盖判据的结果。
 *
 * D-4：「规格说要改 + 写集不允许改」这个矛盾，应该在**冻结时**暴露，
 * 而不是等到 agent 撞上写集守卫、在链接期才发现。
 */
export interface WriteSetCoverageResult {
  /** 规格提到、但写集覆盖不到的路径 —— 这些是「该写但没被授权」的文件 */
  uncovered: string[];
  /** 写集里有、但规格没提到的路径 —— 通常无害（agent 自选的写集） */
  extra: string[];
}

/**
 * 规格提到的文件是否都被写集覆盖。
 *
 * 判据用「写集是否覆盖该路径」而不是「路径是否字面等于写集条目」——
 * 写集常写成 glob（`src/engine/src/**`）或目录（`src/engine/src/`），
 * 字面比较会把大量实际覆盖的情况误报成未覆盖。
 *
 * @param mentioned 规格里提到的路径（`parseMentionedPaths` 的输出）
 * @param writes 写集路径列表
 */
export function evaluateWriteSetCoverage(
  mentioned: string[],
  writes: string[],
): WriteSetCoverageResult {
  const uncovered: string[] = [];
  const extra: string[] = [];

  for (const path of mentioned) {
    if (!isInWriteSet(path, writes)) {
      uncovered.push(path);
    }
  }

  // extra：写集里的具体路径（不含 glob）在规格里没被提到
  const mentionedSet = new Set(mentioned.map(toPosix));
  for (const raw of writes) {
    const pattern = toPosix(raw.trim());
    if (!pattern) continue;
    if (pattern.includes('*') || pattern.includes('?')) continue;
    const normalized = pattern.replace(/\/$/, '');
    if (normalized.endsWith('/')) continue;
    if (mentionedSet.has(normalized)) continue;
    // 写集条目若被规格提到的某个路径前缀覆盖，也不算 extra
    const covered = mentioned.some((p) => normalized.startsWith(`${p}/`));
    if (!covered) extra.push(pattern);
  }

  return { uncovered, extra };
}

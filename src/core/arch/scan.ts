// 架构扫描 —— 把项目源码变成「模块之间的实际依赖图」
//
// 输入：设计里声明的模块（名字 / 负责的文件 glob / 声明的依赖）
// 输出：代码里**实际**的模块依赖边，以及和设计对不上的地方
//
// 判定是确定性的：路径匹配用 policy engine 的 matchPath（写集同源），
// import 解析用正则，模块归属按「模式最具体者胜」（见 normalize.ts）。
//
// 两类文件分开对待：
//   源文件（ts/js/py）—— 参与 import 图，是依赖边的来源
//   其它文件（契约 JSON、规格 md）—— 只参与归属统计，不产生依赖边
// 混在一起会让「模块管着 12 个文件但 0 行代码」这类模块看不出真相。
//
// C3: 纯计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathMatches } from '../sched/paths.js';
import {
  classifyLangCategory,
  detectLang,
  isCodeLangCategory,
  isVerifiableLang,
  matchModuleBySpecifier,
  parseImports,
} from './imports.js';
import {
  compareSpecificity,
  normalizeModuleSpecs,
  patternSpecificity,
  type PatternSpecificity,
} from './normalize.js';
import type {
  LangCategory,
  LangCoverage,
  ModuleEdge,
  ModuleSpec,
  ScanResult,
  ScannedFile,
} from './types.js';

/** 不扫的目录 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.zelto', 'dist', 'dist-test', 'build', 'out', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target', '.cache', '.turbo',
  'worktrees', '.worktrees',
]);

/** 解析相对 import 时尝试的扩展名 */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'];

/**
 * ESM 源码里写的是 `.js`，磁盘上却是 `.ts`。
 *
 * Node 的 ESM 约定：TypeScript 源码写成 `import './a.js'`，
 * 编译后指向 `./a.js`。所以解析相对 import 时，
 * 说明符带的 `.js` 后缀要能对上磁盘上的 `.ts`。
 */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.mts', '.cts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * 收集项目里的所有文件（相对项目根，正斜杠路径）。
 */
export function collectAllFiles(root: string): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
        continue;
      }
      files.push(toPosix(relative(root, full)));
    }
  };

  walk(root);
  return files.sort();
}

/**
 * 收集项目里的源文件（相对项目根，正斜杠路径）。
 */
export function collectSourceFiles(root: string): string[] {
  return collectAllFiles(root).filter((path) => detectLang(path) !== null);
}

/**
 * include 根目录的目录名（ADR-062 §3.4）
 *
 * C++ 世界的惯例：`include/` 放公共头文件，源码目录里的
 * 头文件通过「当前目录优先」找到。真实项目实测 44/44 命中。
 */
const INCLUDE_ROOT_NAMES = new Set(['include', 'inc']);

/**
 * 发现项目里的 **include 根目录**（相对项目根，正斜杠路径）。
 *
 * ADR-062 §6：为什么用「约定」而不是解析 CMakeLists / BUILD？
 *
 * | | 约定法 | 解析构建系统 |
 * |---|---|---|
 * | 覆盖率 | 44/44（真实项目） | ~100% |
 * | 假边风险 | **零**（只漏不错） | 有（解析错就假边） |
 * | core/ 复杂度 | 低 | 高（要实现半个构建系统） |
 *
 * **核心权衡：假边比漏边严重得多。**
 * 一条解析错的 include 会产生假的模块依赖边，进而报假的架构偏离 ——
 * 而假的偏离会让人去改对的代码。
 *
 * 所以这里宁可漏（表现为「这条依赖验不了」，方向安全），
 * 也不猜（猜错 = 假偏离）。
 *
 * **顺序**：按路径字典序 —— include 根的理论顺序（编译器的 `-I` 顺序）
 * 我们是猜的，字典序至少是确定的、可复现的（C3）。
 */
export function discoverIncludeRoots(root: string): string[] {
  const roots = new Set<string>();

  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (INCLUDE_ROOT_NAMES.has(entry.toLowerCase())) {
        roots.add(childRel);
        // include 根下面还可能有嵌套的 include 根，继续往下找
      }
      walk(full, childRel);
    }
  };

  walk(root, '');
  return [...roots].sort();
}

/**
 * 解析 C/C++ 的 `#include "..."`。
 *
 * ADR-062 §3.1：两种形态，两套候选策略。
 *
 * 1. **带目录**（`nimrtc/core/registry.hpp`）
 *    —— 相对于引用文件所在目录，再试所有 include 根
 * 2. **裸文件名**（`engine_impl.hpp`）
 *    —— 先试引用文件所在目录（这是 `#include "..."` 的规范行为），
 *    再试所有 include 根
 *
 * 真实项目实测：108 条引号 include 里 72 条是裸文件名、36 条带目录，
 * **两种形态并存**，所以两种策略都要有。
 */
export function resolveCppInclude(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
  includeRoots: string[],
): string | null {
  const baseDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const candidates: string[] = [];

  // 相对引用文件所在目录
  candidates.push(normalizePosix(joinPosix(baseDir, specifier)));

  // 相对每个 include 根
  for (const root of includeRoots) {
    candidates.push(normalizePosix(joinPosix(root, specifier)));
  }

  // 头文件可能省略扩展名（`#include "foo"` → `foo.hpp`）
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
    if (!candidate.includes('.')) {
      for (const ext of CPP_RESOLVE_EXTENSIONS) {
        if (fileSet.has(candidate + ext)) return candidate + ext;
      }
    }
  }
  return null;
}

/** C/C++ 头文件在省略扩展名时尝试的后缀 */
const CPP_RESOLVE_EXTENSIONS = ['.hpp', '.h', '.hh', '.hxx', '.ipp', '.inl', '.c', '.cc', '.cpp'];

/**
 * 扫描项目，算出模块之间的实际依赖边。
 */
export function scanArchitecture(root: string, rawModules: ModuleSpec[]): ScanResult {
  // 设计声明先归一化：反引号、「无」占位符这些书写习惯不该变成假偏离
  const modules = normalizeModuleSpecs(rawModules);
  const allFiles = collectAllFiles(root);
  const sourceFiles = allFiles.filter((path) => detectLang(path) !== null);
  const fileSet = new Set(sourceFiles);

  // include 根目录（ADR-062）：C++ 的 `#include "nimrtc/core/x.hpp"`
  // 靠它才能解析到真实文件。
  const includeRoots = discoverIncludeRoots(root);

  // ─── 第一遍：先定归属 ──────────────────────────────────────────────────
  // 归属必须先全部算完再算依赖 —— 否则「a 引用 b」这种边会因为
  // b 的文件还没扫到而被丢掉（文件是按字典序遍历的）。
  const ownerOf = new Map<string, string | null>();
  const scanned: ScannedFile[] = [];
  const moduleFiles = new Map<string, string[]>();
  const moduleCodeFiles = new Map<string, string[]>();
  const moduleVerifiedFiles = new Map<string, string[]>();
  for (const mod of modules) {
    moduleFiles.set(mod.name, []);
    moduleCodeFiles.set(mod.name, []);
    moduleVerifiedFiles.set(mod.name, []);
  }

  for (const path of allFiles) {
    const lang = detectLang(path);

    // 归属：命中的模块里，谁的**模式最具体**谁拿走这个文件。
    // 按声明顺序判会让 `src/core/**` 抢走 `src/core/audit/*.ts` 的文件，
    // 父子模块一叠加，整个模块图都是乱的。
    // 具体程度相同才算真歧义 —— 那才是设计没说清的地方。
    const claims: Array<{ module: string; specificity: PatternSpecificity }> = [];
    for (const mod of modules) {
      let best: PatternSpecificity | null = null;
      for (const pattern of mod.filePatterns) {
        if (!pathMatches(path, pattern)) continue;
        const spec = patternSpecificity(pattern);
        // 同一模块内取最具体的那个模式作为它的主张
        if (!best || compareSpecificity(spec, best) > 0) best = spec;
      }
      if (best) claims.push({ module: mod.name, specificity: best });
    }

    let owner: string | null = null;
    let ambiguousWith: string[] = [];
    if (claims.length > 0) {
      claims.sort(
        (a, b) =>
          compareSpecificity(b.specificity, a.specificity) || a.module.localeCompare(b.module),
      );
      owner = claims[0].module;
      const top = claims[0].specificity;
      ambiguousWith = claims
        .filter((c) => compareSpecificity(c.specificity, top) === 0 && c.module !== owner)
        .map((c) => c.module);
    }

    ownerOf.set(path, owner);

    // 「代码文件」与「已验证文件」分开记（ADR-061）。
    //
    // 原来只有一个 `moduleCodeFiles`，装的是扫描器读得懂的文件 ——
    // 于是 C++ 模块在报告里显示「0 源码」。`.cpp` / `.hpp` 就是源码，
    // 只不过扫描器读不懂它的依赖语义。
    //
    // 现在：
    //   moduleCodeFiles     —— 所有代码文件（不限语言）
    //   moduleVerifiedFiles —— 扫描器读得懂的（参与了 import 图）
    const category = classifyLangCategory(path);
    const isCode = isCodeLangCategory(category);
    if (isCode && owner) moduleCodeFiles.get(owner)?.push(path);

    if (lang) {
      scanned.push({ path, lang, module: owner, ambiguousWith });
      if (owner) moduleVerifiedFiles.get(owner)?.push(path);
    }
    if (owner) {
      moduleFiles.get(owner)?.push(path);
    }
  }

  // ─── 第二遍：算依赖 ────────────────────────────────────────────────────
  const moduleNames = modules.map((m) => m.name);
  const edgeMap = new Map<string, ModuleEdge>();
  const unresolved: Array<{ file: string; specifier: string }> = [];

  for (const file of scanned) {
    const path = file.path;
    const owner = file.module;

    let source: string;
    try {
      source = readFileSync(join(root, path), 'utf-8');
    } catch {
      continue;
    }

    for (const ref of parseImports(source, file.lang)) {
      let targetModule: string | null = null;

      if (file.lang === 'cpp') {
        // C++ 的 `#include "..."` —— 项目内依赖（系统头已在解析时归为 builtin）
        const resolved = resolveCppInclude(path, ref.specifier, fileSet, includeRoots);
        if (!resolved) {
          unresolved.push({ file: path, specifier: ref.specifier });
          continue;
        }
        const targetModuleOwner = ownerOf.get(resolved) ?? null;
        if (!targetModuleOwner) {
          // 目标文件不在任何模块里 —— 记成未认领，不算模块依赖
          continue;
        }
        targetModule = targetModuleOwner;
      } else if (ref.kind === 'relative') {
        const resolved = resolveRelative(path, ref.specifier, fileSet);
        if (!resolved) {
          unresolved.push({ file: path, specifier: ref.specifier });
          continue;
        }
        const targetModuleOwner = ownerOf.get(resolved) ?? null;
        if (!targetModuleOwner) {
          // 目标文件不在任何模块里 —— 记成未认领，不算模块依赖
          continue;
        }
        targetModule = targetModuleOwner;
      } else if (ref.kind === 'package') {
        targetModule = matchModuleBySpecifier(ref.specifier, moduleNames);
        if (!targetModule) continue; // 外部依赖，不进模块图
      } else {
        continue; // 内置模块
      }

      if (!owner || !targetModule || owner === targetModule) continue;

      const key = `${owner}→${targetModule}`;
      const edge = edgeMap.get(key) ?? {
        from: owner,
        to: targetModule,
        files: [],
        specifiers: [],
      };
      if (!edge.files.includes(path)) edge.files.push(path);
      if (!edge.specifiers.includes(ref.specifier)) edge.specifiers.push(ref.specifier);
      edgeMap.set(key, edge);
    }
  }

  const edges = [...edgeMap.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  const unmapped = scanned.filter((f) => f.module === null).map((f) => f.path);

  return {
    files: scanned,
    moduleFiles,
    moduleCodeFiles,
    moduleVerifiedFiles,
    edges,
    unmapped,
    unresolved,
    coverage: computeCoverage(allFiles, scanned),
  };
}

/**
 * 统计本次扫描的**语言覆盖面**。
 *
 * ADR-060 §4 方案 A：`arch check` 必须诚实地说出「哪些文件验过、哪些没验过」。
 *
 * 关键区分：
 *   - **代码类但验不了**（C++ / Go / Rust / Java）→ 这是「**没有判据**」，
 *     要显式报出来，因为它让人以为「项目有小问题」，
 *     而真相是「这个工具在这个项目上没有判据」。
 *   - **不产生依赖边的文件**（构建脚本 / 文档 / 配置）→ 这是**正常的**，
 *     混进「验不了」里会稀释掉真正重要的信息。
 */
function computeCoverage(allFiles: string[], scanned: ScannedFile[]): LangCoverage {
  const counts = {} as Record<LangCategory, number>;
  // 注意：这里要**遍历数组本身**，不能用 `Object.keys(LANG_CATEGORY_KEYS)` ——
  // 那是数组的索引（"0".."9"），不是元素值。用错了会往 counts 里塞
  // 一堆 "0".."9" 的假键。
  for (const category of LANG_CATEGORY_KEYS) {
    counts[category] = 0;
  }

  for (const path of allFiles) {
    const category = classifyLangCategory(path);
    counts[category] = (counts[category] ?? 0) + 1;
  }

  // 已参与 import 图的类别 —— 这些就是「有判据」的
  const verifiable = LANG_CATEGORY_KEYS.filter((category) => {
    if (!isVerifiableLang(category)) return false;
    return scanned.some((f) => classifyLangCategory(f.path) === category);
  });

  // 代码类但验不了的：C++ / Go / Rust / Java
  const unverifiableCodeFiles = LANG_CATEGORY_KEYS.filter((category) =>
    isCodeLangCategory(category) && !isVerifiableLang(category),
  ).reduce((sum, category) => sum + (counts[category] ?? 0), 0);

  // 不产生依赖边的：构建脚本 / 文档 / 配置 / 其它
  const nonCodeFiles = LANG_CATEGORY_KEYS.filter(
    (category) => !isCodeLangCategory(category),
  ).reduce((sum, category) => sum + (counts[category] ?? 0), 0);

  return {
    counts,
    verifiable,
    verifiedFiles: scanned.length,
    unverifiableCodeFiles,
    nonCodeFiles,
    totalFiles: allFiles.length,
  };
}

/**
 * 全部语言类别（顺序即报告里的顺序） */
const LANG_CATEGORY_KEYS: LangCategory[] = [
  'typescript',
  'python',
  'cpp',
  'go',
  'rust',
  'java',
  'build',
  'doc',
  'config',
  'other',
];

/**
 * 解析相对 import 指向的文件。
 *
 * 候选顺序固定：先原样，再换扩展名，再逐个扩展名，最后 `index.*`。
 * 命中即返回，结果与文件系统遍历顺序无关。
 */
export function resolveRelative(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  const baseDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const specPath = specifier.replace(/^\.\//, '');
  const joined = normalizePosix(joinPosix(baseDir, specPath));

  const candidates: string[] = [joined];

  // 说明符自带 `.js` 后缀，但源码在磁盘上是 `.ts` —— 先试同名的 TS 变体
  for (const [jsExt, tsExts] of Object.entries(JS_TO_TS)) {
    if (!joined.endsWith(jsExt)) continue;
    const stem = joined.slice(0, -jsExt.length);
    for (const tsExt of tsExts) candidates.push(stem + tsExt);
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(joined + ext);
    candidates.push(`${joined}/index${ext}`);
  }

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * POSIX 风格的路径拼接。
 *
 * 不用 node:path 的 join —— 它在 Windows 上产出反斜杠，
 * 而扫描出来的路径全是正斜杠，拼出来的候选就永远对不上文件集。
 */
function joinPosix(baseDir: string, rel: string): string {
  const segments = baseDir ? baseDir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    segments.push(part);
  }
  return segments.join('/');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function normalizePosix(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

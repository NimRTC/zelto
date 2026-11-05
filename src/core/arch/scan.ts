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
import { detectLang, matchModuleBySpecifier, parseImports } from './imports.js';
import {
  compareSpecificity,
  normalizeModuleSpecs,
  patternSpecificity,
  type PatternSpecificity,
} from './normalize.js';
import type { ModuleEdge, ModuleSpec, ScanResult, ScannedFile } from './types.js';

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
 * 扫描项目，算出模块之间的实际依赖边。
 */
export function scanArchitecture(root: string, rawModules: ModuleSpec[]): ScanResult {
  // 设计声明先归一化：反引号、「无」占位符这些书写习惯不该变成假偏离
  const modules = normalizeModuleSpecs(rawModules);
  const allFiles = collectAllFiles(root);
  const sourceFiles = allFiles.filter((path) => detectLang(path) !== null);
  const fileSet = new Set(sourceFiles);

  // ─── 第一遍：先定归属 ──────────────────────────────────────────────────
  // 归属必须先全部算完再算依赖 —— 否则「a 引用 b」这种边会因为
  // b 的文件还没扫到而被丢掉（文件是按字典序遍历的）。
  const ownerOf = new Map<string, string | null>();
  const scanned: ScannedFile[] = [];
  const moduleFiles = new Map<string, string[]>();
  const moduleCodeFiles = new Map<string, string[]>();
  for (const mod of modules) {
    moduleFiles.set(mod.name, []);
    moduleCodeFiles.set(mod.name, []);
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
    if (lang) {
      scanned.push({ path, lang, module: owner, ambiguousWith });
      if (owner) moduleCodeFiles.get(owner)?.push(path);
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

      if (ref.kind === 'relative') {
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
    edges,
    unmapped,
    unresolved,
  };
}

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

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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathMatches } from '../pathspec/index.js';
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
import { isTestFile } from './test-files.js';
import { isToolingFile } from './tooling-files.js';
import type {
  LangCategory,
  LangCoverage,
  ModuleEdge,
  ModuleSpec,
  ScanResult,
  ScannedFile,
} from './types.js';

/**
 * 不扫的目录
 *
 * `build` / `build2` / `build3` 这类**带序号的构建目录**要一起排除 ——
 * 真实项目里有 `build2/`（CMake 的第二个构建树），
 * 里面的 `CMakeFiles/CompilerIdC` 是编译器探测产物，
 * 把它们算进「文件无归属」是纯噪音。
 *
 * 判据：目录名匹配 `build` + 数字后缀（`build`、`build2`、`build10`）。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.zelto', 'dist', 'dist-test', 'build', 'out', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target', '.cache', '.turbo',
  'worktrees', '.worktrees',
]);

/** 是不是构建目录（`build` / `build2` / `build10` 这种带序号的） */
function isBuildDir(name: string): boolean {
  return /^build\d*$/.test(name);
}

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
      if (SKIP_DIRS.has(entry) || isBuildDir(entry)) continue;
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
 * **vendor 目录**的目录名（ADR-065）
 *
 * 这些目录里放的是**引入的外部代码** —— 不是项目的架构。
 *
 * 真实项目实测（nimrtc-zelto）：`src/third_party` 里 11943 个文件、
 * 4434 个代码文件，占全项目代码文件的 **97%**。
 *
 * 把它们算进依赖图的后果：
 *   1. **淹没真正的信号** —— 5 条「未声明依赖 → src/third_party」
 *      是噪音，掩盖了真正要看的偏离
 *   2. **统计失真** —— 「已验证 4481 个 C++ 文件」听起来像整个项目都验过了，
 *      实际上其中 97% 是 vendor 代码
 *   3. **不是人的设计决策** —— opus 内部依赖 wolfssl，
 *      这是 opus 的设计，不是这个项目的
 *
 * **但 vendor 代码本身仍要计入覆盖率**（见 `vendorFiles`）——
 * 不然报告会说「这个项目只有 47 个 C++ 文件」，那更不真实。
 */
const VENDOR_DIR_NAMES = new Set([
  'third_party',
  'thirdparty',
  'third-party',
  'vendor',
  'vendors',
  'external',
  'externals',
  'deps',
  '3rdparty',
]);

/**
 * 发现项目里的 **vendor 目录**（相对项目根，正斜杠路径）。
 *
 * 判据是**目录名约定** —— 与 ADR-062 的 include 根同样的思路：
 * 约定法只漏不错（漏了只是把 vendor 当普通模块，不产生假偏离）。
 *
 * **只认顶层的约定名**：`src/third_party` 认，
 * `src/third_party/foo/src` 里再叫 `third_party` 的不认 ——
 * 否则第三方库内部的目录结构也会被当成边界，规则就失控了。
 */
export function discoverVendorDirs(root: string): string[] {
  const found = new Set<string>();

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || isBuildDir(entry)) continue;
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (VENDOR_DIR_NAMES.has(entry.toLowerCase())) {
        found.add(childRel);
        // vendor 目录**不再往下找** —— 第三方库内部的目录结构不是边界
        continue;
      }
      walk(full, childRel, depth + 1);
    }
  };

  walk(root, '', 0);
  return [...found].sort();
}

/** 路径是否在某个 vendor 目录里 */
export function isVendorPath(filePath: string, vendorDirs: string[]): boolean {
  return vendorDirs.some((dir) => filePath === dir || filePath.startsWith(`${dir}/`));
}

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
      if (SKIP_DIRS.has(entry) || isBuildDir(entry)) continue;
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
 * 解析 C/C++ 的 `#include`。
 *
 * ADR-062 §3.1 / §3.2（修正）：两种括号，两套候选策略。
 *
 * 1. **引号**（`nimrtc/core/registry.hpp`）
 *    —— 相对引用文件所在目录，再试所有 include 根
 * 2. **尖括号**（`<nimrtc/core/registry.hpp>`）
 *    —— **只**试 include 根（跳过当前目录，这是 `<>` 的规范行为）
 * 3. **裸文件名**（`engine_impl.hpp`，引号形式）
 *    —— 先试引用文件所在目录（`#include "..."` 的规范行为），
 *    再试所有 include 根
 *
 * 真实项目实测：108 条引号 include 里 72 条是裸文件名、36 条带目录，
 * **两种形态并存**；另有 2716 条尖括号 include，其中 **1081 条是项目内部的**
 * —— 所以尖括号**不能**一律当系统头排除。
 */
export function resolveCppInclude(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
  includeRoots: string[],
  bracket: '<' | '"' = '"',
): string | null {
  const baseDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const candidates: string[] = [];

  // 引号形式先试引用文件所在目录；尖括号跳过（C++ 规范行为）
  if (bracket === '"') {
    candidates.push(normalizePosix(joinPosix(baseDir, specifier)));
  }

  // 再试每个 include 根
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

// ─── Go / Rust / Java / Kotlin 的解析（ADR-069 / ADR-082）──────────────────

/**
 * 找出 Go 模块的**模块路径**（`go.mod` 的第一行）。
 *
 * ```
 * module github.com/foo/bar
 * ```
 *
 * **只读 module path 一行**（ADR-069 §3.1）——
 * `require` / `replace` / `exclude` 的语义复杂（模块图、版本选择），
 * 而我们只需要「哪个 import 路径算项目内部」。
 * 其余一律当外部依赖 —— **宁可漏，不猜**（同 ADR-062 §7 的权衡）。
 *
 * @returns 模块路径；找不到 `go.mod` 或没有 module 行时返回 null
 */
export function findGoModulePath(root: string): string | null {
  const goModPath = join(root, 'go.mod');
  if (!existsSync(goModPath)) return null;

  try {
    const content = readFileSync(goModPath, 'utf-8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('//')) continue;
      const m = line.match(/^module\s+(\S+)/);
      if (m) return m[1];
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 解析 Go 的 import 路径 → 项目内部的**包目录路径**。
 *
 * Go 的 import 路径**没有文件系统对应关系** —— 它是模块路径。
 * 判据（约定法，ADR-069 §3.1）：
 *
 * 1. import 路径以 `go.mod` 的 module path 开头 → **项目内部**
 *    去掉前缀后得到「包目录路径」
 * 2. 否则 → 外部依赖，不进模块图
 *
 * @returns 包目录路径（如 `internal/core`）；外部依赖返回 null
 */
export function resolveGoImport(
  specifier: string,
  goModulePath: string | null,
): string | null {
  if (!goModulePath) return null;
  if (!specifier.startsWith(goModulePath)) return null;

  const rest = specifier.slice(goModulePath.length).replace(/^\/+/, '');
  // 正好是模块根（如 `github.com/foo/bar`）→ 根目录
  return rest === '' ? '.' : rest;
}

/**
 * Go 的**平台后缀**（文件名以 `_平台.go` 结尾）。
 *
 * Go 官方约定：`_GOOS.go`、`_GOARCH.go`、`_GOOS_GOARCH.go` 是文件级构建约束。
 * 例如 `foo_linux.go` 只在 Linux 构建，`foo_windows.go` 只在 Windows 构建。
 *
 * 为什么要单独识别：同一个包里可能有平台专属实现。
 * 若把 `foo_linux.go` 与 `foo_windows.go` 的依赖都无条件算进去，
 * 两个互斥实现会形成**假的依赖环**。
 *
 * 判据：**只有文件名的最后一个下划线段**是已知平台名时才认 ——
 * `foo_bar_linux.go` 仍认（`linux` 是最后一段），
 * 但 `linux_helper.go` 不认（最后一段是 `helper`）。
 */
const GO_PLATFORM_SUFFIXES = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos', 'ios',
  'js', 'linux', 'nacl', 'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows',
  'unix',
]);

/** Go 的架构后缀 */
const GO_ARCH_SUFFIXES = new Set([
  '386', 'amd64', 'amd64p32', 'arm', 'arm64', 'arm64be', 'armbe', 'loong64', 'mips',
  'mips64', 'mips64le', 'mips64p32', 'mips64p32le', 'mipsle', 'ppc', 'ppc64',
  'ppc64le', 'riscv', 'riscv64', 's390', 's390x', 'sparc', 'sparc64', 'wasm',
]);

/**
 * 解析 Go 文件名上的平台 / 架构后缀。
 *
 * @returns 命中的约束名（如 `linux`、`amd64`、`linux_amd64`）；没有则返回 null
 */
export function parseGoFileConstraints(filePath: string): string | null {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (!fileName.endsWith('.go')) return null;

  const stem = fileName.slice(0, -'.go'.length);
  const parts = stem.split('_');
  if (parts.length < 2) return null;

  const constraints: string[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    const part = parts[i];
    if (GO_PLATFORM_SUFFIXES.has(part)) {
      constraints.unshift(part);
      continue;
    }
    if (GO_ARCH_SUFFIXES.has(part)) {
      constraints.unshift(part);
      continue;
    }
    break;
  }

  if (constraints.length === 0) return null;
  // 约束段必须连续贴着文件名末尾
  return constraints.join('_');
}

/**
 * 找出 Rust 的 **crate 根目录**（含 `Cargo.toml` 的目录）。
 *
 * ADR-069 §3.2：crate 根 = 含 `Cargo.toml` 的目录，
 * 它的 `src/` 就是模块树的起点。
 *
 * 多个 `Cargo.toml`（workspace）时取**最浅**的那个（workspace 顶层）。
 *
 * @returns 相对项目根的 crate 根目录（项目根时是空串）；找不到返回 null
 */
export function findCargoRoot(root: string): string | null {
  if (existsSync(join(root, 'Cargo.toml'))) return '';

  const candidates: Array<{ rel: string; depth: number }> = [];

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || isBuildDir(entry)) continue;
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (existsSync(join(full, 'Cargo.toml'))) {
        candidates.push({ rel: childRel, depth: depth + 1 });
      }
      walk(full, childRel, depth + 1);
    }
  };

  walk(root, '', 0);

  if (candidates.length === 0) return null;
  // 最浅的优先（workspace 顶层）；同深度按路径字典序（确定性，C3）
  candidates.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  return candidates[0].rel;
}

/**
 * 解析 Rust 的 `use` 路径。
 *
 * Rust 的模块树由文件路径决定：
 *
 * ```
 * src/
 *   main.rs        ← crate 根
 *   core/
 *     registry.rs  ← crate::core::registry
 * ```
 *
 * `crate::core::registry` → 找 `src/core/registry.rs` 或 `src/core/registry/mod.rs`。
 *
 * `super::` / `self::` 相对于**当前文件**的模块位置（ADR-082）：
 *
 * - `self::sibling` —— 当前文件所在模块下的 `sibling`
 *   （`src/foo/mod.rs` 里的 `self::bar` → `src/foo/bar.rs`）
 * - `super::parent` —— 上一级模块
 *   （`src/foo/bar.rs` 里的 `super::baz` → `src/foo/baz.rs`）
 *
 * Rust 的模块层级 ≠ 目录层级：`mod.rs` 代表目录，`foo.rs` + `foo/` 是同一模块的两种布局，
 * 两种都要认。
 *
 * @param specifier - import 说明符
 * @param fileSet - 项目里的源文件集合
 * @param cargoRoot - crate 根目录（相对项目根；null = 没找到）
 * @param fromFile - 引用该 import 的文件（解析 `self::` / `super::` 时需要）
 * @returns 解析到的文件路径（相对项目根）；解析不到返回 null
 */
export function resolveRustImport(
  specifier: string,
  fileSet: Set<string>,
  cargoRoot: string | null,
  fromFile?: string | null,
): string | null {
  // crate 根相对于项目根，可能是空串（crate 就在项目根）
  const srcRoots = cargoRoot === null ? ['src', ''] : [cargoRoot === '' ? 'src' : `${cargoRoot}/src`];

  // `crate` 本身 → crate 根的文件
  if (specifier === 'crate' || specifier === 'crate::') {
    for (const srcRoot of srcRoots) {
      for (const name of ['lib.rs', 'main.rs', 'mod.rs']) {
        const candidate = srcRoot ? `${srcRoot}/${name}` : name;
        if (fileSet.has(candidate)) return candidate;
      }
    }
    return null;
  }

  // `self::` / `super::` —— 相对于当前文件解析（ADR-082）
  if (specifier.startsWith('self::') || specifier.startsWith('super::')) {
    if (!fromFile) return null;
    return resolveRustRelativeImport(specifier, fromFile, fileSet);
  }

  // 只处理 `crate::` 开头的绝对路径
  if (!specifier.startsWith('crate::')) return null;

  const relPath = specifier.slice('crate::'.length);

  // `crate::mod` → crate 根的 mod.rs
  if (relPath === 'mod') {
    for (const srcRoot of srcRoots) {
      for (const name of ['mod.rs', 'lib.rs', 'main.rs']) {
        const candidate = srcRoot ? `${srcRoot}/${name}` : name;
        if (fileSet.has(candidate)) return candidate;
      }
    }
    return null;
  }

  // `crate::core::registry` → 路径 `core/registry`
  const segments = relPath.split('::').filter(Boolean);
  if (segments.length === 0) return null;

  // 路径可能指向**模块**，也可能指向**模块里的类型**：
  //   `use crate::core::registry;`        → 模块 `core::registry`
  //   `use crate::core::registry::Reg;`   → 类型 `Reg`（在模块 `core::registry` 里）
  //
  // 所以从长到短**逐级缩短**尝试：先试完整路径，再去掉最后一段。
  // 先命中的就是**最具体**的那个模块 —— 这与 Rust 的名字解析一致
  // （同名模块与类型同时存在时，`use` 指的是模块）。
  for (let take = segments.length; take >= 1; take--) {
    const modulePath = segments.slice(0, take).join('/');
    const hit = findRustModuleFile(modulePath, fileSet, srcRoots, cargoRoot);
    if (hit) return hit;
  }

  return null;
}

/**
 * 找 Rust 模块对应的文件。
 *
 * 候选形态：
 *   - `<src>/<modulePath>.rs`（`foo.rs` 布局）
 *   - `<src>/<modulePath>/mod.rs`（`foo/mod.rs` 布局）
 */
function findRustModuleFile(
  modulePath: string,
  fileSet: Set<string>,
  srcRoots: string[],
  cargoRoot: string | null,
): string | null {
  for (const srcRoot of srcRoots) {
    // ① 精确匹配：`<src>/<modulePath>.rs`
    const direct = srcRoot ? `${srcRoot}/${modulePath}.rs` : `${modulePath}.rs`;
    if (fileSet.has(direct)) return direct;

    // ② 模块目录：`<src>/<modulePath>/mod.rs`
    const modFile = srcRoot ? `${srcRoot}/${modulePath}/mod.rs` : `${modulePath}/mod.rs`;
    if (fileSet.has(modFile)) return modFile;
  }

  // ③ 没有 crate 根时按后缀猜（ADR-069 §3.2 的兜底）
  if (cargoRoot === null) {
    for (const path of fileSet) {
      if (path.endsWith(`/${modulePath}.rs`)) return path;
      if (path.endsWith(`/${modulePath}/mod.rs`)) return path;
    }
  }

  return null;
}

/**
 * 解析 Rust 的 `self::` / `super::` 相对路径。
 *
 * **Rust 模块层级 ≠ 目录层级**，这是本函数的核心难点：
 *
 * - `src/foo/mod.rs` —— 模块 `foo`；其子模块在 `src/foo/` 下
 * - `src/foo.rs`     —— 模块 `foo`（文件本身）；其子模块在 `src/foo/` 下
 * - `src/foo/bar.rs` —— 模块 `foo::bar`
 *
 * 规则（Rust 官方模块树的镜像）：
 * 1. 算出「当前文件所属模块的**目录**」：
 *    - `mod.rs` → 它所在的目录（`src/foo/mod.rs` → `src/foo`）
 *    - `foo.rs` → 它自己构成模块目录（`src/foo.rs` → `src/foo`）
 *    - `bar.rs` → 它所在的目录（`src/foo/bar.rs` → `src/foo`）
 * 2. `self::x` 在这个目录里找 `x.rs` 或 `x/mod.rs`；
 * 3. `super::x` 在**上一级模块目录**里找 `x.rs` 或 `x/mod.rs`；
 * 4. 多个 `super::` 逐级上跳。
 *
 * 找不到就返回 null（宁可漏边，不猜错边）。
 */
function resolveRustRelativeImport(
  specifier: string,
  fromFile: string,
  fileSet: Set<string>,
): string | null {
  const segments = specifier.split('::').filter(Boolean);
  if (segments.length === 0) return null;

  // 前缀可能是 `self` / `super` / `super::super` —— 逐段剥掉
  let baseDir = moduleDirOfRustFile(fromFile);
  let rest = segments;

  while (rest.length > 0 && (rest[0] === 'self' || rest[0] === 'super')) {
    const prefix = rest[0];
    rest = rest.slice(1);
    if (prefix === 'super') {
      baseDir = parentModuleDir(baseDir);
    }
    // `self` 不改变基准目录
  }

  if (rest.length === 0) {
    // `super` / `self` 指向模块本身 —— 找 `mod.rs`
    const modFile = baseDir ? `${baseDir}/mod.rs` : 'mod.rs';
    return fileSet.has(modFile) ? modFile : null;
  }

  // 路径可能指向**模块**，也可能指向**模块里的类型** ——
  // 从长到短逐级缩短尝试（与 `crate::` 同口径）。
  for (let take = rest.length; take >= 1; take--) {
    const path = modulePath(rest.slice(0, take));
    const hit = findRustModuleInDir(path, baseDir, fileSet);
    if (hit) return hit;
  }

  // 相对路径只在**模块上下文**里解析 —— 不做 crate 根兜底，
  // 否则 `src/foo/bar.rs` 里的 `super::baz` 会错误地落到 `src/baz.rs`。
  return null;
}

/** 把段数组拼成路径 */
function modulePath(segments: string[]): string {
  return segments.join('/');
}

/** 在指定目录里找 Rust 模块文件 */
function findRustModuleInDir(
  modulePath: string,
  dir: string,
  fileSet: Set<string>,
): string | null {
  const direct = dir ? `${dir}/${modulePath}.rs` : `${modulePath}.rs`;
  if (fileSet.has(direct)) return direct;

  const modFile = dir ? `${dir}/${modulePath}/mod.rs` : `${modulePath}/mod.rs`;
  if (fileSet.has(modFile)) return modFile;

  return null;
}

/**
 * Rust 文件所属模块的**目录**。
 *
 * - `src/foo/mod.rs` → `src/foo`（模块 `foo` 的目录就是它所在的目录）
 * - `src/foo.rs`     → `src/foo`（模块 `foo` 由这个文件构成，
 *                      它的子模块在 `src/foo/` 下）
 * - `src/foo/bar.rs` → `src/foo`（模块 `foo::bar` 在目录 `src/foo` 下）
 */
function moduleDirOfRustFile(fromFile: string): string {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const base = fromFile.slice(fromFile.lastIndexOf('/') + 1);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  // 普通文件：文件名（去扩展名）就是模块名，模块目录 = 目录 + 文件名
  const stem = base.replace(/\.rs$/, '');
  return dir ? `${dir}/${stem}` : stem;
}

/**
 * 上一级模块目录。
 *
 * `src/foo/bar` → `src/foo`；
 * `src/foo`     → `src`；
 * `src`         → `''`（crate 根）。
 */
function parentModuleDir(dir: string): string {
  if (!dir) return '';
  const index = dir.lastIndexOf('/');
  if (index === -1) return '';
  return dir.slice(0, index);
}

/**
 * Java / Kotlin 的包路径 → 项目内部文件。
 *
 * Java / Kotlin 的 import 是**全限定包名**（如 `com.example.core.Foo`），
 * 它与文件系统的对应关系取决于布局：
 *
 * - Gradle / Maven 常规布局：`src/main/java/<pkg>/<Class>.java`
 * - Kotlin 常见布局：`src/<pkg>/<Class>.kt`
 *
 * **判不准时宁可漏边，也不要判错边** —— 判错边会产生假的「环」。
 * 所以这里只做**确定性的路径候选匹配**：
 *
 * 1. 包名最后一段是类名 → 前面是包路径；
 * 2. 候选目录按约定枚举：`src/main/java`、`src/main/kotlin`、`src/test/java`、
 *    `src/test/kotlin`、`src`；
 * 3. 候选文件名依次试 `.java` / `.kt`；
 * 4. 全部命中不了就返回 null（漏边，不猜）。
 *
 * 通配符 import（`a.b.*`）解析不到具体类 —— 返回 null（漏边，不猜）。
 */
export function resolveJavaImport(
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier || specifier.endsWith('.*')) return null;

  const segments = specifier.split('.').filter(Boolean);
  if (segments.length < 2) return null;

  const className = segments[segments.length - 1];
  const packagePath = segments.slice(0, -1).join('/');
  if (!packagePath) return null;

  // 约定的源码根目录（Gradle / Maven / Kotlin 常见布局）
  const sourceRoots = [
    'src/main/java',
    'src/main/kotlin',
    'src/test/java',
    'src/test/kotlin',
    'src',
  ];

  for (const sourceRoot of sourceRoots) {
    const dir = `${sourceRoot}/${packagePath}`;
    for (const ext of ['.java', '.kt']) {
      const candidate = `${dir}/${className}${ext}`;
      if (fileSet.has(candidate)) return candidate;
    }
  }

  // 兜底：按**路径后缀**匹配 —— 包路径后缀 + 类名。
  //
  // 真实项目的源码根不一定在 `src/main/java`（多模块 Gradle 常见
  // `core/src/main/java/...`，也可能直接 `core/com/example/...`）。
  // 这里只认**唯一命中**的后缀 —— 多个候选说明布局有歧义，
  // 宁可漏边也不猜错边（假边会产生假的「环」）。
  const suffixes = ['.java', '.kt'].map((ext) => `/${packagePath}/${className}${ext}`);
  let matched: string | null = null;
  for (const path of fileSet) {
    if (!suffixes.some((suffix) => path.endsWith(suffix))) continue;
    if (matched !== null) return null; // 多个命中 → 歧义，不猜
    matched = path;
  }
  if (matched) return matched;

  return null;
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

  // include 根目录（ADR-062）：C++ 的 `#include "nimrtc/core/x.hpp"`
  // 靠它才能解析到真实文件。
  const includeRoots = discoverIncludeRoots(root);

  // Go 模块路径（ADR-069）：`go.mod` 的 module 行。
  // import 路径以它开头 → 项目内部；否则外部依赖。
  const goModulePath = findGoModulePath(root);

  // Rust crate 根（ADR-069）：含 `Cargo.toml` 的目录，其 `src/` 是模块树起点。
  const cargoRoot = findCargoRoot(root);

  // vendor 目录（ADR-065）：引入的外部代码，不是项目的架构。
  //
  // **不扫它们的内部结构** —— 但**要计入覆盖率**（`vendorFiles`），
  // 否则报告会说「这个项目只有 47 个 C++ 文件」，那更不真实。
  const vendorDirs = discoverVendorDirs(root);
  // ADR-065：vendor 文件按**语言类别**分出来，而不是按「是不是源文件」——
  //
  // Rust / Go / Java 扫描器读不懂，但它们**仍然要在覆盖率里有个交代**。
  // 只筛「源文件」的话，vendor 里的 Rust 文件会漏出去，
  // 于是报告里冒出「76 个 Rust 文件没验证」—— 而它们在 vendor 里，
  // 根本不参与架构检查。
  const vendorFiles = allFiles.filter((path) => isVendorPath(path, vendorDirs));
  const projectSourceFiles = sourceFiles.filter((path) => !isVendorPath(path, vendorDirs));

  /**
   * **vendor 模块** —— 设计里声明了、但整个模块都是 vendor 目录的模块
   *
   * 判据：模块的**名字**本身就是 vendor 目录（或它的父目录），
   * 或者模块声明的路径**全部**落在 vendor 目录里。
   *
   * 真实项目里设计会写 `### src/third_party`（职责：第三方库集成）。
   * 这个模块是**外部边界**，不是架构的一部分：
   *   - 别的模块依赖它 → 那是「用了第三方库」，不是架构耦合
   *   - 它依赖别的模块 → 那是第三方库的设计，不是这个项目的
   */
  const vendorModules = modules
    .filter((mod) => {
      // 判据一：模块名落在 vendor 目录里（如 `src/third_party`）
      if (isVendorPath(mod.name, vendorDirs)) return true;
      // 判据二：模块声明的路径全部落在 vendor 目录里
      if (mod.filePatterns.length === 0) return false;
      return mod.filePatterns.every((pattern) => {
        // 去掉 glob 后缀再比（`src/third_party/**/*` → `src/third_party`）
        const bare = pattern.replace(/\/?\*+.*$/, '').replace(/\/$/, '');
        return bare.length > 0 && isVendorPath(bare, vendorDirs);
      });
    })
    .map((mod) => mod.name);

  const vendorModuleSet = new Set(vendorModules);

  // ─── 第一遍：先定归属 ──────────────────────────────────────────────────
  // 归属必须先全部算完再算依赖 —— 否则「a 引用 b」这种边会因为
  // b 的文件还没扫到而被丢掉（文件是按字典序遍历的）。
  const ownerOf = new Map<string, string | null>();
  const scanned: ScannedFile[] = [];
  const moduleFiles = new Map<string, string[]>();
  const moduleCodeFiles = new Map<string, string[]>();
  const moduleVerifiedFiles = new Map<string, string[]>();
  const moduleProductionFiles = new Map<string, string[]>();
  for (const mod of modules) {
    moduleFiles.set(mod.name, []);
    moduleCodeFiles.set(mod.name, []);
    moduleVerifiedFiles.set(mod.name, []);
    moduleProductionFiles.set(mod.name, []);
  }

  for (const path of allFiles) {
    const lang = detectLang(path);

    // ADR-065：vendor 文件**不参与模块图** ——
    // 它的内部依赖不是这个项目的设计决策。
    //
    // 但它**仍然计入覆盖率**（`vendorFiles`）——
    // 报告要能说清「多少文件没参与验证」，其中多少是 vendor。
    if (isVendorPath(path, vendorDirs)) {
      ownerOf.set(path, null);
      continue;
    }

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
    const isTest = isTestFile(path);
    if (isCode && owner) moduleCodeFiles.get(owner)?.push(path);

    if (lang) {
      scanned.push({ path, lang, module: owner, ambiguousWith, isTest });
      if (owner) moduleVerifiedFiles.get(owner)?.push(path);
    }
    if (owner) {
      moduleFiles.get(owner)?.push(path);
      // ADR-066：**生产代码文件**单独记一份 ——
      // 一个模块如果**全是**测试文件，它在依赖图里就不产生任何边，
      // 于是它声明的依赖会全部报「缺失依赖」—— 假阳性。
      // 用这份清单判断「这个模块有没有生产代码」。
      if (!isTest) moduleProductionFiles.get(owner)?.push(path);
    }
  }

  // ─── 第二遍：算依赖 ────────────────────────────────────────────────────
  const moduleNames = modules.map((m) => m.name);
  const edgeMap = new Map<string, ModuleEdge>();
  const unresolved: Array<{ file: string; specifier: string }> = [];

  for (const file of scanned) {
    const path = file.path;
    const owner = file.module;

    // ADR-066：**测试文件不产生依赖边** ——
    // 测试引用被测对象是测试的本职，不构成架构耦合。
    //
    // 真实证据（nimrtc-zelto 实战演练）：
    //   `src/plugins/tests/test_zero_copy_surface_path.cpp` 包含
    //   video_frame 模块的公开头 —— 这一行伪造出
    //   `src/plugins → src/modules` 边，进而伪造出两个「依赖成环」，
    //   并让「修这个违反的切片」自己被该违反拦住（死锁）。
    //
    // 测试文件**仍然归属到模块**、计入文件数与覆盖统计 ——
    // 只是不成为依赖边的来源。
    if (isTestFile(path)) continue;

    // ADR-138：**工具脚本也不产生依赖边** ——
    // 一个检查脚本读项目的模块，是这个脚本的**本职**（与测试同理）。
    //
    // 真实场景：`tools/check_engine_layering.py` 要读 `src/engine/src/**`
    // 才能检查分层；`scripts/api_freeze_scan.js` 要扫 `src/**` 的 API。
    // 这类引用**不是架构耦合** —— 它不构成「模块 A 依赖模块 B」。
    //
    // 与测试文件同一判据：引用被操作对象是脚本的本职。
    //
    // 注意：多数项目里工具目录不被任何模块认领，脚本自身 owner 为 null，
    // 那时边自然不会产生（`owner` 为空即跳过）。但若设计真的声明了
    // `tools/**` 模块，脚本就会拿到 owner 并产生边 —— 那是**假边**，
    // 会伪造成「未声明依赖」甚至假环。所以这里显式排除。
    if (isToolingFile(path)) continue;

    let source: string;
    try {
      source = readFileSync(join(root, path), 'utf-8');
    } catch {
      continue;
    }

    for (const ref of parseImports(source, file.lang)) {
      let targetModule: string | null = null;

      if (file.lang === 'cpp') {
        // C++ 的 `#include` —— 项目内依赖
        //
        // ADR-062 §3.2（修正）：尖括号**也可能是**项目内部头文件
        //（真实项目 1081 条），所以两种都要解析；
        // 解析不到的自然就是外部依赖（系统头 / 第三方库），不进模块图。
        const resolved = resolveCppInclude(
          path,
          ref.specifier,
          fileSet,
          includeRoots,
          ref.cppBracket ?? '"',
        );
        if (!resolved) {
          // 解析不到 = 外部依赖（系统头）—— 不算「未解析」，只是不进模块图
          continue;
        }
        const targetModuleOwner = ownerOf.get(resolved) ?? null;
        if (!targetModuleOwner) {
          // 目标文件不在任何模块里 —— 记成未认领，不算模块依赖
          continue;
        }
        targetModule = targetModuleOwner;
      } else if (file.lang === 'go') {
        // Go 的 import —— 模块路径（ADR-069 §3.1）
        //
        // import 路径以 `go.mod` 的 module path 开头 → 项目内部，
        // 去掉前缀得到包目录路径 → 按目录匹配模块归属。
        //
        // 匹配不到就是外部依赖（第三方库）—— 不进模块图。
        //
        // ADR-082：**平台专属文件**（`_linux.go` / `_windows.go`）产生的边
        // 只在对应平台成立。同一个包里若两个平台专属实现互指，
        // 它们在各自平台上是**互斥**的 —— 算成无条件边会误报「环」。
        //
        // 判据：「这条边是否在**所有平台**都成立」。
        //   - 源文件没有平台约束 → 边无条件成立；
        //   - 源文件有平台约束 → 边只在该平台成立。
        // 目标文件也有平台约束时同理。
        const packageDir = resolveGoImport(ref.specifier, goModulePath);
        if (packageDir === null) continue; // 外部依赖

        // 按目录归属：包目录下的文件属于哪个模块
        const prefix = packageDir === '.' ? '' : `${packageDir}/`;
        const owners = new Set<string>();
        for (const mod of modules) {
          for (const file of moduleFiles.get(mod.name) ?? []) {
            if (file.startsWith(prefix)) owners.add(mod.name);
          }
        }
        if (owners.size !== 1) continue; // 判不出归属 → 不算依赖边
        targetModule = [...owners][0];
      } else if (file.lang === 'rust') {
        // Rust 的 use / extern crate —— crate 内部路径（ADR-069 §3.2）
        //
        // `crate::core::registry` → 找 `src/core/registry.rs`
        // （或 `src/core/registry/mod.rs`）
        if (ref.kind !== 'relative') {
          // `std::` 走 builtin 分支；`package`（外部 crate）不进模块图
          continue;
        }
        const resolved = resolveRustImport(ref.specifier, fileSet, cargoRoot, path);
        if (!resolved) continue; // 解析不到 → 不进模块图
        const targetModuleOwner = ownerOf.get(resolved) ?? null;
        if (!targetModuleOwner) continue;
        targetModule = targetModuleOwner;
      } else if (file.lang === 'java') {
        // Java / Kotlin 的 import —— 全限定包名 → 约定布局下的类文件
        //
        // ADR-082：包路径 → 目录 → 类文件。
        // 判不准时**宁可漏边**，不猜错边（假边会产生假的「环」）。
        const resolved = resolveJavaImport(ref.specifier, fileSet);
        if (!resolved) continue; // 解析不到 → 外部依赖或通配符，不进模块图
        const targetModuleOwner = ownerOf.get(resolved) ?? null;
        if (!targetModuleOwner) continue;
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

      // ADR-065：**vendor 模块不是架构的一部分** ——
      // 「用了第三方库」不是架构耦合，不该进模块图。
      //
      // 目标侧是 vendor → 那是外部边界，不是项目内部的依赖
      // 来源侧是 vendor → 那是第三方库内部的结构，不是这个项目的设计
      const ownerIsVendor = vendorModuleSet.has(owner);
      const targetIsVendor = vendorModuleSet.has(targetModule);
      if (ownerIsVendor || targetIsVendor) continue;

      const key = `${owner}→${targetModule}`;
      const edge = edgeMap.get(key) ?? {
        from: owner,
        to: targetModule,
        files: [],
        specifiers: [],
      };
      if (!edge.files.includes(path)) edge.files.push(path);
      if (!edge.specifiers.includes(ref.specifier)) edge.specifiers.push(ref.specifier);

      // ADR-064：条件编译的边**仍然算依赖**（开启特性时它就在），
      // 但要记下条件 —— 报告里能说清「这条边只在开启 X 时存在」。
      //
      // ADR-069：`condition` 是通用字段（Go 的 `//go:build`、Rust 的 `#[cfg]`）；
      // `cppCondition` 是 C++ 的旧名，保留为兼容别名。
      //
      // ADR-082：Go 的**平台专属文件**（`_linux.go` / `_windows.go`）
      // 同样按「条件」处理：这条边只在对应平台成立，
      // 不是「所有平台都成立」的边 —— 否则互斥的平台实现会误报成环。
      //
      // 区分两种情况：
      //   - 边同时有无条件的和条件的来源 → 不是「条件边」
      //   - 边**只有**条件来源 → 「条件边」（conditionalOnly）
      const condition = ref.condition ?? ref.cppCondition ?? goFileConstraint(path, file.lang);
      if (condition) {
        edge.conditions ??= [];
        if (!edge.conditions.includes(condition)) {
          edge.conditions.push(condition);
        }
        edge.conditionalSources = (edge.conditionalSources ?? 0) + 1;
      } else {
        edge.unconditionalSources = (edge.unconditionalSources ?? 0) + 1;
      }

      edgeMap.set(key, edge);
    }
  }

  const edges = [...edgeMap.values()]
    .map((e): ModuleEdge => {
      // 只有条件来源、且确实没有无条件来源 → 条件边
      const hasUnconditional = (e.unconditionalSources ?? 0) > 0;
      const hasConditional = (e.conditionalSources ?? 0) > 0;
      if (hasConditional && !hasUnconditional) {
        return { ...e, conditionalOnly: true };
      }
      if (hasConditional && hasUnconditional) {
        // 混合边：整体不是条件边，但记下条件供参考
        return { ...e, conditionalOnly: false };
      }
      return e;
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // ADR-066：测试文件**不属于架构耦合**，所以「没有模块认领」也不是偏离。
  //
  // 真实证据（nimrtc-zelto 实战演练）：zelto 自身生成的验收骨架
  // `tests/acceptance/<slice>/acceptance.test.cjs` 不可能被任何设计模块认领
  // （它不是生产代码），却让**每个切片**在门禁上被自己判成
  // 「文件无归属（deny）」而 blocked —— 修这个 trigger 的切片自己过不去。
  //
  // 与依赖边同一判据：测试文件仍计入文件数与覆盖统计，只是不产生偏离。
  //
  // ADR-138：工具脚本（`tools/` `scripts/`）同理 —— 它们不是架构的一部分，
  // 没有「依赖谁」「被谁依赖」，只是开发期操作这个项目的脚本。
  //
  // 真实证据（nimrtc-v14 靶子项目，2026-11-28）：`tools/` 76 个 +
  // `scripts/` 15 个文件无归属。任何改工具脚本的切片都被这条偏离拦住
  // （自锁）—— 而成因是**扫描器的归属模型覆盖不到工具目录**，
  // 不是那片切片真的违反了架构。
  //
  // 注意这里的不对称：文档与构建脚本因为「扫描器读不懂」（detectLang 返回 null）
  // 从来不进 `scanned`，所以从不被拦；工具脚本恰好是 Python / JS，
  // **扫描器读得懂，于是成了唯一被拦的一类**。那是实现细节的泄漏。
  //
  // 三者（测试 / 工具脚本 / vendor）判据一致：**不是这个项目的架构的东西，
  // 就不是这个项目的架构偏离** —— 但都仍然计入文件数与覆盖统计。
  const unmapped = scanned
    .filter((f) => f.module === null && !f.isTest && !isToolingFile(f.path))
    .map((f) => f.path);

  return {
    files: scanned,
    moduleFiles,
    moduleCodeFiles,
    moduleVerifiedFiles,
    moduleProductionFiles,
    edges,
    unmapped,
    unresolved,
    coverage: computeCoverage(allFiles, scanned, vendorFiles),
    vendorDirs,
    vendorFiles,
    vendorModules,
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
function computeCoverage(
  allFiles: string[],
  scanned: ScannedFile[],
  vendorFiles: string[] = [],
): LangCoverage {
  const counts = {} as Record<LangCategory, number>;
  // 注意：这里要**遍历数组本身**，不能用 `Object.keys(LANG_CATEGORY_KEYS)` ——
  // 那是数组的索引（"0".."9"），不是元素值。用错了会往 counts 里塞
  // 一堆 "0".."9" 的假键。
  for (const category of LANG_CATEGORY_KEYS) {
    counts[category] = 0;
  }

  // ADR-065：vendor 文件**单独计数**，不混进各语言类别 ——
  //
  // 真实项目里 `src/third_party` 有 4434 个 C++ 文件，占全项目 C++ 的 97%。
  // 混进「C / C++ 4481 个文件（依赖已验证）」里，读起来像
  // 「这个项目的 C++ 代码验过了」—— 而实际上项目自己的 C++ 只有 47 个。
  //
  // 所以：各语言类别只数**项目自己的**文件，vendor 单独一行报。
  //
  // ADR-066：**测试文件也单独计数** —— 理由同上：
  // 测试文件不参与依赖验证（它们不产生依赖边），
  // 混进分母会让「覆盖率」失真。
  //
  // ADR-138：**工具脚本同样单独计数** —— 理由同上：
  // 工具脚本不参与依赖验证（ADR-138：脚本读被操作对象是脚本的本职），
  // 而且它们不是架构的一部分 —— 混进分母会让「覆盖率」失真。
  const vendorSet = new Set(vendorFiles);
  const testSet = new Set(scanned.filter((f) => f.isTest).map((f) => f.path));
  // ADR-138：工具脚本不参与架构判定 —— 单独计数，不混进语言分母。
  const toolingSet = new Set(scanned.filter((f) => isToolingFile(f.path)).map((f) => f.path));
  for (const path of allFiles) {
    if (vendorSet.has(path)) continue;
    if (testSet.has(path)) continue;
    if (toolingSet.has(path)) continue;
    const category = classifyLangCategory(path);
    counts[category] = (counts[category] ?? 0) + 1;
  }

  // 已参与 import 图的类别 —— 这些就是「有判据」的
  const verifiable = LANG_CATEGORY_KEYS.filter((category) => {
    if (!isVerifiableLang(category)) return false;
    return scanned.some((f) => classifyLangCategory(f.path) === category);
  });

  // 代码类但验不了的：C#（有 `using` 语义，扫描器还没实现解析）
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
    // ADR-066：`verifiedFiles` 只数**生产代码**里参与 import 图的文件 ——
    // 测试文件不产生依赖边，算进来会虚报「验证了这么多」。
    //
    // ADR-138：工具脚本同理 —— 它们不产生依赖边，也不算进「已验证」。
    verifiedFiles: scanned.filter((f) => !f.isTest && !isToolingFile(f.path)).length,
    unverifiableCodeFiles,
    nonCodeFiles,
    totalFiles: allFiles.length,
    // ADR-065：vendor 文件**单独计数** ——
    // 它们没参与验证，但它们**不是**「这个工具没判据」，
    // 而是「这些是引入的外部代码，本来就不该算进架构」。
    vendorFiles: vendorFiles.length,
    // ADR-066：测试文件**单独计数** ——
    // 它们没参与验证，但它们**不是**「这个工具没判据」，
    // 而是「这些是测试，不构成架构耦合」。
    testFiles: testSet.size,
    // ADR-138：工具脚本**单独计数** ——
    // 它们没参与验证，但它们**不是**「这个工具没判据」，
    // 而是「这些是开发期工具脚本，不是架构的一部分」。
    toolingFiles: toolingSet.size,
  };
}

/**
 * Go 文件的平台专属约束（ADR-082）。
 *
 * 非 Go 文件或没有平台后缀时返回 null（= 无条件）。
 */
function goFileConstraint(path: string, lang: string): string | null {
  if (lang !== 'go') return null;
  return parseGoFileConstraints(path);
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
  'csharp',
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

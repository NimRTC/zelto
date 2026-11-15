// import 解析 —— 架构扫描的第一步
//
// 目标：从源码文本里抽出「这个文件 import 了什么」。
// 纯正则 + 字符串判定，不解析 AST（core/ 零第三方依赖，装不起解析器）。
//
// 只做「够用」的解析：能分清相对路径、包名、内置模块三类，
// 够用来算模块之间的依赖关系就够了。

import type { ImportRef, SourceLang } from './types.js';

/** Node 内置模块（够用的那一批） */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** Python 标准库（够用的那一批） */
const PYTHON_STDLIB = new Set([
  'abc', 'argparse', 'asyncio', 'base64', 'collections', 'contextlib', 'copy', 'csv', 'dataclasses',
  'datetime', 'enum', 'functools', 'glob', 'hashlib', 'http', 'importlib', 'inspect', 'io', 'itertools',
  'json', 'logging', 'math', 'os', 'pathlib', 'pickle', 'platform', 'random', 're', 'shutil', 'socket',
  'sqlite3', 'string', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading', 'time', 'typing',
  'unittest', 'urllib', 'uuid', 'warnings', 'xml',
]);

/**
 * 判定源码语言。识别不了就返回 null（不扫）。
 *
 * ADR-062：C / C++ 也参与 import 图（`#include` 语义）。
 * 头文件（`.h` / `.hpp`）同样要算 —— C++ 项目里头文件占相当比例
 * （真实项目 `src/core` 的 13 个代码文件里 10 个是 `.hpp`）。
 */
export function detectLang(filePath: string): SourceLang | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'ts';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'ts';
  if (lower.endsWith('.py')) return 'python';
  if (CPP_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))) return 'cpp';
  return null;
}

/** C / C++ 的扩展名（小写，含点） */
const CPP_EXTENSIONS = new Set([
  '.c', '.h', '.cc', '.cpp', '.cxx', '.ccc',
  '.hpp', '.hh', '.hxx', '.h++', '.ipp', '.tpp', '.inl',
]);

/**
 * 文件的**语言类别** —— 比 `detectLang` 粗，用于报告「哪些文件验不了」。
 *
 * 为什么要与 `detectLang` 分开：`detectLang` 回答「这个文件能不能参与
 * import 图」（能扫就返回语言），而这里回答「这个文件属于哪一类语言」。
 *
 * 后者覆盖**所有**文件类型（包括扫不了的），这样报告才能说清
 * 「377 个 C++ 文件没能验证依赖」—— 而不是让人从「无法验证」的
 * 数量里自己推断。
 *
 * ADR-060 §4 方案 A：把「验不了」变成一句明说的话。
 */
export type LangCategory =
  | 'typescript'    // TS / JS —— 有 import 语义，已支持
  | 'python'        // Python —— 有 import 语义，已支持
  | 'cpp'           // C / C++ —— 有 include 语义，**尚未支持**
  | 'go'            // Go —— 有 import 语义，尚未支持
  | 'rust'          // Rust —— 有 use/mod 语义，尚未支持
  | 'java'          // Java / Kotlin —— 有 import 语义，尚未支持
  | 'build'         // 构建脚本 —— 不产生模块依赖边
  | 'doc'           // 文档 —— 不产生模块依赖边
  | 'config'        // 配置文件 —— 不产生模块依赖边
  | 'other';        // 其余

/** 文件扩展名 → 语言类别 */
const LANG_BY_EXTENSION: Record<string, LangCategory> = {
  // TypeScript / JavaScript
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'typescript', jsx: 'typescript', mjs: 'typescript', cjs: 'typescript',
  // Python
  py: 'python', pyi: 'python',
  // C / C++
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp',
  hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ipp: 'cpp', inl: 'cpp',
  m: 'cpp', mm: 'cpp',
  // Go
  go: 'go',
  // Rust
  rs: 'rust',
  // Java / Kotlin
  java: 'java', kt: 'java', kts: 'java',
  // 构建脚本
  cmake: 'build', mk: 'build', bzl: 'build', bazel: 'build', ninja: 'build',
  gyp: 'build', gypi: 'build', gradle: 'build',
  // 文档
  md: 'doc', mdx: 'doc', rst: 'doc', adoc: 'doc', txt: 'doc',
  // 配置
  json: 'config', jsonc: 'config', json5: 'config',
  yaml: 'config', yml: 'config', toml: 'config', ini: 'config', cfg: 'config',
  conf: 'config', env: 'config', properties: 'config',
  xml: 'config', lock: 'config', sum: 'config', mod: 'config',
};

/**
 * 特殊文件名 → 语言类别。
 *
 * 这些文件的扩展名会误导分类：
 *   `CMakeLists.txt` —— 扩展名 `.txt`（文档类），实际是构建脚本
 *   `Makefile`      —— 没有扩展名
 *   `Dockerfile`    —— 没有扩展名
 */
const LANG_BY_FILENAME: Record<string, LangCategory> = {
  makefile: 'build',
  gnumakefile: 'build',
  bsdmakefile: 'build',
  dockerfile: 'build',
  containerfile: 'build',
  cmakelists: 'build',
  'cmakelists.txt': 'build',
  meson: 'build',
  'meson.build': 'build',
  'build.gradle': 'build',
  'settings.gradle': 'build',
  license: 'doc',
  'license.md': 'doc',
  readme: 'doc',
  'readme.md': 'doc',
  changelog: 'doc',
  'changelog.md': 'doc',
};

/**
 * 判定一个文件属于哪一类语言。
 *
 * @param filePath 相对项目根的路径
 * @returns 语言类别；识别不出返回 'other'
 */
export function classifyLangCategory(filePath: string): LangCategory {
  const lower = filePath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);

  // 特殊文件名优先于扩展名 ——
  // `CMakeLists.txt` 的扩展名是 `.txt`（文档类），但它其实是构建脚本。
  // 先判扩展名会把它归错类。
  const byName = LANG_BY_FILENAME[base];
  if (byName) return byName;

  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const byExt = LANG_BY_EXTENSION[ext];
    if (byExt) return byExt;
  }
  return 'other';
}

/**
 * 这个语言类别**能不能参与依赖验证**。
 *
 * 只有已实现 import 解析的语言才算。
 *
 * ADR-062：C/C++ 也算 —— `#include` 语义已支持。
 */
export function isVerifiableLang(category: LangCategory): boolean {
  return category === 'typescript' || category === 'python' || category === 'cpp';
}

/**
 * 这个语言类别**是不是「代码」** —— 它的依赖关系本该被验证。
 *
 * 与之相对的是构建脚本 / 文档 / 配置 —— 那些文件不产生依赖边，
 * 「没验」是正常的，不该混进「验不了」的警告里稀释掉重点。
 *
 * ADR-061：模块概况里的「代码文件数」用它判定 ——
 * `.cpp` / `.hpp` 是代码（扫描器只是读不懂），
 * `README.md` / `config.json` 不是代码。
 */
export function isCodeLangCategory(category: LangCategory): boolean {
  return (
    category === 'typescript' ||
    category === 'python' ||
    category === 'cpp' ||
    category === 'go' ||
    category === 'rust' ||
    category === 'java'
  );
}

/**
 * 抽出源码里的 import 说明符。
 *
 * TS/JS 覆盖：import ... from 'x'、import 'x'、export ... from 'x'、
 * require('x')、动态 import('x')。
 * Python 覆盖：from a.b import c、import a.b。
 * C/C++ 覆盖（ADR-062）：#include "x"（项目内）、#include <x>（系统头）。
 */
export function parseImports(source: string, lang: SourceLang): ImportRef[] {
  if (lang === 'python') return parsePythonImports(source);
  if (lang === 'cpp') return parseCppIncludes(source);
  return parseTsImports(source);
}

/**
 * C/C++ 的 `#include` 解析。
 *
 * 两种形态，语义完全不同：
 *
 *   `#include "foo.hpp"`  —— **项目内**依赖，要解析成模块边
 *   `#include <mutex>`    —— **系统头**，不属于本项目，不产生边
 *
 * 这个区分是关键：`<...>` 全是系统头（标准库 / 第三方库），
 * 如果把它们也当成项目依赖，每个 `.cpp` 都会连到「系统」，
 * 整张图变成噪声。
 *
 * 注意 `#include` 可以在**任何位置**（不只在文件头）——
 * 条件编译块里也有，所以不锚定行首。
 */
function parseCppIncludes(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const pattern = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"]+)[>"]/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (!specifier) continue;
    refs.push({
      specifier,
      // 系统头 = 外部依赖（跟 TS 的 builtin / package 同类，不进模块图）
      kind: match[1] === '<' ? 'builtin' : 'relative',
      line: lineOf(source, match.index ?? 0),
    });
  }
  return dedupe(refs);
}

function parseTsImports(source: string): ImportRef[] {  const refs: ImportRef[] = [];
  const patterns: RegExp[] = [
    // import ... from 'x'
    /(?:^|[\s;])import\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    // export ... from 'x'
    /(?:^|[\s;])export\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    // import 'x'（副作用导入）
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
    // require('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // 动态 import('x')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      refs.push({
        specifier,
        kind: classifySpecifier(specifier),
        line: lineOf(source, match.index ?? 0),
      });
    }
  }
  return dedupe(refs);
}

function parsePythonImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const patterns: RegExp[] = [
    // from a.b import c / from . import c / from .mod import c
    /(?:^|[\s;])from\s+([.\w]+)\s+import\s/g,
    // import a.b
    /(?:^|[\s;])import\s+([.\w]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      refs.push({
        specifier,
        kind: classifyPythonSpecifier(specifier),
        line: lineOf(source, match.index ?? 0),
      });
    }
  }
  return dedupe(refs);
}

/** 归类 TS/JS 说明符 */
export function classifySpecifier(specifier: string): ImportRef['kind'] {
  if (specifier.startsWith('.')) return 'relative';
  if (specifier.startsWith('node:')) return 'builtin';
  const base = specifier.split('/')[0];
  if (NODE_BUILTINS.has(base)) return 'builtin';
  return 'package';
}

/** 归类 Python 说明符 */
export function classifyPythonSpecifier(specifier: string): ImportRef['kind'] {
  if (specifier.startsWith('.')) return 'relative';
  const base = specifier.split('.')[0];
  if (PYTHON_STDLIB.has(base)) return 'builtin';
  return 'package';
}

/**
 * 包说明符 → 模块名的启发式匹配。
 *
 * 纯字符串判定：先按完整说明符比，再按最后一段比（`@app/db` → `db`）。
 * 比不出来就返回 null —— 宁可漏一条边，也不猜错一条边。
 */
export function matchModuleBySpecifier(specifier: string, moduleNames: string[]): string | null {
  const cleaned = specifier.replace(/^\.[./]*/, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const candidates = [cleaned, segments[segments.length - 1]];
  // 去掉 @scope/ 前缀再取一段
  if (segments.length >= 2) candidates.push(segments[segments.length - 2]);

  const lowered = moduleNames.map((name) => name.toLowerCase());
  for (const candidate of candidates) {
    const idx = lowered.indexOf(candidate.toLowerCase());
    if (idx >= 0) return moduleNames[idx];
  }
  // 名称里带斜杠的模块（'core/slice'）再试一次后缀匹配
  for (const candidate of candidates) {
    const idx = lowered.findIndex((name) => name.endsWith(`/${candidate.toLowerCase()}`));
    if (idx >= 0) return moduleNames[idx];
  }
  return null;
}

/**
 * 找到某个下标所在的行号（1 基）。
 *
 * 传进来的是**匹配起点**——正则里的 `(?:^|[\s;])` 会把匹配前那个分隔符
 * （常常正是换行）一起吃掉，所以要连它一起数，否则第二行的 import
 * 会被算成第一行。
 */
function lineOf(source: string, index: number): number {
  let line = 1;
  const limit = Math.min(index + 1, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** 去重：同一文件里同一个说明符只算一次 */
function dedupe(refs: ImportRef[]): ImportRef[] {
  const seen = new Set<string>();
  const result: ImportRef[] = [];
  for (const ref of refs) {
    const key = `${ref.specifier}@${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result.sort((a, b) => a.line - b.line);
}

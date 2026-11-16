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
 *
 * ADR-069：Go（`.go`）与 Rust（`.rs`）也参与。
 */
export function detectLang(filePath: string): SourceLang | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'ts';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'ts';
  if (lower.endsWith('.py')) return 'python';
  if (CPP_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))) return 'cpp';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
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
 * ADR-069：Go / Rust 也算 —— `import` / `use` 语义已支持。
 */
export function isVerifiableLang(category: LangCategory): boolean {
  return (
    category === 'typescript' ||
    category === 'python' ||
    category === 'cpp' ||
    category === 'go' ||
    category === 'rust'
  );
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
 * Go 覆盖（ADR-069）：import "x"、import ( ... ) 块、带别名的 import。
 * Rust 覆盖（ADR-069）：use ...;、extern crate ...;。
 */
export function parseImports(source: string, lang: SourceLang): ImportRef[] {
  if (lang === 'python') return parsePythonImports(source);
  if (lang === 'cpp') return parseCppIncludes(source);
  if (lang === 'go') return parseGoImports(source);
  if (lang === 'rust') return parseRustImports(source);
  return parseTsImports(source);
}

/**
 * C/C++ 的 `#include` 解析。
 *
 * ADR-062 §3.2（修正后）：**`<>` 与 `""` 的区别不是「内部 vs 外部」**，
 * 而是「**搜索顺序的约定**」：
 *
 *   `#include "foo.hpp"`  —— 先搜引用文件所在目录，再搜 `-I` 列表
 *   `#include <foo.hpp>`  —— 直接搜 `-I` 列表（跳过当前目录）
 *
 * 两者**都能指向项目内部的公共头文件**。
 * 真实项目实测：2716 条尖括号 include 里，**1081 条是项目内部的**
 * （`nimrtc/core/api_version.hpp` 150 次、`nimrtc/core/log.hpp` 79 次……）——
 * 占 40%。
 *
 * 所以**不能**按尖括号一律排除。那会漏掉 1081 条真实依赖。
 *
 * 真正的判据是「**这个文件在不在项目的 include 根里**」——
 * 那要等解析阶段才知道（见 `resolveCppInclude`）。
 * 这里把两种都标成 `relative`（= 需要解析），
 * 解析阶段找不到的才是外部依赖。
 *
 * 解析顺序的差别仍然要保留：
 *   - `""`：当前目录 → include 根
 *   - `<>`：include 根（**跳过当前目录**）
 *
 * ADR-064：**条件编译**里的 include 也会被解析，但要**标记**条件。
 *
 * **为什么条件边仍算依赖**：条件编译不是「这段代码不存在」，
 * 而是「这段代码**在某些构建配置下**存在」。开启那个特性时，
 * 这条依赖就在 —— 设计该声明就得声明。
 * 所以条件边**不隐藏**，只标记（`cppCondition`），
 * 让报告能说「这条边只在开启 X 时存在」。
 *
 * **include 守卫不是条件**：
 *
 * ```cpp
 * #ifndef NIMRTC_ENGINE_ENGINE_HPP
 * #define NIMRTC_ENGINE_ENGINE_HPP
 * #include <chrono>     ← 一直生效，不是条件依赖
 * #endif
 * ```
 *
 * 守卫**永远为真**（下一行就把宏定义了）。把它当条件，
 * 会把绝大多数头文件里的 include 都标成「条件依赖」——
 * 真实项目实测：431 条 include 在守卫内，249 条在真条件内。
 * 不区分的话，标记就全是噪音。
 */
function parseCppIncludes(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const pattern = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"]+)[>"]/gm;

  // 先找出所有条件编译块 —— include 再逐条比对落在哪些块里
  const blocks = findCppConditionalBlocks(source);

  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (!specifier) continue;

    const line = lineOf(source, match.index ?? 0);

    // 落在真条件块里（守卫不算 —— 守卫永远为真）
    const active = blocks.filter(
      (b) => !b.isGuard && b.startLine < line && line < b.endLine,
    );

    refs.push({
      specifier,
      // 两种都要解析 —— 尖括号也可能是项目内部头文件（见上）
      kind: 'relative',
      cppBracket: match[1] as '<' | '"',
      line,
      ...(active.length > 0
        ? {
            cppCondition: active.map((b) => b.condition).join(' && '),
            // ADR-069：同时填通用字段（报告层优先读它）
            condition: active.map((b) => b.condition).join(' && '),
          }
        : {}),
    });
  }

  return dedupe(refs);
}

/**
 * 找出源码里所有条件编译块的范围。
 *
 * 判据（确定性）：
 *   - `#ifndef X` **紧跟** `#define X` → **include 守卫**（永远为真）
 *   - `#ifdef X` / `#ifndef X` 单独出现 → **真条件编译**
 *   - `#if <表达式>` → 真条件编译
 *
 * 嵌套的 `#if` 也要管 —— 守卫可以套在真条件里（反过来也行）。
 */
export function findCppConditionalBlocks(
  source: string,
): Array<{ startLine: number; endLine: number; condition: string; isGuard: boolean }> {
  const lines = source.split('\n');
  const stack: Array<{ startLine: number; condition: string; isGuard: boolean }> = [];
  const blocks: Array<{ startLine: number; endLine: number; condition: string; isGuard: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    const ifndef = t.match(/^#\s*ifndef\s+(\w+)/);
    const ifdef = t.match(/^#\s*ifdef\s+(\w+)/);
    const ifMatch = t.match(/^#\s*if\s+(.+)$/);

    if (ifndef || ifdef || ifMatch) {
      const condition = ifndef ? ifndef[1] : ifdef ? ifdef[1] : ifMatch![1].trim();
      // include 守卫：`#ifndef X` 紧跟 `#define X`
      let isGuard = false;
      if (ifndef) {
        const next = (lines[i + 1] ?? '').trim();
        isGuard = new RegExp(`^#\\s*define\\s+${ifndef[1]}\\b`).test(next);
      }
      stack.push({ startLine: i + 1, condition, isGuard });
      continue;
    }

    if (/^#\s*endif\b/.test(t)) {
      const top = stack.pop();
      if (top) {
        blocks.push({
          startLine: top.startLine,
          endLine: i + 1,
          condition: top.condition,
          isGuard: top.isGuard,
        });
      }
    }
  }

  return blocks;
}

// ─── Go（ADR-069）─────────────────────────────────────────────────────

/**
 * Go 的 import 解析。
 *
 * Go 的 import 只有两种形态：
 *
 * ```go
 * import "fmt"                        // 单行
 * import (                            // 块
 *     "fmt"
 *     alias "github.com/foo/bar"
 *     _ "embed"
 * )
 * ```
 *
 * **别名与空导入不影响路径**：`alias "x/y"` 的依赖就是 `x/y`。
 * 别名是**本地名字**，不是依赖路径的一部分。
 *
 * **Go 没有相对 import** —— 路径总是模块路径或标准库名。
 * 这一点让 Go 的解析比 C++ 简单得多：不需要「相对引用文件目录」那一路。
 *
 * **条件编译**（ADR-069 §3.3）：`//go:build` 注释在文件**顶部**，
 * 覆盖**整个文件**。所以文件内所有 import 都带这个条件标记。
 */
function parseGoImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];

  // 文件顶部的构建约束
  const buildTag = findGoBuildTag(source);

  // ① import "path"
  const singlePattern = /^[ \t]*import[ \t]+(?:[A-Za-z_.][\w.]*[ \t]+)?["]([^"]+)["]/gm;
  for (const match of source.matchAll(singlePattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    refs.push({
      specifier,
      kind: classifyGoSpecifier(specifier),
      line: lineOf(source, match.index ?? 0),
      ...(buildTag ? { condition: buildTag } : {}),
    });
  }

  // ② import ( ... ) 块
  const blockPattern = /^[ \t]*import[ \t]*\(([\s\S]*?)\)/gm;
  for (const match of source.matchAll(blockPattern)) {
    const body = match[1] ?? '';
    const bodyStart = (match.index ?? 0) + match[0].indexOf('(') + 1;
    const bodyLine = lineOf(source, bodyStart);

    for (const lineMatch of body.matchAll(/["]([^"]+)["]/g)) {
      const specifier = lineMatch[1];
      if (!specifier) continue;
      refs.push({
        specifier,
        kind: classifyGoSpecifier(specifier),
        line: bodyLine,
        ...(buildTag ? { condition: buildTag } : {}),
      });
    }
  }

  return dedupe(refs);
}

/**
 * 找出 Go 文件顶部的构建约束。
 *
 * Go 官方规范：约束注释必须在 package 子句**之前**，
 * 且只能出现在文件顶部。
 *
 * 两种格式都认：
 * ```go
 * //go:build linux && amd64     // 新格式（Go 1.17+）
 * // +build linux,amd64          // 旧格式
 * ```
 */
export function findGoBuildTag(source: string): string | null {
  const lines = source.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // 只看文件顶部：遇到非注释行就停
    if (!trimmed.startsWith('//')) {
      // `package` 子句之前允许有注释块；非注释行说明约束区结束
      break;
    }
    if (trimmed.startsWith('//go:build')) {
      return trimmed.slice('//go:build'.length).trim();
    }
    if (trimmed.startsWith('// +build')) {
      return trimmed.slice('// +build'.length).trim();
    }
  }
  return null;
}

/** Go 标准库（够用的那一批） */
const GO_STDLIB = new Set([
  'bufio', 'bytes', 'context', 'crypto', 'database', 'encoding', 'errors',
  'expvar', 'flag', 'fmt', 'go', 'hash', 'html', 'image', 'index', 'io',
  'log', 'math', 'mime', 'net', 'os', 'path', 'plugin', 'reflect', 'regexp',
  'runtime', 'sort', 'strconv', 'strings', 'sync', 'syscall', 'testing',
  'text', 'time', 'unicode', 'unsafe',
]);

/**
 * 归类 Go 说明符。
 *
 * Go **没有相对 import** —— 路径总是模块路径或标准库名。
 * 以 `.` / `..` 开头的路径在 Go 里不合法，当作外部依赖处理。
 */
export function classifyGoSpecifier(specifier: string): ImportRef['kind'] {
  const base = specifier.split('/')[0];
  if (GO_STDLIB.has(base)) return 'builtin';
  // `net/http` 这类标准库子包 —— 第一段是标准库名
  if (GO_STDLIB.has(base)) return 'builtin';
  return 'package';
}

// ─── Rust（ADR-069）────────────────────────────────────────────────────

/**
 * Rust 的依赖解析。
 *
 * 覆盖四种表达里**产生依赖边**的三种：
 *
 * ```rust
 * use std::collections::HashMap;   // ① 标准库
 * use crate::core::registry;       // ① crate 内部
 * use super::parent;               // ① 父模块
 * use self::sibling;               // ① 同级
 * use crate::foo as bar;           // ① 带别名
 * use crate::{a, b::c};            // ① 嵌套花括号
 * extern crate serde;              // ② 外部 crate
 * mod submodule;                   // ③ mod 声明 —— **不产生依赖边**
 * ```
 *
 * **`mod` 不产生依赖边**（ADR-069 §3.2）：它不是「引用」而是「声明」——
 * `mod submodule;` 指的是同目录的 `submodule.rs`，
 * 那是「这个文件属于那个模块」，不是「这个模块依赖那个模块」。
 *
 * **条件编译**：`#[cfg(...)]` 挂在 item 上，只影响那一个 item。
 */
function parseRustImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // ① `#[cfg(...)]` 属性 —— 记住它，紧跟的下一个 item 带这个条件
    const cfgMatch = trimmed.match(/^#!?\[cfg\(([^)]*)\)\]/);
    if (cfgMatch) {
      // 找紧跟的下一个 item
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length) {
        const condition = cfgMatch[1].trim();
        const item = parseRustUseLine(lines[j], j + 1);
        if (item) {
          for (const ref of item) {
            refs.push({ ...ref, condition });
          }
          i = j; // 跳过已处理的 item
        }
      }
      continue;
    }

    // ② `use ...;` / `pub use ...;`
    if (/^(pub\s+)?use\s+/.test(trimmed)) {
      refs.push(...parseRustUseLine(line, i + 1));
      continue;
    }

    // ③ `extern crate serde;`
    const externMatch = trimmed.match(/^(?:pub\s+)?extern\s+crate\s+([A-Za-z_][\w]*)/);
    if (externMatch) {
      const specifier = externMatch[1];
      refs.push({
        specifier,
        kind: classifyRustSpecifier(specifier),
        line: i + 1,
      });
    }
  }

  return dedupe(refs);
}

/**
 * 解析一行 `use` 语句，产出 0..n 条依赖。
 *
 * 要处理的形态：
 * - `use crate::core::registry;`      → 一条
 * - `use crate::foo as bar;`          → 一条（别名不是路径的一部分）
 * - `use crate::{a, b::c};`           → 两条
 * - `use crate::{a, b::{c, d}};`      → 递归展开
 * - `pub use crate::x::Y;`            → 一条（re-export 也是依赖）
 */
export function parseRustUseLine(line: string, lineNumber: number): ImportRef[] {
  const trimmed = line.trim();
  if (!/^(pub\s+)?use\s+/.test(trimmed)) return [];

  // 去掉 `use` / `pub use` 前缀
  let body = trimmed.replace(/^(pub\s+)?use\s+/, '');
  // 去掉行尾的分号
  body = body.replace(/;?\s*$/, '');
  // 去掉别名（`as bar`）—— 别名是本地名字，不是路径
  body = body.replace(/\s+as\s+[A-Za-z_][\w]*$/, '');

  const specs = expandRustUsePath(body);

  return specs.map((specifier) => ({
    specifier,
    kind: classifyRustSpecifier(specifier),
    line: lineNumber,
  }));
}

/**
 * 展开 `use` 的路径 —— 把嵌套花括号拆成多条完整路径。
 *
 * ```
 * crate::{a, b::c}      → crate::a, crate::b::c
 * crate::{a, b::{c, d}} → crate::a, crate::b::c, crate::b::d
 * ```
 */
export function expandRustUsePath(body: string): string[] {
  const braceStart = body.indexOf('{');
  if (braceStart === -1) return [body.trim()];

  const prefix = body.slice(0, braceStart).replace(/::$/, '');
  const inner = body.slice(braceStart + 1, body.lastIndexOf('}'));

  const results: string[] = [];
  for (const part of splitTopLevel(inner)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const expanded = expandRustUsePath(trimmed);
    for (const item of expanded) {
      results.push(prefix ? `${prefix}::${item}` : item);
    }
  }
  return results;
}

/**
 * 按顶层逗号切分（忽略花括号与尖括号里的逗号）。
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of text) {
    if (ch === '{' || ch === '<' || ch === '(') depth++;
    if (ch === '}' || ch === '>' || ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Rust 标准库前缀 */
const RUST_STDLIB_PREFIXES = ['std', 'core', 'alloc', 'proc_macro', 'test'];

/**
 * 归类 Rust 说明符。
 *
 * - `crate::` / `self::` / `super::` → 项目内部（`relative`）
 * - `std::` / `core::` / `alloc::` → 标准库（`builtin`）
 * - 其它 → 外部 crate（`package`）
 */
export function classifyRustSpecifier(specifier: string): ImportRef['kind'] {
  if (specifier.startsWith('crate::') || specifier.startsWith('self::') || specifier.startsWith('super::')) {
    return 'relative';
  }
  const base = specifier.split('::')[0];
  if (RUST_STDLIB_PREFIXES.includes(base)) return 'builtin';
  return 'package';
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

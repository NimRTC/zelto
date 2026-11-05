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
 */
export function detectLang(filePath: string): SourceLang | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'ts';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'ts';
  if (lower.endsWith('.py')) return 'python';
  return null;
}

/**
 * 抽出源码里的 import 说明符。
 *
 * TS/JS 覆盖：import ... from 'x'、import 'x'、export ... from 'x'、
 * require('x')、动态 import('x')。
 * Python 覆盖：from a.b import c、import a.b。
 */
export function parseImports(source: string, lang: SourceLang): ImportRef[] {
  if (lang === 'python') return parsePythonImports(source);
  return parseTsImports(source);
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

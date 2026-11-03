#!/usr/bin/env node
// 编码守卫 —— 检出「UTF-8 文本被按 GBK 解码后再写回」造成的乱码污染。
//
// 为什么需要它：Windows 上的 PowerShell 5.1 默认编码是 GBK（`[Console]::OutputEncoding.WebName`
// 为 gb2312）。`Get-Content` / `Set-Content` / `Out-File` 若不显式带 `-Encoding UTF8`，
// 读进来的 UTF-8 字节会被按 GBK 误解码，再按 GBK 写回，文件内容就变成了乱码。
// 这类污染在编译期表现为莫名其妙的语法错误，非常难查。
//
// 判定依据：一组「在干净中文语料里出现 0 次、在 GBK 误解码语料里大量出现」的高置信特征字符。
// 命中即视为污染。
//
// 用法：
//   node scripts/check-encoding.mjs            检查受管目录
//   node scripts/check-encoding.mjs --fix      报告并给出修复建议（不自动改写）

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** 受管目录与文件类型。 */
const TARGETS = [
  { dir: 'src', exts: ['.ts', '.js', '.mjs'] },
  { dir: 'tests', exts: ['.ts', '.js', '.mjs'] },
  { dir: 'scripts', exts: ['.ts', '.js', '.mjs'] },
  { dir: 'docs', exts: ['.md'] },
  { dir: 'specs', exts: ['.md'] },
  { dir: 'contracts', exts: ['.json'] },
  { dir: 'policy', exts: ['.yaml', '.yml'] },
];

/** 顶层单独检查的文件。 */
const TOP_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md'];

/**
 * GBK 误解码的高置信特征字符。
 *
 * 推导方式：取仓库内所有中文语料，按 UTF-8 编码后用 GBK 解码器解读，
 * 统计出现频次；保留「污染语料中频次 >= 200、干净语料中出现 <= 2 次」的字符。
 * 干净语料中频次为 0 意味着这些字符不会误伤正常中文。
 */
const MOJIBAKE_MARKERS = new Set([
  '\u951b', '\u6d93', '\u9239', '\u9352', '\u9286', '\u5c7e', '\u6d60', '\u7039',
  '\u9428', '\u935a', '\u5a34', '\u9359', '\u93c2', '\u6b91', '\u7d1d', '\u6d5c',
  '\u6960', '\u56e9', '\u93cd', '\u9350', '\u6b22', '\u934f', '\u93c8', '\u8235',
  '\u7487', '\u5896', '\u93c3', '\u6769', '\u9225', '\u6579', '\u9429', '\u762f',
  '\u5b2d', '\u9417', '\u93b5', '\u7459', '\u5d85', '\u7b09', '\u9366', '\u93c0',
  '\u7481', '\u52eb',
]);

/** U+FFFD 替换字符——UTF-8 误解码后必然出现，是最强信号。 */
const REPLACEMENT_CHAR = '\ufffd';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-test', '.git', '.zelto', '.claude', 'coverage',
]);

/** Collect every file under `dir` whose extension is in `exts`. */
function collect(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, exts, out);
    } else if (exts.includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Detect mojibake in a single file.
 *
 * @returns {{line: number, chars: string[]}|null}
 */
function detectMojibake(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hits = new Set();
    for (const ch of line) {
      if (ch === REPLACEMENT_CHAR || MOJIBAKE_MARKERS.has(ch)) hits.add(ch);
    }
    if (hits.size > 0) return { line: i + 1, chars: [...hits] };
  }
  return null;
}

const files = [];
for (const target of TARGETS) {
  files.push(...collect(join(root, target.dir), target.exts));
}
for (const name of TOP_FILES) {
  try {
    if (statSync(join(root, name)).isFile()) files.push(join(root, name));
  } catch {
    /* not present */
  }
}

const offenders = [];
for (const file of files) {
  const hit = detectMojibake(file);
  if (hit) offenders.push({ file: relative(root, file), ...hit });
}

if (offenders.length === 0) {
  console.log(`[zelto] 编码检查通过：${files.length} 个文件，未发现乱码污染。`);
  process.exit(0);
}

console.error(`[zelto] 编码检查失败：${offenders.length} 个文件疑似乱码污染。\n`);
for (const o of offenders) {
  const codes = o.chars
    .map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .join(' ');
  console.error(`  ${o.file}:${o.line}  ${codes}`);
}
console.error(
  '\n修复方向：文件内容被按 GBK 误解码后再写回。' +
    '请从干净副本（git 历史 / stash / worktree）恢复该文件，' +
    '并用显式 UTF-8 的方式读写——' +
    'PowerShell 用 `Get-Content -Encoding UTF8` / `Set-Content -Encoding UTF8`，' +
    'Node 用 `readFileSync(p, "utf-8")` / `writeFileSync(p, s, "utf-8")`。',
);
process.exit(1);

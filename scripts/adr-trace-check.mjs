#!/usr/bin/env node
// scripts/adr-trace-check.mjs — ADR 版本追溯完整性校验（切片 v2-adr-trace）
//
// 扫描 docs/adr/adr-102*.md、docs/adr/adr-103*.md、docs/adr/adr-104*.md，
// 校验每份 ADR 的「版本追溯」小节是否包含四项字段且格式合法：
//
//   所属版本号    vX.Y.Z（v + 数字 + . + 数字 + . + 数字）
//   关联 ADR 编号 ADR-NNN
//   提交哈希      40 位十六进制字符串
//   验证方式      非空、以 `[` 开头、包含 `]`
//
// 退出码约定（保守策略：任一缺失/非法即非零）：
//   0 = 三份 ADR 全部「字段齐全」且格式合法
//   1 = 存在缺失字段或格式非法 —— 逐条输出是哪份 ADR、哪个字段
//
// 字段解析做别名归一化（commit / hash / 提交 等历史写法统一映射），
// 避免同一字段出现多种命名导致匹配失败。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const adrDir = join(root, 'docs', 'adr');

/** 受检的 ADR 文件前缀（写集 glob `docs/adr/adr-10N*.md` 的单层 `*`）。 */
const ADR_PREFIXES = ['adr-102', 'adr-103', 'adr-104'];

/** 字段别名归一化 —— 长的在前（短别名会误配长字段名）。 */
const FIELD_ALIASES = {
  version: ['所属版本号', '版本号', '所属版本', '版本'],
  adr: ['关联 ADR 编号', 'ADR 编号', '关联 ADR', 'ADR'],
  hash: ['提交哈希', '提交 commit', 'commit hash', '哈希', 'hash', 'commit', '提交'],
  verify: ['验证方式', '验证方法', '校验方式', '验证'],
};

const RE_VERSION = /^v\d+\.\d+\.\d+$/;
const RE_ADR = /^ADR-\d+$/;
const RE_HASH = /^[0-9a-fA-F]{40}$/;

/** 收集 docs/adr/ 下匹配给定前缀的 ADR 文件。 */
function findAdrFiles() {
  if (!existsSync(adrDir)) return [];
  return readdirSync(adrDir)
    .filter((name) => name.endsWith('.md') && ADR_PREFIXES.some((p) => name.startsWith(p)))
    .map((name) => join(adrDir, name))
    .sort();
}

/** 在「版本追溯」小节里按别名抽取字段值；找不到返回 null。 */
function extractField(sectionLines, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 表格行：`| 字段 | 值 |`（值可带尾竖线）
  const tableRe = new RegExp(`^\\s*\\|?\\s*${escaped}\\s*\\|\\s*(.+?)\\s*\\|?$`);
  // 键值行：`字段: 值` 或 `字段：值`
  const kvRe = new RegExp(`^\\s*${escaped}\\s*[:：]\\s*(.+?)\\s*$`);
  for (const line of sectionLines) {
    if (/^#{1,3}\s/.test(line)) break; // 下一个小节标题 → 结束
    const m = line.match(tableRe) ?? line.match(kvRe);
    if (m) return m[1].trim();
  }
  return null;
}

/** 解析一份 ADR 的「版本追溯」小节，返回 { 字段: 值 }；无小节返回 null。 */
function parseTraceSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s*版本追溯/.test(l));
  if (start === -1) return null;
  const section = lines.slice(start + 1);
  const fields = {};
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const value = extractField(section, alias);
      if (value !== null && value !== '') {
        fields[key] = value;
        break;
      }
    }
  }
  return fields;
}

/** 校验四项字段的格式，返回错误列表（空 = 齐全且合法）。 */
function validate(fields) {
  const errors = [];
  if (!fields.version || !RE_VERSION.test(fields.version)) {
    errors.push(`所属版本号「${fields.version ?? '(缺失)'}」不符合 vX.Y.Z 格式`);
  }
  if (!fields.adr || !RE_ADR.test(fields.adr)) {
    errors.push(`关联 ADR 编号「${fields.adr ?? '(缺失)'}」不符合 ADR-NNN 格式`);
  }
  if (!fields.hash || !RE_HASH.test(fields.hash)) {
    errors.push(`提交哈希「${fields.hash ?? '(缺失)'}」不是 40 位十六进制字符串`);
  }
  if (!fields.verify || !(fields.verify.startsWith('[') && fields.verify.includes(']'))) {
    errors.push(`验证方式「${fields.verify ?? '(缺失)'}」必须非空且以 [ 开头并包含 ]`);
  }
  return errors;
}

// ── ADR 单家检查（ADR-118）────────────────────────────────────────────────
//
// 一个编号只能有一个「家」。同一编号在两处出现时，目录版（docs/adr/）是家；
// 另一处只允许是**逐字副本**。缺一行、多一句都算漂移 —— 影子副本
// 会让读者打开的是没有追溯证据的那份，而脚本在意的又是另一份。
//
// 扫描范围：docs/adr/*.md + docs/adr-*.md（扁平侧只看编号，不看 ADR_PREFIXES
// 的固定清单 —— 同号问题不挑编号）。

const flatDir = join(root, 'docs');

/**
 * 编号 → 标题。ADR-057 冲突（同号两处）的裁决依据之一：
 * 被引用最多、且与后续 ADR 引用的标题一致的那份留下来。
 */
function adrTitle(text) {
  const line = text.split(/\r?\n/).find((l) => /^#\s/.test(l));
  if (!line) return null;
  return line
    .replace(/^#\s*/, '')
    .replace(/^(ADR-\d+|adr-\d+)\s*[:：]?\s*/i, '')
    .trim();
}

/** 从文件名里取 ADR 编号：`adr-012-xxx.md` → 12。取不到返回 null。 */
function adrNumberOf(name) {
  const m = name.match(/^adr-(\d+)-.*\.md$/i);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * 在文本里找 `docs/adr…*.md` 形式的路径引用。
 *
 * 只认以 `docs/` 开头的引用：它们指向仓库内的文档；裸文件名（`adr-047-…md`）
 * 在没有目录上下文时无法判定，交给人。
 * `...` / `<` 之类的占位不符 —— 那是「举例」不是「引用」。
 */
function findAdrRefs(text) {
  const refs = new Set();
  const re = /docs\/[A-Za-z0-9_\-./]*(?:adr[-/])[A-Za-z0-9_\-./]*\.md/g;
  for (const m of text.matchAll(re)) {
    if (/\.\.\.|<|>|\*/.test(m[0])) continue;
    refs.add(m[0]);
  }
  return [...refs];
}

function checkSingleHome() {
  const errors = [];

  /** 编号 → 各位置的条目 { dir: {file, text}, flat: {file, text} } */
  const homes = new Map();
  const add = (num, where, file) => {
    if (!homes.has(num)) homes.set(num, {});
    homes.get(num)[where] = { file, text: readFileSync(file, 'utf8') };
  };

  if (existsSync(adrDir)) {
    for (const name of readdirSync(adrDir)) {
      const num = adrNumberOf(name);
      if (num === null) continue;
      add(num, 'dir', join(adrDir, name));
    }
  }
  if (existsSync(flatDir)) {
    for (const name of readdirSync(flatDir)) {
      const num = adrNumberOf(name);
      if (num === null) continue;
      add(num, 'flat', join(flatDir, name));
    }
  }

  // 同名编号出现 N 份时（不只两处），逐对比较 —— 一律按「目录版是家」判。
  for (const [num, h] of [...homes.entries()].sort((a, b) => a[0] - b[0])) {
    if (h.dir && h.flat) {
      const typeOf = (text) => adrTitle(text);
      if (typeOf(h.dir.text) !== typeOf(h.flat.text)) {
        errors.push(
          `ADR-${num} 同号两处存在且是两份不同的决定：` +
            `${basename(h.dir.file)}「${typeOf(h.dir.text)}」与 ${basename(h.flat.file)}「${typeOf(h.flat.text)}」` +
            ' —— 其中一份必须改号（ADR-118 决策一：一个编号只能有一个决定）',
        );
      } else if (h.dir.text !== h.flat.text) {
        errors.push(
          `ADR-${num} 同号两处存在且内容漂移：${basename(h.dir.file)}（家）与 ${basename(h.flat.file)}（副本）` +
            ' —— 要么删副本，要么让副本逐字一致（ADR-118 决策二）',
        );
      }
    } else if (h.flat) {
      // 扁平侧唯一的一份 —— 正常形态，但要确认没有同号影子混在 docs/ 下。
      const others = readdirSync(flatDir).filter(
        (n) => n !== basename(h.flat.file) && adrNumberOf(n) === num,
      );
      if (others.length > 0) {
        errors.push(`ADR-${num} 在 docs/ 下出现多份：${basename(h.flat.file)} 与 ${others.join(', ')}`);
      }
    }
  }

  // dangling 引用：文档里写的 docs/...adr...md 必须在版本库里有
  //
  // 不用 `git ls-files -- '*.md'`：Windows 上 core.protectNTFS 会把 8.3 短名
  // 转义成 `ADMINI~1`，paths 不归一会把正常的已跟踪文件判成不存在。
  // `-z` 的输出分隔符是 NUL，且路径逐字返回。
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter((p) => p.endsWith('.md')),
  );
  const scanned = existsSync(flatDir) ? readdirSync(flatDir).filter((n) => n.endsWith('.md')) : [];
  const scanFiles = [
    ...scanned.map((n) => join(flatDir, n)),
    ...(existsSync(adrDir) ? readdirSync(adrDir).filter((n) => n.endsWith('.md')).map((n) => join(adrDir, n)) : []),
  ];
  for (const file of scanFiles) {
    const rel = file.slice(root.length + 1).split(sep).join('/');
    if (!tracked.has(rel)) continue; // 未跟踪的工作区文件不参与引用检查
    for (const ref of findAdrRefs(readFileSync(file, 'utf8'))) {
      if (!tracked.has(ref)) errors.push(`${rel} 引用了不存在的路径：${ref}`);
    }
  }

  return errors;
}

const files = findAdrFiles();
let allOk = true;

if (files.length === 0) {
  console.error('[adr-trace-check] 未找到任何受检 ADR 文件（docs/adr/adr-102/103/104*.md）。');
  process.exit(1);
}

for (const file of files) {
  const name = basename(file);
  const text = readFileSync(file, 'utf8');
  const fields = parseTraceSection(text);
  const errors = fields ? validate(fields) : ['缺少「版本追溯」小节'];
  if (errors.length === 0) {
    console.log(`[${name}] 版本追溯字段齐全`);
  } else {
    allOk = false;
    console.log(`[${name}] 版本追溯字段缺失：`);
    for (const e of errors) console.log(`  - ${e}`);
  }
}

if (allOk) {
  const homeErrors = checkSingleHome();
  if (homeErrors.length > 0) {
    allOk = false;
    for (const e of homeErrors) console.log(`  - ${e}`);
  }
}

if (allOk) {
  console.log('[adr-trace-check] 通过：全部 ADR 版本追溯字段齐全且格式合法；编号单家、副本无漂移、引用无断链。');
} else {
  console.error('[adr-trace-check] 未通过：存在缺失字段、格式非法，或 ADR 编号重复 / 副本漂移 / 引用断链。');
}
process.exit(allOk ? 0 : 1);

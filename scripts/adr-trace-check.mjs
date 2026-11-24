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
import { join, dirname, basename } from 'node:path';
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
  console.log('[adr-trace-check] 通过：全部 ADR 版本追溯字段齐全且格式合法。');
} else {
  console.error('[adr-trace-check] 未通过：存在缺失字段或格式非法。');
}
process.exit(allOk ? 0 : 1);

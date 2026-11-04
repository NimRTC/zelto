#!/usr/bin/env node
// 凭据扫描 —— 提交前自检：确认待上传的文件里没有密钥
//
// 用法：node scripts/scan-credentials.mjs [base_ref]
//   base_ref  默认 HEAD，即只扫「相对最后一次提交」的改动
//
// 检查三处：
//   1. 已跟踪但有改动的文件
//   2. 未跟踪的新文件（已排除 .gitignore 忽略的）
//   3. 全部已跟踪文件（防漏网）
//
// 退出码：0 = 干净，1 = 发现敏感信息

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'HEAD';

/** 扫描器自身：模式字面量就在文件里，必须跳过，否则自己扫自己 */
const SELF = 'scripts/scan-credentials.mjs';

/** 敏感模式：代理域名 / 已知的 token 前缀 / 通用 sk- 形态的 key */
const PATTERNS = [
  /example-proxy/i,
  /sk-EXAMPLE/,
  /api\.example-proxy/i,
  /sk-[A-Za-z0-9]{20,}/,
];

/** 误报豁免：占位符、测试假 key、文档示例 */
const ALLOW = [
  /sk-your-key-here/,
  /sk-test-key/,
  /sk-key\b/,
  /sk-example/,
  /sk-placeholder/,
];

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

/** 返回命中该文件内容的模式说明 */
function scanFile(file) {
  if (!existsSync(file)) return [];
  if (file.replace(/\\/g, '/') === SELF) return [];
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const hits = [];
  for (const line of text.split('\n')) {
    if (ALLOW.some((re) => re.test(line))) continue;
    for (const re of PATTERNS) {
      const m = line.match(re);
      if (m) {
        // 只报告匹配的片段，不回显整行（避免把密钥打进终端日志）
        hits.push(`${file}: ${m[0].slice(0, 12)}…`);
        break;
      }
    }
  }
  return hits;
}

const changed = git(['diff', '--name-only', BASE, '--']).split('\n').filter(Boolean);
const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
const tracked = git(['ls-files']).split('\n').filter(Boolean);

const allHits = [];

console.log(`[zelto] 扫描基准：${BASE}`);
console.log(
  `[zelto] 已跟踪有改动：${changed.length} 个｜未跟踪新增：${untracked.length} 个｜已跟踪总计：${tracked.length} 个`,
);

for (const f of [...changed, ...untracked]) {
  allHits.push(...scanFile(f));
}

console.log('[zelto] 改动 + 新增文件扫描结果：');
if (allHits.length === 0) {
  console.log('  ✓ 无敏感信息');
} else {
  for (const h of allHits) console.log(`  ✗ ${h}`);
}

console.log('[zelto] 全量已跟踪文件扫描结果：');
const trackedHits = [];
for (const f of tracked) {
  trackedHits.push(...scanFile(f));
}
if (trackedHits.length === 0) {
  console.log('  ✓ 无敏感信息');
} else {
  for (const h of trackedHits) console.log(`  ✗ ${h}`);
}

if (allHits.length > 0 || trackedHits.length > 0) {
  console.error('\n[zelto] 发现敏感信息，请处理后再提交。');
  process.exit(1);
}
console.log('\n[zelto] 通过：没有凭据会被提交。');

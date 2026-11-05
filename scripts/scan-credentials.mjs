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
// 私有名单：通用的 key 形态写在下面的 PATTERNS 里；自家代理域名、
// token 前缀这类**不宜出现在公开仓库**的字样，放本地文件
// `.zelto/credential-patterns.local.json`（该目录已被 .gitignore 覆盖）：
//
//   { "patterns": ["example-proxy", "sk-Abcd"] }
//
// 名单里的每一条按「大小写不敏感的子串」匹配。文件不存在时只用通用模式。
// CI 上这份名单由 GitHub Secret 注入（见 .github/workflows/ci.yml），
// 加密存储，仓库里不留明文。
//
// 退出码：0 = 干净，1 = 发现敏感信息

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'HEAD';

/** 扫描器自身：模式字面量就在文件里，必须跳过，否则自己扫自己 */
const SELF = 'scripts/scan-credentials.mjs';

/** 本地私有名单（被 .gitignore 覆盖，不会进版本库） */
const LOCAL_PATTERNS_FILE = '.zelto/credential-patterns.local.json';

/** 通用敏感形态：各家 key 的公共形状，不含任何专有标识 */
const PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9._~+/-]{20,}["']/i,
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

/** 读取本地私有名单；不存在或格式不对时降级为「只用通用模式」 */
function loadLocalPatterns() {
  if (!existsSync(LOCAL_PATTERNS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(LOCAL_PATTERNS_FILE, 'utf-8').replace(/^\uFEFF/, ''));
    const list = Array.isArray(raw) ? raw : raw?.patterns;
    if (!Array.isArray(list)) return [];
    return list.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.toLowerCase());
  } catch {
    console.warn(`[zelto] 警告：${LOCAL_PATTERNS_FILE} 解析失败，只用通用模式扫描。`);
    return [];
  }
}

const LOCAL_PATTERNS = loadLocalPatterns();

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
    const lower = line.toLowerCase();
    const localHit = LOCAL_PATTERNS.find((p) => lower.includes(p));
    if (localHit) {
      hits.push(`${file}: ${localHit.slice(0, 12)}…`);
      continue;
    }
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
console.log(`[zelto] 模式：通用 ${PATTERNS.length} 条｜本地私有名单 ${LOCAL_PATTERNS.length} 条`);

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

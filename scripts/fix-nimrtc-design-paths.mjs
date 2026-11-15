/**
 * 修正 nimrtc-zelto 项目设计文档里的模块文件路径。
 *
 * 背景（ADR-062 §4.4）：
 * `arch check` 报出 5 个模块「一个文件都没匹配上」——
 * 设计里写 `src/dtls/*`，但代码实际在 `src/modules/dtls/`。
 * 这 5 个模块的设计是在 `src/modules/` 子目录化之前写的，路径没跟着改。
 *
 * 改**文件路径**，不改**模块名**：
 *   - 模块名（`src/dtls`）是设计的语义单元，被 `src/modules → src/dtls` 等依赖引用
 *   - 文件路径（`src/modules/dtls/*`）是「这个模块管哪些文件」
 *
 * 归属不会冲突：`src/modules/dtls/**` 比 `src/modules/**` 更具体
 * （patternSpecificity 按前缀长度比），所以这些文件会归到 `src/dtls`，
 * 不会被 `src/modules` 抢走。
 *
 * body 是真源，modules 只是缓存快照 —— 两处都改，保持一致。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DESIGN_PATH = join(
  'D:/MyOpen/nimrtc-zelto/.zelto/design/prj-1792993843912.json',
);

/** 模块名 → 修正后的文件路径模式 */
const FIXES = {
  'src/dtls': 'src/modules/dtls/*, src/modules/dtls/**/*',
  'src/raw_udp': 'src/modules/raw_udp/*, src/modules/raw_udp/**/*',
  'src/sctp': 'src/modules/sctp/*, src/modules/sctp/**/*',
  'src/transport': 'src/modules/transport/*, src/modules/transport/**/*',
  'src/web_transport': 'src/modules/web_transport/*, src/modules/web_transport/**/*',
  // src/log 的代码在 src/log/src/log.cpp —— 只写 `src/log/*` 只匹配到 CMakeLists.txt
  'src/log': 'src/log/*, src/log/**/*',
};

const doc = JSON.parse(readFileSync(DESIGN_PATH, 'utf-8'));

// ─── 改 body（真源）─────────────────────────────────────────────────────
const lines = doc.body.split('\n');
let currentModule = null;
let bodyChanged = 0;

for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();
  if (/^###\s/.test(trimmed)) {
    currentModule = trimmed.replace(/^###\s+/, '').trim();
    continue;
  }
  const fixed = FIXES[currentModule];
  if (!fixed) continue;
  if (!/^- \*\*文件路径\*\*：/.test(trimmed)) continue;

  const old = lines[i];
  lines[i] = lines[i].replace(
    /(- \*\*文件路径\*\*：).*$/,
    `$1${fixed}`,
  );
  bodyChanged++;
  console.log(`body  ${currentModule}`);
  console.log(`  旧: ${old.trim()}`);
  console.log(`  新: ${lines[i].trim()}`);
}

doc.body = lines.join('\n');

// ─── 改 modules（缓存快照）──────────────────────────────────────────────
let modulesChanged = 0;
for (const mod of doc.modules) {
  const fixed = FIXES[mod.name];
  if (!fixed) continue;
  const patterns = fixed.split(',').map((s) => s.trim());
  console.log(`modules ${mod.name}`);
  console.log(`  旧: ${JSON.stringify(mod.filePatterns)}`);
  console.log(`  新: ${JSON.stringify(patterns)}`);
  mod.filePatterns = patterns;
  modulesChanged++;
}

if (bodyChanged !== Object.keys(FIXES).length || modulesChanged !== Object.keys(FIXES).length) {
  console.error(
    `\n改动的数量不对：body ${bodyChanged} 处，modules ${modulesChanged} 处（都应该是 ${Object.keys(FIXES).length}）`,
  );
  process.exit(1);
}

writeFileSync(DESIGN_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
console.log(`\n已写入：body ${bodyChanged} 处，modules ${modulesChanged} 处`);

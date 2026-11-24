#!/usr/bin/env node
// 版本一致性校验：package.json 与 package-lock.json 的根包版本必须一致。
// 挂在 prepublishOnly 上，不一致时以非零退出码阻断发布，保证发布制品版本可信。
//
// 读取口径与 npm 对齐（规格 v1-version-align 风险①）：
//   - lockfileVersion >= 2 → 根包版本在 packages[""].version
//   - lockfileVersion < 2  → 根包版本在顶层 version
//   - 两处字段同时存在时都校验（npm v3 锁里两处都有）
//
// 脚本只读，不修改任何文件（规格验收标准 6）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[version-check] 失败：${message}`);
  process.exit(1);
}

const pkgPath = join(ROOT, 'package.json');
if (!existsSync(pkgPath)) {
  fail(`找不到 ${pkgPath}。`);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const expected = pkg.version;

const lockPath = join(ROOT, 'package-lock.json');
if (!existsSync(lockPath)) {
  fail(`找不到 ${lockPath}（真实发布若用 npm-shrinkwrap.json，本片写集未包含，留待后续切片补齐）。`);
}
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

// 收集所有能读到的根包版本：v1 顶层 version、v2/v3 packages[""].version。
const found = [];
if (typeof lock.version === 'string') found.push(lock.version);
if (lock.packages && lock.packages[''] && typeof lock.packages[''].version === 'string') {
  found.push(lock.packages[''].version);
}

if (found.length === 0) {
  fail(`${lockPath} 读不到根包版本（顶层 version 与 packages[""].version 均缺失）。`);
}

const mismatched = found.filter((v) => v !== expected);
if (mismatched.length > 0) {
  fail(
    `${pkgPath} 与 ${lockPath} 版本不一致：` +
      `package.json 版本=${expected}，package-lock.json 根包版本=${mismatched.join('、')}，` +
      `期望一致为 ${expected}。`,
  );
}

// 规格风险③：发布流程若实际使用 npm-shrinkwrap.json，本脚本不校验它，仅提示。
const shrinkwrapPath = join(ROOT, 'npm-shrinkwrap.json');
if (existsSync(shrinkwrapPath)) {
  console.error(
    `[version-check] 提示：检测到 ${shrinkwrapPath}，本校验未覆盖它；` +
      `对发布锁文件的校验留待后续切片补齐。`,
  );
}

process.exit(0);

#!/usr/bin/env node
// tag 命名空间校验（specs/slices/v2-tag-namespace.md）
//
// 新规则为计划-版本二级命名 `plan-<semver>/v<n>`（如 `plan-0.7.1/v1`）；
// 裸版本 tag（v1/v2/v3）非法，须迁移到新命名空间；纯 semver tag
// （`^v\d+\.\d+\.\d+$`，如 v0.3.0）合法、不受影响。
//
// 本脚本**只做校验**（列出非法 tag + 非零退出），不自动改 tag、
// 不删远端旧 tag —— 删除旧 tag 是人的手动动作。
//
// 用法：
//   node scripts/tag-namespace.mjs [tag...]
//     带参：校验给定的 tag 列表。
//     无参：从 stdin 逐行读 tag；stdin 无输入时读 `git tag`（校验仓库当前状态）。
//   退出码：0 = 全部合法；1 = 有非法命名 / 版本号不一致 / tag-map.json 不合法。
//
// 两种错误分开列（风险应对）：
//   · 非法命名 —— tag 不符合任何合法形态（裸 v1/v2/v3 落在这里）
//   · 版本号不一致 —— `plan-<semver>/v<n>` 的 <semver> 与 package.json 当前版本漂移

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** 纯 semver tag：^v\d+\.\d+\.\d+$，合法、不受影响。 */
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
/** 新命名空间：plan-<semver>/v<n>。 */
const NAMESPACE_TAG = /^plan-(\d+\.\d+\.\d+)\/v(\d+)$/;

/** 收集待校验的 tag：argv → stdin（非管道跳过）→ git tag（兜底）。 */
function collectTags(argv) {
  if (argv.length > 0) return argv;
  let tags = [];
  if (process.stdin.isTTY === undefined) {
    const text = readFileSync(0, 'utf8');
    tags = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (tags.length === 0) {
    try {
      const out = execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' });
      tags = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      tags = [];
    }
  }
  return tags;
}

/** package.json 当前版本（取 X.Y.Z 部分，忽略预发布后缀）。 */
function currentVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const m = /^\d+\.\d+\.\d+/.exec(pkg.version || '');
  return m ? m[0] : null;
}

/**
 * 校验 tag-map.json：必须是 `{ "<old>": "<new>" }` 扁平映射，
 * 新名须为合法命名空间 tag（匹配 `^plan-\d+\.\d+\.\d+/v\d+$`）。
 *
 * 映射表只校验命名合法性、不校验版本一致性 —— 迁移目标是计划版本
 * （如 0.7.x），可能超前于 package.json 的当前发布版本；
 * 版本一致性是对**实际 tag 列表**的校验（见 docs/tag-namespace.md）。
 */
function checkMap() {
  let map;
  try {
    map = JSON.parse(readFileSync(join(root, 'scripts', 'tag-map.json'), 'utf8'));
  } catch (err) {
    return [`tag-map.json 不是合法 JSON：${err.message}`];
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return ['tag-map.json 必须是 { "<old>": "<new>" } 扁平映射'];
  }
  const errors = [];
  for (const [oldName, newName] of Object.entries(map)) {
    if (typeof newName !== 'string' || !NAMESPACE_TAG.test(newName)) {
      errors.push(
        `映射 ${oldName} → ${newName}：新名不是合法命名空间 tag（须匹配 ^plan-\\d+\\.\\d+\\.\\d+/v\\d+$）`,
      );
    }
  }
  return errors;
}

/**
 * 校验单个 tag。返回 null（合法）或 { kind, tag, detail }。
 * kind 区分「命名非法」与「版本号不一致」两种错误。
 */
function checkTag(tag, version) {
  if (SEMVER_TAG.test(tag)) return null;
  const m = NAMESPACE_TAG.exec(tag);
  if (m) {
    if (version && m[1] !== version) {
      return {
        kind: 'version',
        tag,
        detail: `版本号不一致：${tag} 的 <semver> 是 ${m[1]}，package.json 当前版本是 ${version}`,
      };
    }
    return null;
  }
  return {
    kind: 'naming',
    tag,
    detail: `非法命名：${tag} —— 裸版本 tag 须迁移到 plan-<semver>/v<n>，或改为纯 semver tag（^v\\d+\\.\\d+\\.\\d+$）`,
  };
}

const version = currentVersion();
const mapErrors = checkMap();
const illegal = [];
const mismatched = [];
for (const tag of collectTags(process.argv.slice(2))) {
  const err = checkTag(tag, version);
  if (err && err.kind === 'naming') illegal.push(err);
  if (err && err.kind === 'version') mismatched.push(err);
}

const failed = mapErrors.length > 0 || illegal.length > 0 || mismatched.length > 0;
if (!failed) {
  console.log('[zelto] tag-namespace 校验通过：无非法 tag。');
  process.exit(0);
}

for (const message of mapErrors) console.error(`[tag-map] ${message}`);
for (const err of illegal) console.error(`[非法命名] ${err.detail}`);
for (const err of mismatched) console.error(`[版本号不一致] ${err.detail}`);
console.error(
  `[zelto] tag-namespace 校验失败：${mapErrors.length} 处映射表错误，${illegal.length} 个非法命名，${mismatched.length} 个版本号不一致。`,
);
process.exit(1);

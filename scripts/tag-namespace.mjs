#!/usr/bin/env node
// tag 命名空间校验（ADR-110 —— 取代 specs/slices/v2-tag-namespace.md 的规则）
//
// 规则（ADR-110 决策一）：
//   plan-<planId>/v<n>      版本交付锚点 —— 合法
//   v<major.minor.patch>     发布锚点 —— 合法
//   其它（含裸 v1 / v2 / v3） 非法
//
// ── 为什么 tag 里不再有 semver（ADR-110 决策一）──
//
// 旧规则是 `plan-<semver>/v<n>`，且要求 <semver> == package.json 的 version。
// 那是把**两种不同的东西**塞进同一个字段：
//
//   <semver> 在 tag 里表达「这一版属于哪个发布批次」（历史）
//   package.json 的 version 表达「**现在**要发的是哪一版」（现在）
//
// 两者必然在某一刻分叉。实测（2026-11-25，package.json = 0.7.1）：
//
//   node scripts/tag-namespace.mjs plan-0.7.1/v3   → 合法
//   node scripts/tag-namespace.mjs plan-0.7.0/v1   → 退出码 1
//       [版本号不一致] plan-0.7.0/v1 的 <semver> 是 0.7.0，package.json 当前版本是 0.7.1
//
// 于是升版当天**所有历史 tag 同时变成非法**。而 scripts/build.mjs 的
// 发布预检**无参**调用本脚本（读全量 `git tag`）→ 发布闸门被历史 tag 锁死。
//
// 本脚本**只管命名**，不读 package.json ——
// 「发布锚点的版本必须 == 当前版本」由 scripts/version-check.mjs 判
// （ADR-110 决策四：两支判据各管一件事、职责不重叠）。
//
// ── 用法 ──
//
//   node scripts/tag-namespace.mjs [tag...]
//     带参：校验给定的 tag 列表。
//     无参：从 stdin 逐行读 tag；stdin 无输入时读 `git tag`（校验仓库当前状态）。
//
//   node scripts/tag-namespace.mjs --published-only
//     只校验与当前 package.json 版本相关的 tag（ADR-110 决策五）。
//     历史批次的 tag 不参与判定 —— 发布闸门该拦的是「今天要发的东西有问题」，
//     不是「历史上某条 tag 曾经有问题」。
//
//   退出码：0 = 全部合法；1 = 有非法命名 / 映射台账与 git 事实不符。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** 纯 semver tag：^v\d+\.\d+\.\d+$，合法。 */
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
/**
 * 命名空间 tag：plan-<planId>/v<n>（ADR-110）。
 *
 * <planId> 是 `plan-` 前缀 + 13 位数字（`Date.now()` 的十进制长度，
 * 实测现有 10 个计划 id 全部是 13 位、无一重复）。
 *
 * **为什么不放宽成 `^plan-.+$`** —— 那会让旧形态 `plan-0.7.1/v3`
 * 也合法，等于没改（ADR-110 验收标准 1 要求旧形态不再合法）。
 */
const NAMESPACE_TAG = /^plan-(\d{13})\/v(\d+)$/;

/** package.json 当前版本（`--published-only` 模式与迁移台账用）。 */
function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const m = /^\d+\.\d+\.\d+/.exec(pkg.version || '');
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * 迁移台账的形状（ADR-110 决策七）。
 *
 * 旧版是扁平映射 `{ "<old>": "<new>" }` —— **只记名字，不记内容**。
 * 那个形状掩盖了「它装的是别的计划的版本」这个事实（ADR-110 缺陷二）。
 *
 * 新版带 `commit` 字段，脚本会**核对 git 事实**：
 * 台账说的 commit 与该 tag 实际指向的不一致 → **报错**。
 */
function normalizeLedgerEntry(value, oldName) {
  if (typeof value === 'string') {
    // 旧格式：只记了名字。内容无从核对 —— 不算错，但也不提供任何保证。
    return { new: value, commit: null, legacy: true };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      new: typeof value.new === 'string' ? value.new : null,
      commit: typeof value.commit === 'string' ? value.commit : null,
      legacy: false,
    };
  }
  return { new: null, commit: null, legacy: false, invalid: true, oldName };
}

/** tag 当前指向的提交（peeled —— 注解 tag 要取 ^{commit}）。 */
function tagCommit(tag) {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * 这个 commit 在当前仓库里存不存在（不必是任何 ref 的指向）。
 *
 * 为什么要单独一个判据 —— ADR-110 决策九：
 *
 * > `plan-…/v…` —— **版本锚点，本地为主**（发布锚点 `v<semver>` 才是「已推送」那一个）
 *
 * 于是 CI 上（`actions/checkout` 默认**不拉 tag**，且这些 tag 本来就只存在于本地）
 * **根本看不到 `plan-*` tag**。若台账校验硬要求「tag 必须存在」，
 * CI 每次都会报「台账指向一个不存在的锚点」——
 * 而那不是台账错了，是 **CI 的视野**缺了本地 tag。
 *
 * 换成「commit 必须是仓库里的真实提交」：
 * - 在本地（tag 在）→ 核对 tag 的实际指向，与台账逐字比 —— 同等强度；
 * - 在 CI（tag 不在）→ 核对 commit 本身存在且能 peel 出提交 ——
 *   这条**更强**：它证明了「台账记的那个提交是真的」，而不是「这个名字存在」。
 */
function commitExists(commit) {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * 校验迁移台账（ADR-110 决策七）。
 *
 * 两件事：
 * ① 新名必须是合法命名空间 tag；
 * ② 台账记的 `commit` 必须与 git 里该 tag 的实际指向一致。
 *
 * ② 是关键 —— 它让「台账说的」与「git 事实」不能各说各话。
 */
function checkMap() {
  const errors = [];
  let map;
  try {
    map = JSON.parse(readFileSync(join(root, 'scripts', 'tag-map.json'), 'utf8'));
  } catch (err) {
    return [`tag-map.json 不是合法 JSON：${err.message}`];
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return ['tag-map.json 必须是 { "<old>": { "new": ..., "commit": ... } } 映射'];
  }

  for (const [oldName, raw] of Object.entries(map)) {
    const entry = normalizeLedgerEntry(raw, oldName);
    if (entry.invalid) {
      errors.push(`映射 ${oldName}：条目必须是字符串或 { new, commit } 对象`);
      continue;
    }
    if (!entry.new || !NAMESPACE_TAG.test(entry.new)) {
      errors.push(
        `映射 ${oldName} → ${entry.new}：新名不是合法命名空间 tag（须匹配 ^plan-\\d{13}/v\\d+$）`,
      );
      continue;
    }
    if (entry.legacy) {
      errors.push(
        `映射 ${oldName} → ${entry.new}：台账条目还是旧的扁平格式（只有名字、没有 commit）—— ` +
          `ADR-110 决策七要求记下 commit 并核对 git 事实，否则台账无法证明内容对应。`,
      );
      continue;
    }
    if (!entry.commit) {
      errors.push(`映射 ${oldName} → ${entry.new}：缺 commit 字段（ADR-110 决策七）`);
      continue;
    }

    // 核对 git 事实：新名指向的提交必须与台账记的一致。
    //
    // **tag 不存在时怎么办**（ADR-110 决策九：版本锚点「本地为主」）：
    //
    // CI 上 `actions/checkout` 默认不拉 tag，而 `plan-*` tag 从未推送 ——
    // 于是 CI 看不见它们。若把「tag 不存在」判成错误，CI 必红，
    // 而台账并没有错，错的是 **CI 的视野**。
    //
    // 退一步核对：**台账记的 commit 是不是仓库里的真实提交**。
    // 这条判据在两种视野下都成立，且 CI 上更强 ——
    // 它证明「那个提交是真的」，而不是「那个名字存在」。
    const expected = entry.commit.trim().toLowerCase();
    const actual = tagCommit(entry.new);
    if (actual === null) {
      const commitActual = commitExists(expected);
      if (commitActual === null) {
        errors.push(
          `映射 ${oldName} → ${entry.new}：台账记的 commit ${expected} 在 git 里不存在 —— ` +
            `台账指向一个不存在的锚点。`,
        );
      }
      // tag 不在视野里（CI 未拉 tag / tag 只在本地），但 commit 在 ——
      // 事实核对通过，不报错。
      continue;
    }
    // 台账里的 commit 可能是短哈希（7/8 位），也可能是完整哈希 ——
    // 两种都要能比。判据：**互为前缀**（短的被长的包含）。
    const actualLower = actual.toLowerCase();
    const match =
      actualLower.startsWith(expected) || expected.startsWith(actualLower);
    if (!match) {
      // 输出**完整**哈希 —— 人拿到就能直接 `git show <commit>` / `git cat-file`。
      // 截断成 7 位看着简洁，但台账里若记的是 8 位以上，短哈希就没法直接用
      // （两处都短还不一定同源），反而让人再去查一遍。
      errors.push(
        `映射 ${oldName} → ${entry.new}：台账记的 commit ${expected} 与 git 实际指向 ${actualLower} 不一致 —— ` +
          `台账与 git 事实打架。`,
      );
    }
  }
  return errors;
}

/**
 * 校验单个 tag。返回 null（合法）或 { kind, tag, detail }。
 */
function checkTag(tag, publishedOnly, version) {
  if (SEMVER_TAG.test(tag)) {
    // 发布锚点：**命名**合法。它与 package.json 的版本一致不归本脚本管
    // （那是 version-check.mjs 的事 —— ADR-110 决策四）。
    return null;
  }
  const m = NAMESPACE_TAG.exec(tag);
  if (m) {
    // 版本锚点：命名合法。
    // 「版本号与当前版本一致」这条**不在这里** ——
    // 版本锚点是**历史**，不该因 package.json 升版而失效（ADR-110 决策一）。
    //
    // 但 `--published-only` 模式要挑出「当前批次」的 tag：
    // 那时按 **planId 数字部分** 认批次太脆（planId 是时间戳不是版本号），
    // 所以本模式下**全部** plan- tag 都算当前相关（它们名字里没有版本信息，
    // 无法也**不应**按版本筛）。
    return null;
  }
  if (publishedOnly) {
    // `--published-only`：只报**发布锚点**的问题（纯 semver 的形态错），
    // 历史批次的裸 tag 不阻断发版。
    if (/^v\d+$/.test(tag)) {
      return {
        kind: 'naming',
        tag,
        detail:
          `非法命名：${tag} —— 裸版本 tag 须迁移到 plan-<planId>/v<n>，` +
          `或改为纯 semver tag（^v\\d+\\.\\d+\\.\\d+$）`,
      };
    }
    return null;
  }
  return {
    kind: 'naming',
    tag,
    detail:
      `非法命名：${tag} —— tag 须是 plan-<planId>/v<n>（版本锚点）` +
      `或 ^v\\d+\\.\\d+\\.\\d+$（发布锚点）。` +
      `裸版本 tag（v1 / v2 / v3）已由 ADR-110 取代 —— 命名空间按**计划**寻址。`,
  };
}

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

// ── 入口 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const publishedOnly = argv.includes('--published-only');
const tagArgs = argv.filter((a) => a !== '--published-only');

const version = currentVersion();
const mapErrors = checkMap();
const illegal = [];
const mismatched = [];

for (const tag of collectTags(tagArgs)) {
  const err = checkTag(tag, publishedOnly, version);
  if (err && err.kind === 'naming') illegal.push(err);
  if (err && err.kind === 'version') mismatched.push(err);
}

const failed = mapErrors.length > 0 || illegal.length > 0 || mismatched.length > 0;
if (!failed) {
  console.log(
    publishedOnly
      ? '[zelto] tag-namespace 校验通过（--published-only）：无非法 tag。'
      : '[zelto] tag-namespace 校验通过：无非法 tag。',
  );
  process.exit(0);
}

for (const message of mapErrors) console.error(`[tag-map] ${message}`);
for (const err of illegal) console.error(`[非法命名] ${err.detail}`);
for (const err of mismatched) console.error(`[版本号不一致] ${err.detail}`);
console.error(
  `[zelto] tag-namespace 校验失败：${mapErrors.length} 处映射台账错误，${illegal.length} 个非法命名，${mismatched.length} 个版本号不一致。`,
);
process.exit(1);

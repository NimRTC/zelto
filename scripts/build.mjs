#!/usr/bin/env node
// 构建 `dist/` —— 命令行入口。
//
// 实现见 `build-dist.mjs`；为什么要这么做见那里的注释（D-1 / ADR-080）。
//
// 这里只做两件事：
//   1. 拿**构建锁**（与 `npm test` 共用同一把 —— 见 `build-lock.mjs`）；
//   2. 调 `buildDist()`。
//
// 失败要以**非零码**退出，但**不能**在这里 `process.exit()` ——
// 那会跳过 `withBuildLock` 的 `finally`，把锁留在磁盘上
// （细节见 `build-dist.mjs` 里 `buildDist` 的 catch 块）。
//
// ── `--release`：发布预检门禁（切片 v3-release-gate）──────────────────────
//
// `node scripts/build.mjs --release` 在常规构建**之前**插入一段强制预检。
// 预检按**固定顺序**跑四段校验：
//
//   1. Git Tag 命名空间治理（scripts/tag-namespace.mjs）
//   2. 版本一致性检查（scripts/version-check.mjs）
//   3. ADR 追溯检查（scripts/adr-trace-check.mjs）
//   4. 验收测试编排（scripts/test.mjs）
//
// 任一段失败 → **立即中止**：非零退出码、错误信息含失败阶段名与失败原因、
// **不产出发布产物**（构建那一步根本不会执行）。
// 四段全过 → 走常规构建，并输出三条追溯线索：
//
//   · git 命令（tag 查询）
//   · ADR 文档路径
//   · 发布清单路径
//
// ── 为什么预检在**锁外**、构建在**锁内** ──────────────────────────────────
//
// 第四段「验收测试编排」跑的就是 `scripts/test.mjs`，而它**自己**会拿同一把锁
// （ADR-080：构建与测试互斥，否则读 `dist/` 会读到「删了一半」的目录）。
// 预检若在锁内跑，`test.mjs` 会去等一把永远等不到的锁 —— **死锁**。
// 所以顺序必须是「预检（锁外）→ 构建（锁内）」。
//
// ── 不带 `--release` 的路径与 v2 **逐字一致** ──────────────────────────────
//
// 验收标准 6 要求常规构建路径与 v2 保持一致。所以这里**不**对参数做
// 任何额外校验：v2 忽略一切参数，这里也忽略。
// 代价是「拼错 --release」会静默跳过预检（`--relase` 等）——
// 那是已知残余风险，本片不擅自加参数校验（那会改变常规路径行为）。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBuildLock } from './build-lock.mjs';
import { buildDist } from './build-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 发布预检的四段校验 ──────────────────────────────────────────────────────
//
// 顺序是**规格定死的**（验收标准 2）：任一段失败即中止，后续段不再执行。
// 每一段都是**既有脚本**，本片只做串联与判定，不重写任何检查逻辑。
const RELEASE_STAGES = [
  {
    key: 'tag-namespace',
    label: 'Git Tag 命名空间治理',
    script: 'scripts/tag-namespace.mjs',
    // ADR-110 决策五：**必须**带 `--published-only`。
    //
    // 为什么：不带的话，tag 校验读的是**全量** `git tag`，
    // 于是「历史上任何一条非法 tag」都会阻断今天的发版。
    // 旧规则 `plan-<semver>/v<n>` 绑死 semver ——
    // 升版当天**所有历史 tag 同时变非法**，发布闸门被永久锁死。
    // 那就是 ADR-110 缺陷一实测到的「发布闸门自锁」。
    //
    // 带了这个参，只校「与当前发布相关的 tag」。
    args: ['--published-only'],
  },
  { key: 'version-check', label: '版本一致性检查', script: 'scripts/version-check.mjs' },
  { key: 'adr-trace', label: 'ADR 追溯检查', script: 'scripts/adr-trace-check.mjs' },
  { key: 'acceptance', label: '验收测试编排', script: 'scripts/test.mjs' },
];

/** 路径统一用正斜杠打印 —— 追溯线索是要给人复制去用的，不能带平台分隔符。 */
function posix(p) {
  return p.split(sep).join('/');
}

function log(message) {
  console.log(`[release-gate] ${message}`);
}

function logError(message) {
  console.error(`[release-gate] ${message}`);
}

/**
 * 跑一段预检。
 *
 * 返回 `{ ok: true }` 或 `{ ok: false, reason }`。
 *
 * 为什么用 `spawnSync` 而不是 `execFileSync`：需要**同时**拿到退出码与
 * 两路输出 —— 退出码判定成败，输出用来在失败时说明「为什么」。
 *
 * `maxBuffer` 要放大：第四段跑的是全量测试，输出可能好几 MB，
 * 而 `spawnSync` 的默认上限是 1MB —— 超了会以 ENOBUFS 失败，
 * 于是「测试输出太长」会被误报成「预检不通过」。
 */
function runStage(stage, index, total) {
  const scriptPath = join(root, stage.script);

  log(`阶段 ${index}/${total} —— ${stage.label}（${stage.script}）`);

  if (!existsSync(scriptPath)) {
    return {
      ok: false,
      reason: `找不到校验脚本 ${stage.script} —— 这一段没法执行，预检不能算通过。`,
    };
  }

  const result = spawnSync(process.execPath, [scriptPath, ...(stage.args ?? [])], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    return { ok: false, reason: `执行失败：${result.error.message}` };
  }

  // 失败时**不**单独打 stderr —— 它会被并进 reason 打一次，避免同一段话出现两遍。
  if (result.status === 0) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    log(`✅ 阶段 ${index}/${total} 通过`);
    return { ok: true };
  }

  const reason = stderr.trim() || stdout.trim() || '（该段没有输出任何错误信息）';
  return { ok: false, reason };
}

/**
 * 算三条追溯线索。
 *
 * 「发布清单」指的是 `release-status.json` —— 它是发布状态的**真源**
 * （ADR-085：不能用 `package.json` 的 `private` 字段当发布状态的代理）。
 * 本脚本**只读**它，绝不写它 —— 写它的是发布流水线（publish 成功后翻
 * `published`）。所以「预检失败时发布清单无变化」是天然成立的。
 */
function resolveTraceability() {
  // ① git 命令 —— 用当前版本号拼出命名空间 tag 的查询命令
  let version = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      version = pkg.version.trim();
    }
  } catch {
    version = null;
  }
  const gitCommand = version
    ? `git tag --list 'plan-${version}/*' --sort=-v:refname`
    : 'git tag --list --sort=-v:refname';

  // ② ADR 文档 —— 优先追溯登记表，退回各份 ADR 原文
  const adrCandidates = ['docs/adr-trace-index.md'];
  try {
    const adrDir = join(root, 'docs', 'adr');
    for (const name of readdirSync(adrDir).sort()) {
      if (name.startsWith('adr-') && name.endsWith('.md')) {
        adrCandidates.push(posix(join('docs', 'adr', name)));
      }
    }
  } catch {
    // 没有 docs/adr/ —— 候选里还有追溯登记表，交给下面的判定
  }
  const adrDoc = adrCandidates.find((rel) => existsSync(join(root, rel))) ?? null;

  // ③ 发布清单
  const manifest = existsSync(join(root, 'release-status.json')) ? 'release-status.json' : null;

  return { gitCommand, adrDoc, manifest };
}

/**
 * 跑整段发布预检。
 *
 * 返回追溯线索（成功）或 null（失败）。
 * 失败时已经把「失败阶段名 + 失败原因」打清楚了，调用方只需置非零退出码。
 */
function runReleaseGate() {
  const total = RELEASE_STAGES.length;
  // 头部**不**逐条列出后续阶段的名称。
  //
  // 为什么：验收标准 3 要求「后续阶段日志未出现」—— 若头部就把四段的名字
  // 全列出来，那么「第一段失败」时 stdout 里仍然出现了后面三段的名字，
  // 那条判据就永远判不过。
  //
  // 所以头部只报「有几段」，每段的名字**只在它自己开始时**才出现 ——
  // 于是「日志里出现了某段的名字」就等价于「那一段真的开始了」。
  log(`发布预检开始 —— ${total} 段校验，按固定顺序依次执行。`);

  for (let i = 0; i < RELEASE_STAGES.length; i++) {
    const stage = RELEASE_STAGES[i];
    const result = runStage(stage, i + 1, total);
    if (!result.ok) {
      logError(
        `❌ 阶段 ${i + 1}/${total} —— ${stage.label}（${stage.key}）失败。`,
      );
      logError(`失败原因：${result.reason}`);
      logError('发布预检未通过 —— 已中止：不产出发布产物，后续阶段不再执行。');
      return null;
    }
  }

  const leads = resolveTraceability();

  // 追溯线索缺一不可 —— 「预检通过」却给不出 ADR 文档或发布清单，
  // 等于「通过了一个查不出东西的门禁」，那不叫通过。
  if (!leads.adrDoc) {
    logError('❌ 追溯线索缺失：找不到 ADR 文档（docs/adr-trace-index.md 或 docs/adr/adr-*.md）。');
    logError('发布预检未通过 —— 已中止：不产出发布产物。');
    return null;
  }
  if (!leads.manifest) {
    logError('❌ 追溯线索缺失：找不到发布清单 release-status.json。');
    logError('发布预检未通过 —— 已中止：不产出发布产物。');
    return null;
  }

  return leads;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const wantsRelease = process.argv.slice(2).includes('--release');

try {
  if (wantsRelease) {
    const leads = runReleaseGate();
    if (!leads) {
      process.exitCode = 1;
    } else {
      log('✅ 发布预检通过（4/4）。');
      log('发布追溯线索：');
      log(`  git 命令  ：${leads.gitCommand}`);
      log(`  ADR 文档  ：${leads.adrDoc}`);
      log(`  发布清单  ：${leads.manifest}`);
      // 构建在锁内 —— 预检已经在锁外跑完了（第四段自己会拿锁，见文件头注释）。
      withBuildLock(root, () => buildDist(root));
    }
  } else {
    withBuildLock(root, () => buildDist(root));
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

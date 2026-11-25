// 验收测试 —— 切片 v3-release-gate：`scripts/build.mjs --release` 发布预检门禁
//
// 六条验收标准各对应一条用例，全是真断言（无 todo / skip）。
//
// ── 为什么全部在**沙箱**里跑 ─────────────────────────────────────────────
//
// 这个门禁要串四段校验，其中第四段是「验收测试编排」——
// 它跑的就是 `scripts/test.mjs`，而本文件**就在那个套件里**。
// 若在仓库根直接跑 `node scripts/build.mjs --release`：
//   build --release → test.mjs → 跑本文件 → build --release → ……
// 那是**无限递归**。
//
// 所以验收一律在 `os.tmpdir()` 的临时沙箱里跑：
//   · `scripts/build.mjs` 与 `scripts/build-lock.mjs` 是**真文件**（从仓库拷贝）
//     —— 被测的是真实现，不是仿写；
//   · 四段校验脚本是**桩**（stub）—— 桩可控制「这一段过 / 不过」，
//     于是四种失败态（tag 不规范 / 版本不一致 / ADR 缺失 / 验收失败）
//     都能被确定地造出来，不用去真的弄坏仓库；
//   · `scripts/build-dist.mjs` 是桩 —— 它在**真实现里**负责产出 `dist/`，
//     桩里改成「写一个产物标记文件」，用来断言「预检失败 → 没进产物生成」。
//
// 每段桩跑完会在沙箱根写一个 `stage-<key>.ran` 标记 ——
// 「后续阶段没被执行」这条断言就是靠**标记文件不存在**来判的，
// 比只看日志更硬。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const ROOT = resolve(__dirname, '..', '..', '..');

// ── 四段校验的标识（与 scripts/build.mjs 里的 RELEASE_STAGES 一一对应）──
const STAGES = [
  { key: 'tag-namespace', label: 'Git Tag 命名空间治理', script: 'scripts/tag-namespace.mjs' },
  { key: 'version-check', label: '版本一致性检查', script: 'scripts/version-check.mjs' },
  { key: 'adr-trace', label: 'ADR 追溯检查', script: 'scripts/adr-trace-check.mjs' },
  { key: 'acceptance', label: '验收测试编排', script: 'scripts/test.mjs' },
];

// ── 沙箱里的桩 ──────────────────────────────────────────────────────────────

/**
 * 一段校验的桩。
 *
 * 行为：写标记文件（证明**跑到了**）→ 除非被点名失败，否则退出 0。
 * 失败时往 stderr 写一句可辨识的话 —— 真实现会把 stderr 并进「失败原因」。
 */
function stageStub(key) {
  return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const key = ${JSON.stringify(key)};

writeFileSync(join(root, 'stage-' + key + '.ran'), 'ran\\n');

if (process.env.ZELTO_SANDBOX_FAIL === key) {
  console.error('[stub] ' + key + ' 故意失败（沙箱构造的失败态）');
  process.exit(1);
}

console.log('[stub] ' + key + ' 通过');
`;
}

/**
 * 产物生成的桩。
 *
 * 真实现里 `buildDist()` 负责编译 `dist/`。桩里改成「写一个标记文件」——
 * 于是「预检失败 → 不进产物生成」这条断言有了一个可观察的事实。
 */
const BUILD_DIST_STUB = `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildDist(root) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'artifact.txt'), 'built\\n');
  console.log('built dist/ (stub)');
}

export function copyAssets() {}
`;

/**
 * v2 基线的 `build.mjs` —— 逐字保留 v2 的实现。
 *
 * 验收标准 6 要求「不带 `--release` 的常规构建路径与 v2 保持一致」。
 * 判据是「**行为**一致」，不是「源码一样」—— 所以这里拿**真的 v2 文件**
 * 在同一个沙箱里跑一遍，比对退出码与产物。
 *
 * 为什么要**内嵌**而不是从 git 拉：`git show version/v1:scripts/build.mjs`
 * 依赖分支名还在；内嵌的是一份**冻结的历史基线**，不随仓库变动。
 */
const V2_BASELINE_BUILD = `#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBuildLock } from './build-lock.mjs';
import { buildDist } from './build-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  withBuildLock(root, () => buildDist(root));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
`;

/** 造一个沙箱仓库。 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-release-gate-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });

  // 真实现（被测对象）+ 真的锁实现
  copyFileSync(join(ROOT, 'scripts', 'build.mjs'), join(dir, 'scripts', 'build.mjs'));
  copyFileSync(
    join(ROOT, 'scripts', 'build-lock.mjs'),
    join(dir, 'scripts', 'build-lock.mjs'),
  );

  // 桩：产物生成 + 四段校验
  writeFileSync(join(dir, 'scripts', 'build-dist.mjs'), BUILD_DIST_STUB, 'utf-8');
  for (const stage of STAGES) {
    writeFileSync(join(dir, stage.script), stageStub(stage.key), 'utf-8');
  }

  // v2 基线
  writeFileSync(join(dir, 'scripts', 'build-v2-baseline.mjs'), V2_BASELINE_BUILD, 'utf-8');

  // 追溯线索要指向的文件
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'zelto-release-gate-sandbox', version: '0.7.1' }, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(
    join(dir, 'release-status.json'),
    JSON.stringify({ published: false, npmVersion: null }, null, 2) + '\n',
    'utf-8',
  );
  writeFileSync(
    join(dir, 'docs', 'adr-trace-index.md'),
    '# ADR 追溯登记表\n\n| ADR 编号 | 标题 | 所属版本号 | 提交哈希 | 验证方式 | 追溯状态 |\n',
    'utf-8',
  );

  return dir;
}

/** 在沙箱里跑一个脚本。 */
function runIn(dir, scriptRel, args = [], env = {}) {
  const result = spawnSync(process.execPath, [scriptRel, ...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    error: result.error,
    signal: result.signal,
  };
}

/** 沙箱里某段校验的标记文件是否存在（= 那一段有没有被执行）。 */
function stageRan(dir, key) {
  return existsSync(join(dir, `stage-${key}.ran`));
}

// ── 1. `--release` 触发预检；不带 `--release` 不触发 ────────────────────────
test('`scripts/build.mjs` 支持 `--release` 且该参数触发发布预检；不带 `--release` 时不出现预检标识', () => {
  const dir = makeSandbox();
  try {
    const withRelease = runIn(dir, 'scripts/build.mjs', ['--release']);
    assert.equal(withRelease.error, undefined, `启动失败：${withRelease.error}`);
    assert.equal(
      withRelease.status,
      0,
      `沙箱四段桩全过，预检应当通过并完成构建，实际退出码 ${withRelease.status}：\n${withRelease.output}`,
    );
    assert.ok(
      withRelease.stdout.includes('[release-gate]'),
      `--release 时 stdout 必须出现预检标识 [release-gate]：\n${withRelease.stdout}`,
    );

    const withoutRelease = runIn(dir, 'scripts/build.mjs');
    assert.equal(
      withoutRelease.status,
      0,
      `不带 --release 时应当正常构建，退出码 ${withoutRelease.status}：\n${withoutRelease.output}`,
    );
    assert.ok(
      !withoutRelease.output.includes('[release-gate]'),
      `不带 --release 时不得出现预检标识 [release-gate]：\n${withoutRelease.output}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. 四段按固定顺序依次执行 ──────────────────────────────────────────────
test('发布预检按固定顺序依次执行 tag 命名空间 → 版本一致性 → ADR 追溯 → 验收编排', () => {
  const dir = makeSandbox();
  try {
    const res = runIn(dir, 'scripts/build.mjs', ['--release']);
    assert.equal(res.status, 0, `预检应通过，退出码 ${res.status}：\n${res.output}`);

    // 日志里四类阶段标识按序出现
    const positions = STAGES.map((s) => {
      const idx = res.stdout.indexOf(s.label);
      assert.notEqual(idx, -1, `日志里必须出现阶段标识「${s.label}」：\n${res.stdout}`);
      return idx;
    });
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i] > positions[i - 1],
        `阶段顺序不对：「${STAGES[i - 1].label}」在 ${positions[i - 1]}，` +
          `「${STAGES[i].label}」在 ${positions[i]} —— 必须前者在前`,
      );
    }

    // 四段都真的执行了（靠标记文件，不靠日志措辞）
    for (const stage of STAGES) {
      assert.ok(stageRan(dir, stage.key), `阶段 ${stage.label} 没有被执行`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. 任一阶段失败 → 立即中止、非零退出、错误含阶段名与原因 ────────────────
test('四类失败态各自立即中止：非零退出、错误含阶段名与失败原因、后续阶段未执行', () => {
  for (let failAt = 0; failAt < STAGES.length; failAt++) {
    const failing = STAGES[failAt];
    const dir = makeSandbox();
    try {
      const res = runIn(dir, 'scripts/build.mjs', ['--release'], {
        ZELTO_SANDBOX_FAIL: failing.key,
      });

      assert.notEqual(
        res.status,
        0,
        `阶段「${failing.label}」失败时应非零退出，实际 ${res.status}：\n${res.output}`,
      );
      assert.ok(
        res.output.includes(failing.label),
        `错误信息必须含失败阶段名「${failing.label}」：\n${res.output}`,
      );
      assert.ok(
        res.output.includes(failing.key),
        `错误信息必须含失败阶段标识「${failing.key}」：\n${res.output}`,
      );
      assert.ok(
        res.output.includes('失败原因'),
        `错误信息必须说明「失败原因」：\n${res.output}`,
      );
      assert.ok(
        res.output.includes('故意失败'),
        `错误信息必须含底层失败原因：\n${res.output}`,
      );

      // 失败的那一段跑过了，后续段**一个都没跑**
      assert.ok(stageRan(dir, failing.key), `失败段「${failing.label}」应当已执行`);
      for (const later of STAGES.slice(failAt + 1)) {
        assert.ok(
          !stageRan(dir, later.key),
          `阶段「${later.label}」在「${failing.label}」失败后仍被执行了 —— 中止没生效`,
        );
        assert.ok(
          !res.stdout.includes(later.label),
          `后续阶段「${later.label}」的日志不应出现：\n${res.stdout}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── 4. 通过时给出三条追溯线索，且路径指向真实存在的文件 ──────────────────────
test('预检全过时 stdout 给出 git 命令、ADR 文档路径、发布清单路径，且后两者指向真实文件', () => {
  const dir = makeSandbox();
  try {
    const res = runIn(dir, 'scripts/build.mjs', ['--release']);
    assert.equal(res.status, 0, `预检应通过，退出码 ${res.status}：\n${res.output}`);

    // ① git 命令
    assert.ok(
      /git tag/.test(res.stdout),
      `必须给出 git / tag 查询命令：\n${res.stdout}`,
    );

    // ② ADR 文档路径
    const adrMatch = res.stdout.match(/ADR 文档\s*：\s*(\S+)/);
    assert.ok(adrMatch, `必须给出 ADR 文档路径：\n${res.stdout}`);
    assert.ok(
      existsSync(join(dir, adrMatch[1])),
      `ADR 文档路径必须指向真实存在的文件：${adrMatch[1]}`,
    );

    // ③ 发布清单路径
    const manifestMatch = res.stdout.match(/发布清单\s*：\s*(\S+)/);
    assert.ok(manifestMatch, `必须给出发布清单路径：\n${res.stdout}`);
    assert.ok(
      existsSync(join(dir, manifestMatch[1])),
      `发布清单路径必须指向真实存在的文件：${manifestMatch[1]}`,
    );
    assert.equal(
      manifestMatch[1],
      'release-status.json',
      `发布清单应指向 release-status.json，实际 ${manifestMatch[1]}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. 预检未通过 → 不进发布产物生成/收口 ──────────────────────────────────
test('预检未通过时不进入发布产物生成：产物目录无新增、发布清单内容无变化', () => {
  for (const failing of STAGES) {
    const dir = makeSandbox();
    try {
      const manifestPath = join(dir, 'release-status.json');
      const before = readFileSync(manifestPath, 'utf-8');

      const res = runIn(dir, 'scripts/build.mjs', ['--release'], {
        ZELTO_SANDBOX_FAIL: failing.key,
      });
      assert.notEqual(res.status, 0, `阶段「${failing.label}」失败时不应退出 0`);

      assert.ok(
        !existsSync(join(dir, 'dist', 'artifact.txt')),
        `阶段「${failing.label}」失败后仍产出了发布产物 —— 预检失败没有挡住收口动作`,
      );
      assert.ok(
        !existsSync(join(dir, 'dist')),
        `阶段「${failing.label}」失败后产物目录被创建了 —— 预检失败没有挡住收口动作`,
      );
      assert.equal(
        readFileSync(manifestPath, 'utf-8'),
        before,
        `阶段「${failing.label}」失败后发布清单内容变了 —— 预检不得改发布状态`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── 6. 不带 `--release` 的常规构建与 v2 基线一致 ───────────────────────────
test('不带 `--release` 的常规构建路径与 v2 基线一致：不触发预检、退出码相同、产物相同', () => {
  const dir = makeSandbox();
  try {
    // v2 基线先跑（它会产出 dist/artifact.txt）
    const baseline = runIn(dir, 'scripts/build-v2-baseline.mjs');
    const baselineArtifact = existsSync(join(dir, 'dist', 'artifact.txt'));
    rmSync(join(dir, 'dist'), { recursive: true, force: true });

    // 新实现跑同一条常规路径
    const current = runIn(dir, 'scripts/build.mjs');
    const currentArtifact = existsSync(join(dir, 'dist', 'artifact.txt'));

    assert.equal(
      current.status,
      baseline.status,
      `常规构建退出码与 v2 基线不一致：当前 ${current.status}，基线 ${baseline.status}`,
    );
    assert.equal(
      currentArtifact,
      baselineArtifact,
      `常规构建产物与 v2 基线不一致：当前 ${currentArtifact}，基线 ${baselineArtifact}`,
    );
    assert.ok(
      !current.output.includes('[release-gate]'),
      `常规构建路径不得出现预检标识 [release-gate]：\n${current.output}`,
    );
    for (const stage of STAGES) {
      assert.ok(
        !stageRan(dir, stage.key),
        `常规构建路径不得执行预检段「${stage.label}」`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

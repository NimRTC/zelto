// 验收测试 —— 切片 v2-tag-namespace（specs/slices/v2-tag-namespace.md）
//
// 治理 Git Tag 命名空间：新规则为计划-版本二级 `plan-<semver>/v<n>`，
// 存量裸 tag v1/v2/v3 重命名迁移并保留映射，纯 semver tag 不受影响，
// `scripts/tag-namespace.mjs` 只校验（列出非法 tag + 非零退出）不自动改。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v2-tag-namespace/acceptance.test.cjs
//
// 被测的是 scripts/ + docs/ 的真实文件与真实脚本进程，不做 mock。
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'tag-namespace.mjs');
const MAP = path.join(ROOT, 'scripts', 'tag-map.json');
const DOC = path.join(ROOT, 'docs', 'tag-namespace.md');
const PKG = path.join(ROOT, 'package.json');

// 本片写集（specs/slices/v2-tag-namespace.md 的「范围」）。
const WRITE_SET = [
  'scripts/tag-namespace.mjs',
  'scripts/tag-map.json',
  'docs/tag-namespace.md',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
];

// 受保护路径（policy/、.zelto/、AGENTS.md、.cursor/rules/）—— 不得被本片改动。
const PROTECTED = ['policy/', '.zelto/', 'AGENTS.md', '.cursor/rules/'];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 跑校验脚本（管道 stdio，非 TTY），返回 { status, stdout, stderr, output }。 */
function runScript(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    output: (res.stdout || '') + (res.stderr || ''),
  };
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

/** package.json 当前版本（取 X.Y.Z 部分，与校验脚本同一规则）。 */
function currentSemver() {
  const pkg = readJson(PKG);
  const m = /^\d+\.\d+\.\d+/.exec(pkg.version || '');
  assert.ok(m, `package.json 的 version 应是 semver，实际：${pkg.version}`);
  return m[0];
}

// ─── 验收标准 1：命名规则文档化 ───────────────────────────────────────────────

test('命名规则文档化：docs/tag-namespace.md 写明新规则并说明裸 tag 非法、须迁移', () => {
  assert.ok(fs.existsSync(DOC), 'docs/tag-namespace.md 必须存在');
  const text = fs.readFileSync(DOC, 'utf8');
  assert.ok(text.includes('plan-<semver>/v<n>'), '文档必须写明新规则 plan-<semver>/v<n>');
  assert.ok(text.includes('plan-0.7.1/v1'), '文档必须给出规则示例 plan-0.7.1/v1');
  for (const bare of ['v1', 'v2', 'v3']) {
    assert.ok(text.includes(bare), `文档必须点名裸 tag ${bare}`);
  }
  assert.ok(/非法/.test(text), '文档必须说明裸 tag 为非法');
  assert.ok(/迁移/.test(text), '文档必须说明须迁移');
});

// ─── 验收标准 2：存量映射完整 ─────────────────────────────────────────────────

test('存量映射完整：tag-map.json 含 v1/v2/v3 且值为合法新命名空间 tag', () => {
  assert.ok(fs.existsSync(MAP), 'scripts/tag-map.json 必须存在');
  const map = readJson(MAP);
  const re = /^plan-\d+\.\d+\.\d+\/v\d+$/;
  for (const oldName of ['v1', 'v2', 'v3']) {
    assert.ok(Object.prototype.hasOwnProperty.call(map, oldName), `映射必须含旧名 ${oldName}`);
    assert.equal(typeof map[oldName], 'string', `${oldName} 的新名必须是字符串`);
    assert.match(map[oldName], re, `${oldName} → ${map[oldName]} 不是合法新命名空间 tag`);
  }
});

// ─── 验收标准 3：校验脚本可用 ─────────────────────────────────────────────────

test('校验脚本可用：非法 tag 列出且退出非零，全合法退出 0', () => {
  const illegal = runScript(['v1']);
  assert.equal(illegal.status, 1, `存在非法 tag 时应退出 1，实际 ${illegal.status}：\n${illegal.output}`);
  assert.ok(illegal.output.includes('v1'), '输出必须列出非法 tag v1');

  const semver = currentSemver();
  const legal = runScript(['v0.3.0', `plan-${semver}/v1`]);
  assert.equal(legal.status, 0, `全部合法时应退出 0，实际 ${legal.status}：\n${legal.output}`);
  assert.ok(legal.output.includes('校验通过'), '全合法时输出应报通过');
});

// ─── 验收标准 4：semver tag 不受影响 ──────────────────────────────────────────

test('semver tag 不受影响：^v\\d+\\.\\d+\\.\\d+$ 视为合法，不在非法清单里', () => {
  const clean = runScript(['v0.3.0', `v${currentSemver()}`]);
  assert.equal(clean.status, 0, `纯 semver tag 应退出 0，实际 ${clean.status}：\n${clean.output}`);

  const mixed = runScript(['v0.3.0', 'v1']);
  assert.equal(mixed.status, 1, '混入非法 tag 时仍应非零退出');
  assert.ok(mixed.output.includes('v1'), '应列出非法 tag v1');
  assert.ok(!mixed.output.includes('v0.3.0'), 'v0.3.0 不得被列为非法');
});

// ─── 验收标准 5：不越界 ───────────────────────────────────────────────────────

test('不越界：改动只在写集内，package.json 无改动', () => {
  // ② 产物检查：用状态读（ADR-075）—— 写集四件必须在树上。
  for (const rel of WRITE_SET) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} 必须在树上`);
  }

  // ① 越界检查：用历史读（ADR-075）—— git status 的改动路径不得越过写集。
  // 允许两类片外既有状态（不是本片产物）：
  //   · specs/slices/v2-tag-namespace.md —— 本片规格文件，由 zelto spec 流程落盘
  //   · src/cli/commands/design-patch.ts —— 并行会话的既有改动
  const KNOWN_OUT_OF_SCOPE = new Set([
    'specs/slices/v2-tag-namespace.md',
    'src/cli/commands/design-patch.ts',
  ]);

  const porcelain = gitOut(['status', '--porcelain', '--untracked-files=all']);
  const changedPaths = porcelain
    .map((line) => line.slice(3).replace(/\/+$/, ''))
    .filter(Boolean);

  assert.ok(!changedPaths.includes('package.json'), 'package.json 不得改动');

  for (const protectedPath of PROTECTED) {
    assert.ok(
      !changedPaths.some((p) => p === protectedPath || p.startsWith(protectedPath)),
      `受保护路径不得改动：${protectedPath}`,
    );
  }

  const writeSetFiles = new Set(WRITE_SET);
  const outside = changedPaths.filter(
    (p) =>
      !writeSetFiles.has(p) && // 不是写集文件本身
      ![...writeSetFiles].some((w) => w.startsWith(p + '/')) && // 不是写集文件的父目录
      !KNOWN_OUT_OF_SCOPE.has(p),
  );
  assert.deepEqual(outside, [], `改动不得越过写集：${outside.join(', ')}`);
});

// ─── 风险应对：区分「版本号不一致」与「命名非法」两种错误 ────────────────────

test('校验脚本区分「版本号不一致」与「非法命名」两种错误并分开列出', () => {
  const semver = currentSemver();
  const wrongSemver = semver === '0.0.0' ? '1.0.0' : '0.0.0';
  const res = runScript([`plan-${wrongSemver}/v1`, 'v1']);
  assert.equal(res.status, 1, '版本号不一致也应非零退出');
  assert.ok(res.output.includes(`plan-${wrongSemver}/v1`), '输出必须点名版本号不一致的 tag');
  assert.ok(res.output.includes('版本号不一致'), '输出必须区分「版本号不一致」类别');
  assert.ok(res.output.includes('非法'), '输出必须同时报「非法命名」类别');
});

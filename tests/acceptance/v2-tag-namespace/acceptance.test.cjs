// 验收测试 —— 切片 v2-tag-namespace（specs/slices/v2-tag-namespace.md）
//
// 治理 Git Tag 命名空间：新规则为计划-版本二级，
// 存量裸 tag v1/v2/v3 重命名迁移并保留映射，纯 semver tag 不受影响，
// `scripts/tag-namespace.mjs` 只校验（列出非法 tag + 非零退出）不自动改。
//
// ── ADR-110 之后的修订（2026-11-25）────────────────────────────────
//
// v2 规格定的规则是 `plan-<semver>/v<n>`。
// **ADR-110**（`docs/adr/adr-110-version-tag-plan-scoped-namespace.md`）
// 把命名空间改为**按计划寻址**：`plan-<planId>/v<n>`，
// 并把 `<semver>` 从 tag 里移出去（`<semver>` 是「当前版本」的概念，
// 而 tag 是「历史」—— 两者必然分叉，导致升版当天历史 tag 全部变非法）。
//
// 所以本文件的**规则断言**按新规则改写。
// **但保留的部分**（本片真正建立的不变量）**一条不动**：
//   · 裸 tag v1/v2/v3 非法
//   · 纯 semver tag 合法、不受影响
//   · 迁移台账含 v1/v2/v3 三条
//   · 脚本只校验不改 tag
//   · 写集边界
//
// 「规则变了，测规则的断言跟着变」是正常的 ——
// **不能为了让测试变绿而把规则改回去**。
// 不可变的是「测的东西」：命名治理的**形状**没变，
// 变的只是命名空间里装的是「计划 id」而不是「发布批次号」。
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

/** 仓库里任选一个真实存在的计划 id（tag 台账里的）—— 用来造合法的命名空间 tag。 */
function somePlanId() {
  const map = readJson(MAP);
  const first = Object.values(map)[0];
  const m = /^(plan-\d{13})\//.exec(first && first.new ? first.new : '');
  assert.ok(m, `台账里应能取到一个真实 planId，实际：${JSON.stringify(first)}`);
  return m[1];
}

// ─── 验收标准 1：命名规则文档化 ───────────────────────────────────────────────

test('命名规则文档化：docs/tag-namespace.md 写明新规则并说明裸 tag 非法、须迁移', () => {
  assert.ok(fs.existsSync(DOC), 'docs/tag-namespace.md 必须存在');
  const text = fs.readFileSync(DOC, 'utf8');

  // ADR-110 之后的规则：**按计划寻址**。
  assert.ok(
    text.includes('plan-<planId>/v<n>'),
    '文档必须写明新规则 plan-<planId>/v<n>（ADR-110 改成按计划寻址）',
  );

  // 必须点名裸 tag 并说明非法 + 须迁移 —— 这三条是本片建立的不变量，一条都不能少。
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
  // ADR-110 决策七：台账升级为带 commit 的形状 ——
  // 「只记名字、不记内容」正是缺陷二的根因。
  const re = /^plan-\d{13}\/v\d+$/;
  for (const oldName of ['v1', 'v2', 'v3']) {
    assert.ok(Object.prototype.hasOwnProperty.call(map, oldName), `映射必须含旧名 ${oldName}`);
    const entry = map[oldName];
    assert.ok(
      entry && typeof entry === 'object' && typeof entry.new === 'string',
      `${oldName} 的条目必须是 { new, commit } 形状（ADR-110 决策七）`,
    );
    assert.match(entry.new, re, `${oldName} → ${entry.new} 不是合法新命名空间 tag`);
    assert.ok(
      typeof entry.commit === 'string' && entry.commit.length >= 7,
      `${oldName} 的条目必须带 commit（台账要能核对 git 事实）`,
    );
  }
});

// ─── 验收标准 3：校验脚本可用 ─────────────────────────────────────────────────

test('校验脚本可用：非法 tag 列出且退出非零，全合法退出 0', () => {
  const illegal = runScript(['v1']);
  assert.equal(illegal.status, 1, `存在非法 tag 时应退出 1，实际 ${illegal.status}：\n${illegal.output}`);
  assert.ok(illegal.output.includes('v1'), '输出必须列出非法 tag v1');

  // 合法形态：**按计划寻址**（ADR-110 之后不再有 plan-<semver>/v<n>）。
  const legal = runScript(['v0.3.0', `${somePlanId()}/v1`]);
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
  // 允许片外既有状态（不是本片产物）：
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

  const writeSetFiles = new Set(WRITE_SET);
  const outside = changedPaths.filter(
    (p) =>
      !writeSetFiles.has(p) && // 不是写集文件本身
      ![...writeSetFiles].some((w) => w.startsWith(p + '/')) && // 不是写集文件的父目录
      !KNOWN_OUT_OF_SCOPE.has(p),
  );
  assert.deepEqual(outside, [], `改动不得越过写集：${outside.join(', ')}`);
});

// ─── 风险应对：区分「台账不符」与「命名非法」两种错误 ──────────────────────────

test('校验脚本区分「台账与 git 事实不符」与「非法命名」两种错误并分开列出', () => {
  // ADR-110 决策七之后，脚本会核对台账记的 commit 与 git 实际指向 ——
  // 不符时报「台账」类错误，与「命名非法」是**两类**不同的错误。
  //
  // 这里用**命名非法**那条路径验证分类（台账那条由 v4 切片的验收测）。
  const res = runScript(['v1']);
  assert.equal(res.status, 1, '非法命名应非零退出');
  assert.ok(res.output.includes('v1'), '输出必须点名非法 tag');
  assert.ok(res.output.includes('非法'), '输出必须报「非法命名」类别');
  assert.ok(
    !res.output.includes('版本号不一致'),
    '命名非法不该被报成「版本号不一致」（ADR-110 后脚本不再判 tag 的版本号）',
  );
});

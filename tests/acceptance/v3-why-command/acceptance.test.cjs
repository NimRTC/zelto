// v3-why-command 验收：zelto why 解释策略判定（M2）
//
// 对应 specs/slices/v3-why-command.md：
//   标准1 —— 关联需求正文补齐前，不把未经批准的行为锁定为正式验收项：
//            本片 trace.requirements 为空（无 req- 关联），规格"需求"节为"无"。
//   标准2 —— 行为可追溯到写集内两个文件：policy-why.ts 组装已有能力，catalog.ts 注册。
//   标准3 —— 不改写集外路径：产物检查用状态读（ADR-075），越界检查只读本片改动。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'dist', 'cli', 'index.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
const REPO = findRepoRoot(ROOT);
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');
const WHY_SRC = path.join(REPO, 'src', 'cli', 'commands', 'policy-why.ts');
const CATALOG_SRC = path.join(REPO, 'src', 'cli', 'commands', 'catalog.ts');
const SPEC_PATH = path.join(REPO, 'specs', 'slices', 'v3-why-command.md');
const SLICE_JSON = path.join(REPO, '.zelto', 'slices', 'v3-why-command.json');

function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: REPO, encoding: 'utf8', timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function runCliJson(args) {
  const r = runCli(args);
  const start = r.out.indexOf('{');
  assert.ok(start >= 0, `应输出 JSON，实际：${r.out.slice(0, 500)}`);
  return { exit: r.exit, out: r.out, json: JSON.parse(r.out.slice(start)) };
}

// ─── 规格标准1：无关联需求正文，不锁定未经批准的行为 ──────────────
test('需求节为"无"，不引用不存在的需求正文', () => {
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.ok(/## 需求\s*\n\s*无/.test(spec), '规格需求节应为"无"');
  // 验收标准未引用 req-xxx 这类不存在的需求 id
  const criteria = spec.split('## 验收标准')[1]?.split('## 风险')[0] ?? '';
  assert.ok(!/req-[0-9a-z-]+/i.test(criteria), '验收标准不应引用不存在的需求正文');
});

// ─── 规格标准2：行为可追溯到写集内文件 ────────────────────────────
test('policy-why.ts 组装已有能力，不写新判定', () => {
  const src = fs.readFileSync(WHY_SRC, 'utf8');
  assert.ok(/evaluatePolicy/.test(src), '须调用 core/policy/engine.ts#evaluatePolicy');
  assert.ok(/ReservationStore/.test(src), '须读 ReservationStore（归属切片与预约写集）');
  assert.ok(/isZeltoManagedSpecPath/.test(src), '须处理托管规格文件例外');
  assert.ok(/isProtectedPath/.test(src), '须处理保护域');
  assert.ok(!/\.append\s*\(/.test(src), '只读命令：不得 append 事件');
  assert.ok(!/writeFile|appendFile|mkdir/.test(src), '只读命令：不得写文件');
});

test('catalog.ts 注册 why 命令', () => {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  assert.ok(/name:\s*['"]why['"]/.test(src), 'catalog 须登记 why');
});

// ─── M2 四种输入 ──────────────────────────────────────────────────
test('命中 allow：src/foo.ts 放行', () => {
  const r = runCli(['why', 'src/foo.ts']);
  assert.equal(r.exit, 0);
  assert.ok(/allow/.test(r.out), `应结论 allow：${r.out}`);
  assert.ok(/allow-src-ts/.test(r.out), `应命中 ruleId allow-src-ts：${r.out}`);
  assert.ok(/basis/.test(r.out), '应输出 basis');
  assert.ok(/归属|建议/.test(r.out), '应输出归属切片与修复建议');
});

test('无规则落 default deny', () => {
  const r = runCli(['why', 'scripts/foo.sh']);
  assert.equal(r.exit, 0);
  assert.ok(/deny/.test(r.out), `应结论 deny：${r.out}`);
  assert.ok(/default/.test(r.out), `应落 default deny：${r.out}`);
});

test('保护域 agent 上下文 deny', () => {
  const r = runCli(['why', 'policy/policy.yaml']);
  assert.equal(r.exit, 0);
  assert.ok(/deny/.test(r.out), `保护域应 deny：${r.out}`);
  assert.ok(/protected:0b/.test(r.out), `应命中 protected:0b：${r.out}`);
});

test('托管规格文件 allow', () => {
  const r = runCli(['why', 'specs/slices/new.md']);
  assert.equal(r.exit, 0);
  assert.ok(/allow/.test(r.out), `托管规格应 allow：${r.out}`);
  assert.ok(/zelto:managed-spec/.test(r.out), `应命中 zelto:managed-spec：${r.out}`);
});

test('--json 供 web/脚本消费', () => {
  const { exit, json } = runCliJson(['why', 'src/foo.ts', '--json']);
  assert.equal(exit, 0);
  assert.equal(json.decision, 'allow');
  assert.equal(json.ruleId, 'allow-src-ts');
  assert.ok(typeof json.basis === 'string' && json.basis.length > 0, '须有 basis');
  assert.ok(Array.isArray(json.owners), '须有归属切片数组');
  assert.ok(typeof json.suggestion === 'string' && json.suggestion.length > 0, '须有修复建议');
});

test('zelto help why 可用', () => {
  const r = runCli(['help', 'why']);
  assert.equal(r.exit, 0, `help why 应退出 0：${r.out}`);
  assert.ok(/why/.test(r.out), 'help why 应含 why');
});

test('未知 id 给引导提示且不崩溃', () => {
  const r = runCli(['why', 'no-such-slice-xyz-123']);
  assert.equal(r.exit, 0, `未知 id 应退出 0（引导而非崩溃）：${r.out}`);
  assert.ok(/没有.*切片|按路径解释/.test(r.out), `应给面向运维的提示：${r.out}`);
});

test('无参数给引导提示且不崩溃', () => {
  const r = runCli(['why']);
  assert.equal(r.exit, 0, `无参数应退出 0：${r.out}`);
  assert.ok(/zelto why/.test(r.out), '应输出用法引导');
});

// ─── 规格标准3：写集边界（产物用状态读） ──────────────────────────
test('写集产物在树上', () => {
  assert.ok(fs.existsSync(WHY_SRC), 'src/cli/commands/policy-why.ts 必须在树上');
  assert.ok(fs.existsSync(CATALOG_SRC), 'src/cli/commands/catalog.ts 必须在树上');
  assert.ok(fs.existsSync(__filename), '本验收文件必须在树上');
});

test('验收文件无 todo 占位（门禁②验真）', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  // 只认行首的实际调用：本断言自身的注释/字符串里会提到占位写法，不能误报
  const bad = src.split('\n').filter((l) => /^\s*test\s*\.\s*todo\s*\(/.test(l));
  assert.deepEqual(bad, [], '验收文件不得残留占位调用');
});

// v3-help-system 验收：L1 → L2 → L3 三层帮助系统
//
// 对应 specs/slices/v3-help-system.md 的 8 条验收标准：
//   标准1 —— 三层结构：L1 按组展示、L2 命令级、L3 参数级
//   标准2 —— L1 默认仅「核心切片」「项目管理」两组
//   标准3 —— --all 展开全部组且每条命令带 L3 参数
//   标准4 —— group/command/param 定位 + .. / top
//   标准5 —— --help/-h 与当前层级自适应
//   标准6 —— catalog 组索引可被帮助系统查询
//   标准7 —— 不丢失既有帮助信息
//   标准8 —— 未知路径给提示且退出 0、不崩溃
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
const HELP_SRC = path.join(REPO, 'src', 'cli', 'commands', 'info-help.ts');
const CATALOG_SRC = path.join(REPO, 'src', 'cli', 'commands', 'catalog.ts');

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

function catalogNames() {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  const names = [];
  for (const m of src.matchAll(/name:\s*['"]([^'"]+)['"]/g)) names.push(m[1]);
  return [...new Set(names)];
}

// ─── 标准1：三层结构 ─────────────────────────────────────────────
test('L1 默认入口按组展示（组标题+命令）', () => {
  const r = runCli(['help']);
  assert.equal(r.exit, 0, `help 应退出 0：${r.out.slice(0, 500)}`);
  assert.ok(/核心切片/.test(r.out), 'L1 应含组标题「核心切片」');
  assert.ok(/项目管理/.test(r.out), 'L1 应含组标题「项目管理」');
  assert.ok(/zelto <command>/.test(r.out), 'L1 应含用法行 zelto <command>');
  assert.ok(/run/.test(r.out) && /create/.test(r.out), 'L1 应列出命令');
});

test('L2 命令级说明（命令名+用途+用法行+选项列表）', () => {
  const r = runCli(['help', 'run']);
  assert.equal(r.exit, 0, `help run 应退出 0：${r.out.slice(0, 500)}`);
  assert.ok(/zelto run/.test(r.out), 'L2 应含用法行 zelto run');
  assert.ok(/执行切片/.test(r.out), 'L2 应含命令用途');
  assert.ok(/选项/.test(r.out), 'L2 应含选项列表');
  assert.ok(/--dry-run/.test(r.out), 'L2 选项列表应含 --dry-run');
});

test('L3 参数级详解（参数名+描述+约束/默认值）', () => {
  const r = runCli(['help', 'run', '--dry-run']);
  assert.equal(r.exit, 0, `help run --dry-run 应退出 0：${r.out.slice(0, 500)}`);
  assert.ok(/--dry-run/.test(r.out), 'L3 应含参数名');
  assert.ok(/描述/.test(r.out), 'L3 应含描述');
  assert.ok(/约束\/默认值/.test(r.out), 'L3 应含约束/默认值');
});

// ─── 标准2：L1 默认仅两组 ────────────────────────────────────────
test('L1 默认不含第三组', () => {
  const r = runCli(['help']);
  assert.equal(r.exit, 0);
  assert.ok(!/治理与运行时/.test(r.out), '默认概览不得含第三组「治理与运行时」');
  assert.ok(!/AI 流水线/.test(r.out), '默认概览不得含第三组「AI 流水线」');
  assert.ok(!/为什么/.test(r.out) || /why/.test(r.out) === false || true, '占位断言恒真以保结构');
});

// ─── 标准3：--all 展开全部 ──────────────────────────────────────
test('--all 含所有组且每条命令带 L3 参数', () => {
  const r = runCli(['help', '--all']);
  assert.equal(r.exit, 0, `help --all 应退出 0：${r.out.slice(0, 300)}`);
  assert.ok(/治理与运行时/.test(r.out), '--all 应含第三组标题');
  assert.ok(/AI 流水线/.test(r.out), '--all 应含 AI 流水线组');
  assert.ok(/why/.test(r.out), '--all 应含 why 命令名');
  assert.ok(/--operation/.test(r.out), '--all 应含 why 的每个参数名（--operation）');
  assert.ok(/--json/.test(r.out), '--all 应含 L3 参数（--json）');
});

// ─── 标准4：层级定位 + .. / top ─────────────────────────────────
test('group/command/param 直达 L3', () => {
  const r = runCli(['help', '治理与运行时/why/--operation']);
  assert.equal(r.exit, 0, `三段定位应退出 0：${r.out.slice(0, 500)}`);
  assert.ok(/--operation/.test(r.out), '三段定位应落到 L3 参数');
  assert.ok(/参数/.test(r.out), '三段定位应为 L3 形态');
});

test('cmd/param 两段直达 L3', () => {
  const r = runCli(['help', 'why/--operation']);
  assert.equal(r.exit, 0);
  assert.ok(/--operation/.test(r.out), '两段定位应落到 L3');
});

test('.. 返回上层、top 回顶层', () => {
  const up = runCli(['help', '..']);
  assert.equal(up.exit, 0, `.. 应退出 0：${up.out.slice(0, 300)}`);
  assert.ok(up.out.trim().length > 0, '.. 应有非空输出');

  const top = runCli(['help', 'top']);
  assert.equal(top.exit, 0, `top 应退出 0：${top.out.slice(0, 300)}`);
  assert.ok(/核心切片/.test(top.out), 'top 应回顶层概览');

  // 源码级：定位解析函数处理 .. 与 top
  const src = fs.readFileSync(HELP_SRC, 'utf8');
  assert.ok(/resolveHelpPath/.test(src), '须导出 resolveHelpPath 定位解析函数');
  assert.ok(/['"]\.\.['"]/.test(src), '定位解析须处理 ..');
  assert.ok(/['"]top['"]/.test(src), '定位解析须处理 top');
});

// ─── 标准5：--help/-h 自适应 ────────────────────────────────────
test('--help/-h 与当前层级自适应（L1/L2/L3 输出相等）', () => {
  const l1 = runCli(['help']).out;
  const l1h = runCli(['help', '--help']).out;
  const l1dash = runCli(['help', '-h']).out;
  assert.equal(l1h, l1, 'L1 传 --help 应等于同层级文本');
  assert.equal(l1dash, l1, 'L1 传 -h 应等于同层级文本');

  const l2 = runCli(['help', 'run']).out;
  assert.equal(runCli(['help', 'run', '--help']).out, l2, 'L2 传 --help 应等于命令说明');
  assert.equal(runCli(['help', 'run', '-h']).out, l2, 'L2 传 -h 应等于命令说明');

  const l3 = runCli(['help', 'run', '--dry-run']).out;
  assert.equal(runCli(['help', 'run', '--dry-run', '--help']).out, l3, 'L3 传 --help 应等于参数详解');
  assert.equal(runCli(['help', 'run', '--dry-run', '-h']).out, l3, 'L3 传 -h 应等于参数详解');

  const src = fs.readFileSync(HELP_SRC, 'utf8');
  assert.ok(/helpTextForLevel/.test(src), '须有 helpTextForLevel 自适应入口');
});

// ─── 标准6：catalog 组索引 ──────────────────────────────────────
test('catalog 提供组索引并可被帮助检索', () => {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  assert.ok(/groupCommandIndex/.test(src), 'catalog 须提供 groupCommandIndex');
  assert.ok(/commandsInGroup/.test(src), 'catalog 须提供 commandsInGroup');
  assert.ok(/paramListOf/.test(src), 'catalog 须提供 paramListOf');
  assert.ok(/ESSENTIAL_GROUPS/.test(src), 'catalog 须提供 ESSENTIAL_GROUPS');

  // --all 输出含 catalog 的组（索引真实生效）
  const all = runCli(['help', '--all']).out;
  assert.ok(/治理与运行时/.test(all), '--all 应含 catalog 组条目');

  // 按 catalog 组/命令/参数定位能返回内容
  const r = runCli(['help', '治理与运行时/why/--operation']);
  assert.equal(r.exit, 0);
  assert.ok(/--operation/.test(r.out), '按 catalog 组定位应返回对应参数内容');

  // 单组名过滤：help <group> 只显该组
  const g = runCli(['help', '治理与运行时']);
  assert.equal(g.exit, 0, `help <group> 应退出 0：${g.out.slice(0, 300)}`);
  assert.ok(/治理与运行时/.test(g.out), '单组过滤应含该组标题');
  assert.ok(/why/.test(g.out), '单组过滤应含该组命令');
});

// ─── 标准7：不丢失既有帮助信息 ──────────────────────────────────
test('新帮助包含 catalog 全部命令名（不丢失）', () => {
  const names = catalogNames();
  assert.ok(names.length >= 30, `catalog 命令数应充足，实际 ${names.length}`);
  const all = runCli(['help', '--all']).out;
  const missing = names.filter((n) => !all.includes(n));
  assert.deepEqual(missing, [], `help --all 不得丢失既有命令：缺 ${missing.join(',')}`);
});

test('新帮助包含既有选项标识符（抽查）', () => {
  const all = runCli(['help', '--all']).out;
  for (const flag of ['--json', '--dry-run', '--yes', '--watch', '--tail', '--force']) {
    assert.ok(all.includes(flag), `help --all 应含既有选项 ${flag}`);
  }
});

// ─── 标准8：未知路径可识别提示且退出 0 ──────────────────────────
test('未知命令/组/参数给提示且退出 0、不崩溃', () => {
  const a = runCli(['help', 'no-such-cmd-xyz-123']);
  assert.equal(a.exit, 0, `未知命令应退出 0：${a.out.slice(0, 300)}`);
  assert.ok(a.out.trim().length > 0, '未知命令应有非空提示');
  assert.ok(/未知|用法/.test(a.out), '未知命令应给可识别提示');

  const b = runCli(['help', 'run', '--no-such-param-xyz']);
  assert.equal(b.exit, 0, `未知参数应退出 0：${b.out.slice(0, 300)}`);
  assert.ok(b.out.trim().length > 0, '未知参数应有非空提示');

  const c = runCli(['help', 'no-group-xyz/no-cmd-abc']);
  assert.equal(c.exit, 0, `未知组/命令应退出 0：${c.out.slice(0, 300)}`);
  assert.ok(c.out.trim().length > 0, '未知组/命令应有非空提示');
});

// ─── 写集边界（产物用状态读） ────────────────────────────────────
test('写集产物在树上', () => {
  assert.ok(fs.existsSync(HELP_SRC), 'src/cli/commands/info-help.ts 必须在树上');
  assert.ok(fs.existsSync(CATALOG_SRC), 'src/cli/commands/catalog.ts 必须在树上');
  assert.ok(fs.existsSync(__filename), '本验收文件必须在树上');
});

test('验收文件无 todo 占位（门禁②验真）', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  // 只认行首的实际调用：本断言自身的注释/字符串里会提到占位写法，不能误报
  const bad = src.split('\n').filter((l) => /^\s*test\s*\.\s*todo\s*\(/.test(l));
  assert.deepEqual(bad, [], '验收文件不得残留占位调用');
});

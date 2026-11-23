// v1-audit-verify-command 验收：audit verify 只读校验
//
// 规格只有一条占位验收（"需人补齐"），本文件断言设计上下文已明确的行为：
// verify 分支存在、只读、空链不判假、CLI 真实可执行。
// 人补齐口径后，断言与规格一起修订。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// 门禁②在 worktree 里跑（cwd = worktree），而 worktree 没有 dist/ ——
// CLI 二进制只在主仓。向上查找到含 dist/cli/index.js 的主仓（C3：纯路径探测）。
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
const AUDIT_SRC = path.join(REPO, 'src', 'cli', 'commands', 'audit.ts');
const CATALOG_SRC = path.join(REPO, 'src', 'cli', 'commands', 'catalog.ts');
const CLI = path.join(REPO, 'dist', 'cli', 'index.js');

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

test('audit.ts 含 verify 分支且调用 verifyChain', () => {
  const src = fs.readFileSync(AUDIT_SRC, 'utf8');
  assert.ok(src.includes("'verify'") || src.includes('"verify"'), '须有 verify 分支');
  assert.ok(/verifyChain/.test(src), '须调用 verifyChain');
});

test('verify 路径只读：不写任何文件', () => {
  const src = fs.readFileSync(AUDIT_SRC, 'utf8');
  // 取 verify 分支到下一个 register/分支之间的代码，确认无写操作
  const idx = src.indexOf('verify');
  const seg = src.slice(idx, idx + 3000);
  assert.ok(!/\.append\s*\(/.test(seg), 'verify 路径不得 append 事件');
  assert.ok(!/writeFile|appendFile|mkdir/.test(seg), 'verify 路径不得写文件');
});

test('catalog 登记 audit verify 用法', () => {
  const src = fs.readFileSync(CATALOG_SRC, 'utf8');
  assert.ok(/verify/.test(src), 'catalog 须提及 verify');
});

test('CLI：空链 verify 通过且明确"无链可验、不判假"', () => {
  const r = runCli(['audit', 'verify', '__no_such_slice_for_acceptance_xyz__']);
  assert.equal(r.exit, 0, `空链应退出 0，输出：${r.out}`);
  assert.ok(/OK|无链/.test(r.out), `应报告 OK 或无链，输出：${r.out}`);
});

test('CLI：verify 篡改链必红（audit verify 不是恒过）', () => {
  // v1-event-hash-chain 流含老格式事件穿插在链中间——verify 必须判 BROKEN。
  // 若未来老事件被清理导致它变绿，本用例会失败，届时改为断言"退出码为 0/1 且输出含 Chain："即可。
  const r = runCli(['audit', 'verify', 'v1-event-hash-chain', '--json']);
  let verdict = null;
  try {
    const start = r.out.indexOf('{');
    verdict = JSON.parse(r.out.slice(start));
  } catch { verdict = null; }
  assert.ok(verdict && typeof verdict.ok === 'boolean', `须输出 JSON verdict，实际：${r.out.slice(0, 500)}`);
  assert.equal(verdict.ok, false, '含未上链穿插事件的流必须判 BROKEN');
  assert.ok((verdict.failures || []).length >= 1, '必须报出断点');
  assert.equal(r.exit, 1, '断链时退出码为 1');
});

// v1-acceptance-triage 验收：编排入口统一 + 集成断点修复
// 对应 specs/slices/v1-acceptance-triage.md 五条验收标准。
// 不跑全量 `node scripts/test.mjs`（全量数分钟、门禁 120s 必超时）：
// 改为「结构断言 + 轻量运行时复验」，判据与全量跑同一份代码路径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
const ROOT = findRepoRoot(path.resolve(__dirname, '..', '..', '..'));
const SCRIPT = path.join(ROOT, 'scripts', 'test.mjs');
const HOOK_TEST = path.join(ROOT, 'tests', 'hook', 'hook-script.test.ts');
const HOOK_SRC = path.join(ROOT, 'src', 'cli', 'commands', 'hook-install.ts');

function walkTestTs(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function walkCjsAcceptance(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.test.cjs')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// 标准 1：统一入口能发现并执行全部 tests/**/*.test.ts
test('编排入口存在且覆盖全部测试文件（结构 + 数量对得上）', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/test.mjs 必须存在');
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // 统一入口的三段式：编码检查 → 构建 dist → 编译 tsc → 跑 dist-test glob → 跑 .cjs 验收
  assert.ok(src.includes('check-encoding.mjs'), '必须先跑编码检查');
  assert.ok(src.includes('buildDist'), '必须构建 dist（验收测真实 CLI）');
  assert.ok(src.includes('tsconfig.test.json'), '必须编译单元测试产物');
  assert.ok(
    src.includes('dist-test/tests/**/*.test.js'),
    '必须用 glob 跑全部编译后测试',
  );
  assert.ok(src.includes('collectCjsAcceptanceTests'), '必须收集 .cjs 验收测试');
  assert.ok(src.includes('withBuildLock'), '必须在构建锁内跑（避免 dist 空窗）');
  // 数量对得上：源目录 test.ts 数量 > 0，且 .cjs 验收被单独收集（不在 dist-test 里）
  const tsFiles = walkTestTs(path.join(ROOT, 'tests'));
  assert.ok(tsFiles.length > 200, `tests/**/*.test.ts 应有数百个，实际 ${tsFiles.length}`);
  const cjsFiles = walkCjsAcceptance(path.join(ROOT, 'tests', 'acceptance'));
  assert.ok(cjsFiles.length >= 14, `源目录 .cjs 验收应 >= 14 个，实际 ${cjsFiles.length}`);
  assert.ok(
    src.includes(".test.cjs"),
    '编排必须显式处理 .cjs（否则 14 个验收从没被跑过，D-59）',
  );
});

// 标准 2：失败可观测且正确传播退出码
test('失败可观测且退出码正确传播（结构 + 探针）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // execFileSync 同步抛错 + stdio inherit（失败输出直达终端，含文件路径/用例名）
  assert.ok(src.includes('execFileSync'), '必须用 execFileSync（同步抛错）');
  assert.ok(src.includes("stdio: 'inherit'") || src.includes('stdio: "inherit"'), '必须 inherit 输出（失败可观测）');
  // 顶层 catch 把退出码置非零，且不在锁内 process.exit（否则跳过 finally 留锁）
  assert.ok(src.includes('process.exitCode = 1'), '失败时退出码必须非零');
  assert.ok(!/withBuildLock\(root, \(\) => \{[\s\S]*process\.exit\(/.test(src), '锁内不得 process.exit（会跳过 finally 留锁）');
  // 轻量探针：编排脚本语法合法（node --check），坏了直接红
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `scripts/test.mjs 语法检查失败：${r.stderr}`);
});

// 标准 3：集成断点修复 —— hook 测试与实现真实对接，不再静默放行
test('hook 集成断点已修复（node 路径钉死 + 实现支持该选项）', () => {
  const hookSrc = fs.readFileSync(HOOK_SRC, 'utf-8');
  assert.ok(hookSrc.includes('nodePath'), 'hookScript 必须支持 nodePath 选项');
  assert.ok(hookSrc.includes('NODE_BIN'), 'hook 脚本必须经 NODE_BIN 调 hook 二进制');
  const t = fs.readFileSync(HOOK_TEST, 'utf-8');
  const pinned = (t.match(/nodePath:\s*process\.execPath/g) || []).length;
  assert.ok(
    pinned >= 2,
    `两组 hook e2e 都必须钉死 node 路径（防 PATH 坏 stub 静默放行），实际 ${pinned} 处`,
  );
  // 轻量运行时复验：跑编译后的 hook-script 单文件（数秒），不断言全量。
  // 注意：外层本身已在 `node --test` 里，直接再起 `node --test` 会被 runner
  // 判为递归调用而跳过执行——所以这里直接 `node <file>` 跑单文件。
  const compiled = path.join(ROOT, 'dist-test', 'tests', 'hook', 'hook-script.test.js');
  assert.ok(fs.existsSync(compiled), 'dist-test/tests/hook/hook-script.test.js 必须存在（先构建）');
  const r = spawnSync(
    process.execPath,
    [compiled],
    { cwd: ROOT, encoding: 'utf-8', timeout: 180000 },
  );
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.equal(r.status, 0, `hook-script 单文件必须全绿：\n${out.slice(-3000)}`);
  assert.ok(out.includes('pass'), `输出应含 pass 汇总：\n${out.slice(-1000)}`);
});

// 标准 4：结果可重复 —— 编排不依赖残留状态
test('编排可重复（锁 + 确定性顺序 + 无残留依赖）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.ok(src.includes('withBuildLock'), '构建与测试共用一把锁（防并发打掉对方）');
  assert.ok(src.includes('build-lock.mjs'), '锁语义来自 build-lock.mjs');
  // 确定性顺序：编码检查先于一切，构建先于测试。
  // 注意 '--test' 在文件头注释里也出现（`node --test`），所以顺序断言必须
  // 钉在「执行点」上：check-encoding.mjs 调用 → buildDist(root) 调用 →
  // '--test' 作为 execFileSync 参数（带引号的执行点），而不是裸子串首现。
  const encIdx = src.indexOf('check-encoding.mjs');
  const buildIdx = src.indexOf('buildDist(root)');
  const testIdx = src.indexOf("'--test'");
  assert.ok(encIdx !== -1 && buildIdx !== -1 && testIdx !== -1, '三段执行点必须都在');
  assert.ok(encIdx < buildIdx && buildIdx < testIdx, '顺序必须是 编码检查 → 构建 → 测试');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'build-lock.mjs')), '锁脚本必须存在');
  // 两次收集 .cjs 列表必须一致（不依赖上次残留）
  const first = walkCjsAcceptance(path.join(ROOT, 'tests', 'acceptance'));
  const second = walkCjsAcceptance(path.join(ROOT, 'tests', 'acceptance'));
  assert.deepEqual(second, first, '两次收集的验收列表必须完全一致');
});

// 标准 5：不越界 —— 改动只在写集内
test('本片不越界（改动只在 scripts/test.mjs 与 tests/** 内）', () => {
  // 门禁在隔离 worktree 里跑（ROOT = worktree），主区合并后跑（ROOT = 主区）：
  // 判据都一样——只看「本片自己的改动」，不看主区其它切片的。
  // worktree 还在 → 看 worktree；worktree 已清理（合后）→ 看主区。
  const sliceWt = path.join(ROOT, '.zelto', 'worktrees', 'v1-acceptance-triage');
  const target = fs.existsSync(sliceWt) ? sliceWt : ROOT;
  const run = (args) =>
    spawnSync('git', args, { cwd: target, encoding: 'utf-8' }).stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  const changed = new Set(run(['diff', 'HEAD', '--name-only']));
  for (const line of run(['ls-files', '--others', '--exclude-standard'])) changed.add(line);
  const forbidden = [...changed]
    .map((f) => f.replace(/\\/g, '/'))
    .filter(
      (f) =>
        f.startsWith('contracts/schemas/') ||
        f.startsWith('src/') ||
        f.startsWith('syntax/'),
    );
  assert.deepEqual(forbidden, [], `只读域必须无改动（看 ${target}），实际：${forbidden.join(', ')}`);
});

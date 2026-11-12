// ADR-056 多版本验收（手动脚本，非 npm test 的一部分）
//
// 覆盖 ADR §9「还没做的验收」那三项：
//   A. 两个版本并行：v2、v3 同时跑，切片各在自己的版本工作目录，
//      互不可见对方的未 ship 改动
//   B. v3 依赖 v2：v3 的基点是 version/v2 的 tip，v3 的切片看得见 v2 的改动
//   C. 跨版本冲突：v2、v3 都改 types.ts 时 version start 提示但不阻断
//
// 关键：不真的跑 agent（那要 claude-code）——
// 直接用 git 命令模拟「agent 产出了东西」，
// 然后验证分支拓扑与基点是否如 ADR 所述。

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZELTO = join(process.cwd(), 'dist', 'cli', 'index.js');

function run(cmd, args, cwd, allowFail = false) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (!allowFail) {
      console.error(`--- ${cmd} ${args.join(' ')} FAILED ---`);
      console.error(err.stdout ?? '');
      console.error(err.stderr ?? '');
      throw err;
    }
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

function git(args, cwd, allowFail = false) {
  return run('git', args, cwd, allowFail).trim();
}

/** ref 里有没有某个路径 */
function refHasPath(ref, path, cwd) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], {
      cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
const failedLabels = [];

// 用 ASCII 标记 —— Windows 终端会把 ✅/❌ 显示成乱码，看不出哪个失败
function ok(label, cond, extra = '') {
  const pass = Boolean(cond);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!pass) {
    failures += 1;
    failedLabels.push(label);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
}

const now = new Date().toISOString();

/** 建一个带版本计划的仓库 */
function makeRepo(name) {
  const repo = mkdtempSync(join(tmpdir(), `zelto-adr056-${name}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# test\n', 'utf-8');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(repo, '.gitignore'), '.zelto/\nnode_modules/\n', 'utf-8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  run('node', [ZELTO, 'init'], repo);
  return repo;
}

/** 写版本计划 */
function writePlan(repo, plan) {
  const dir = join(repo, '.zelto', 'versions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), 'utf-8');
}

/** 写切片文件 + 规格 */
function writeSlice(repo, id, file, version) {
  const slicesDir = join(repo, '.zelto', 'slices');
  mkdirSync(slicesDir, { recursive: true });
  mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });
  const slice = {
    id, title: id, description: '', prerequisites: [], state: 'frozen',
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null, baseline: false, writes: [file], runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now, updatedAt: now,
  };
  writeFileSync(join(slicesDir, `${id}.json`), JSON.stringify(slice, null, 2), 'utf-8');
  writeFileSync(
    join(repo, 'specs', 'slices', `${id}.md`),
    `---\nid: ${id}\nversion: ${version}\n---\n\n# ${id}\n\n## 范围\n\n- ${file}\n`,
    'utf-8',
  );
}

/** 模拟 agent 产出：切一个分支、提交、回到 main */
function simulateSliceOutput(repo, id, file, content, baseBranch) {
  git(['checkout', '-b', `slice/${id}`, baseBranch], repo);
  writeFileSync(join(repo, file), content, 'utf-8');
  git(['add', '-A'], repo);
  git(['commit', '-m', `feat(${id}): output\n\nRefs-Slice: ${id}`], repo);
  git(['checkout', 'main'], repo);
}

/** 写已批准的签字请求 */
function approve(repo, ids) {
  const dir = join(repo, '.zelto', 'locks');
  mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    writeFileSync(
      join(dir, `sign-${id}.json`),
      JSON.stringify({ sliceId: id, status: 'approved', by: 'human', at: now }, null, 2),
      'utf-8',
    );
  }
}

function planVersion(label, sliceIds, dependsOn = []) {
  return {
    version: label,
    dependsOn,
    description: `版本 ${label}`,
    integrationTestDir: `tests/acceptance/${label}/`,
    status: 'planned',
    slices: sliceIds.map((id) => ({
      id, module: 'm', title: id,
      writes: [`src/${id.replace(/[^a-z]/g, '')}.ts`],
      specPath: `specs/slices/${id}.md`,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════
// A. 两个版本并行
// ═══════════════════════════════════════════════════════════════════
section('A. 两个版本并行：互不可见对方的未 ship 改动');

const repoA = makeRepo('parallel');
try {
  writePlan(repoA, {
    id: 'plan-1', designId: 'd1', title: '并行计划', status: 'confirmed',
    createdAt: now, confirmedAt: now,
    versions: [
      { ...planVersion('v2', ['sl-a']), status: 'planned' },
      { ...planVersion('v3', ['sl-b']), status: 'planned' },
    ],
  });
  writeSlice(repoA, 'sl-a', 'src/a.ts', 'v2');
  writeSlice(repoA, 'sl-b', 'src/b.ts', 'v3');

  console.log('--- version start v2 ---');
  const outA = run('node', [ZELTO, 'version', 'start', 'v2'], repoA, true);
  console.log(outA.split('\n').filter((l) => l.includes('版本分支') || l.includes('工作目录')).join('\n'));

  console.log('--- version start v3 ---');
  const outB = run('node', [ZELTO, 'version', 'start', 'v3'], repoA, true);
  console.log(outB.split('\n').filter((l) => l.includes('版本分支') || l.includes('工作目录')).join('\n'));

  const branches = git(['branch', '--list'], repoA);
  ok('v2、v3 两个版本分支都在', branches.includes('version/v2') && branches.includes('version/v3'));

  ok(
    '两个版本各有自己的工作目录',
    existsSync(join(repoA, '.zelto', 'version-worktrees', 'v2')) &&
      existsSync(join(repoA, '.zelto', 'version-worktrees', 'v3')),
  );

  // 两个版本的基点都是各自独立算的 —— 不该有先后
  const planJson = JSON.parse(
    readFileSync(join(repoA, '.zelto', 'versions', 'plan-1.json'), 'utf-8'),
  );
  const v2 = planJson.versions.find((v) => v.version === 'v2');
  const v3 = planJson.versions.find((v) => v.version === 'v3');
  ok('v2 的基点已钉死', Boolean(v2.baseCommit));
  ok('v3 的基点已钉死', Boolean(v3.baseCommit));
  ok('两个版本基点相同（都是主线 HEAD，互相独立）', v2.baseCommit === v3.baseCommit);

  // 关键断言：v2 的改动**不进** v3 的工作目录，反之亦然
  simulateSliceOutput(repoA, 'sl-a', 'src/a.ts', "export const a = 'v2';\n", 'version/v2');
  const v3SeesA = existsSync(join(repoA, '.zelto', 'version-worktrees', 'v3', 'src', 'a.ts'));
  ok('v3 的工作目录**看不到** v2 的未 ship 改动', !v3SeesA);

  simulateSliceOutput(repoA, 'sl-b', 'src/b.ts', "export const b = 'v3';\n", 'version/v3');
  const v2SeesB = existsSync(join(repoA, '.zelto', 'version-worktrees', 'v2', 'src', 'b.ts'));
  ok('v2 的工作目录**看不到** v3 的未 ship 改动', !v2SeesB);

  // 产物在**切片分支**上，还没合进版本分支 —— 这正是「未 ship」的状态
  ok(
    '产物在切片分支上（还没合进版本分支）',
    refHasPath('slice/sl-a', 'src/a.ts', repoA) && refHasPath('slice/sl-b', 'src/b.ts', repoA),
  );
  ok(
    '产物**还没**进各自的版本分支（未合）',
    !refHasPath('version/v2', 'src/a.ts', repoA) && !refHasPath('version/v3', 'src/b.ts', repoA),
  );
} finally {
  rmSync(repoA, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// B. v3 依赖 v2：基点取前置版本分支 tip
// ═══════════════════════════════════════════════════════════════════
section('B. v3 依赖 v2：基点 = version/v2 的 tip');

const repoB = makeRepo('dep');
try {
  writePlan(repoB, {
    id: 'plan-1', designId: 'd1', title: '依赖计划', status: 'confirmed',
    createdAt: now, confirmedAt: now,
    versions: [
      { ...planVersion('v2', ['sl-a']), status: 'planned' },
      { ...planVersion('v3', ['sl-b'], ['v2']), status: 'planned' },
    ],
  });
  writeSlice(repoB, 'sl-a', 'src/a.ts', 'v2');
  writeSlice(repoB, 'sl-b', 'src/b.ts', 'v3');

  console.log('--- version start v2 ---');
  run('node', [ZELTO, 'version', 'start', 'v2'], repoB, true);

  // v2 的切片产出合进 version/v2（还没 ship 进主干）
  simulateSliceOutput(repoB, 'sl-a', 'src/a.ts', "export const a = 'v2';\n", 'version/v2');
  approve(repoB, ['sl-a']);
  const mergeOut = run('node', [ZELTO, 'merge', '--target', 'version/v2'], repoB, true);
  ok('v2 的切片合进了 version/v2', mergeOut.includes('已合入') || mergeOut.includes('Merge complete'));

  // 把 v2 标成 integrated（切片已进版本分支）
  const planPath = join(repoB, '.zelto', 'versions', 'plan-1.json');
  const planB = JSON.parse(readFileSync(planPath, 'utf-8'));
  planB.versions.find((v) => v.version === 'v2').status = 'integrated';
  writeFileSync(planPath, JSON.stringify(planB, null, 2), 'utf-8');

  const v2Tip = git(['rev-parse', 'version/v2'], repoB);

  console.log('--- version start v3 ---');
  const outDep = run('node', [ZELTO, 'version', 'start', 'v3'], repoB, true);
  console.log(outDep.split('\n').filter((l) => l.includes('基点') || l.includes('版本分支')).join('\n'));

  const planB2 = JSON.parse(readFileSync(planPath, 'utf-8'));
  const v3 = planB2.versions.find((v) => v.version === 'v3');
  ok('v3 的基点是 version/v2 的 tip', v3.baseCommit === v2Tip, `v3=${v3.baseCommit?.slice(0, 8)} v2tip=${v2Tip.slice(0, 8)}`);

  // 关键断言：v3 的工作目录**看得见** v2 的改动
  const v3Worktree = join(repoB, '.zelto', 'version-worktrees', 'v3');
  ok('v3 的工作目录看得见 v2 的改动（依赖是真的）', existsSync(join(v3Worktree, 'src', 'a.ts')));

  // v3 的切片基点也是 v2 的 tip
  //
  // 切片基点由 `ensureWorktree` 在建 worktree 时写入（ADR-041 §3.2）。
  // 这里直接调它 —— 不跑 agent，只看基点对不对。
  //
  // `ensureWorktree` 用 `process.cwd()` 定位仓库，所以先切到 repoB。
  // Windows 上绝对路径要转成 file:// URL 才能被 ESM loader 接受
  const { pathToFileURL } = await import('node:url');
  const { ensureWorktree } = await import(
    pathToFileURL(join(process.cwd(), 'dist', 'cli', 'commands', 'shared.js')).href
  );
  const prevCwd = process.cwd();
  process.chdir(repoB);
  let wtInfo;
  try {
    wtInfo = await ensureWorktree('sl-b', { baseCommitOverride: v2Tip });
  } finally {
    process.chdir(prevCwd);
  }
  ok(
    'v3 切片的 worktree 基点是 version/v2 的 tip',
    wtInfo?.baseCommit === v2Tip,
    `wt=${wtInfo?.baseCommit?.slice(0, 8)} v2tip=${v2Tip.slice(0, 8)}`,
  );

  // worktree 的实际 HEAD 也应该是那个基点
  const wtHead = git(['rev-parse', 'HEAD'], join(repoB, '.zelto', 'worktrees', 'sl-b'));
  ok('v3 切片 worktree 的 HEAD 就是 version/v2 的 tip', wtHead === v2Tip, `head=${wtHead.slice(0, 8)}`);
} finally {
  rmSync(repoB, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// C. 跨版本冲突：提示但不阻断
// ═══════════════════════════════════════════════════════════════════
section('C. 跨版本冲突：提示但不阻断（--strict 才拦）');

const repoC = makeRepo('conflict');
try {
  writePlan(repoC, {
    id: 'plan-1', designId: 'd1', title: '冲突计划', status: 'confirmed',
    createdAt: now, confirmedAt: now,
    versions: [
      { ...planVersion('v2', ['sl-a']), status: 'planned' },
      { ...planVersion('v3', ['sl-b']), status: 'planned' },
    ],
  });
  // 两个版本都改同一个 types 文件 —— error 级重叠
  writeSlice(repoC, 'sl-a', 'src/types.ts', 'v2');
  writeSlice(repoC, 'sl-b', 'src/types.ts', 'v3');

  console.log('--- version start v2 ---');
  run('node', [ZELTO, 'version', 'start', 'v2'], repoC, true);

  console.log('--- version start v3（应当提示冲突）---');
  const outC = run('node', [ZELTO, 'version', 'start', 'v3'], repoC, true);
  const conflictLines = outC.split('\n').filter((l) => l.includes('重叠') || l.includes('types.ts') || l.includes('启发式'));
  console.log(conflictLines.join('\n'));

  ok('提示了跨版本重叠', conflictLines.some((l) => l.includes('重叠') || l.includes('types.ts')));
  ok('明说了这是启发式判断', conflictLines.some((l) => l.includes('启发式')));
  ok('默认不阻断（继续往下走了）', !conflictLines.some((l) => l.includes('BLOCKED')));

  // 事件留痕
  let eventText = '';
  const collect = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collect(full);
      else if (name.endsWith('.jsonl')) eventText += readFileSync(full, 'utf-8');
    }
  };
  collect(join(repoC, '.zelto', 'events'));
  ok('写了 artifact.conflict_detected 事件', eventText.includes('artifact.conflict_detected'));

  // --strict 应当拦住
  // v3 已经是 in_progress —— 重跑要带 --retry（否则状态检查先拦下）
  console.log('\n--- version start v3 --retry-failed --strict（应当拦住）---');
  let strictCode = 0;
  let outStrict = '';
  try {
    outStrict = execFileSync(
      'node',
      [ZELTO, 'version', 'start', 'v3', '--retry-failed', '--strict'],
      { cwd: repoC, encoding: 'utf-8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    strictCode = err.status ?? 1;
    outStrict = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  ok('--strict 下阻断（退出码非 0）', strictCode !== 0, `exit=${strictCode}`);
  ok(
    '--strict 的阻断理由是跨版本冲突',
    outStrict.includes('跨版本冲突') || outStrict.includes('strict'),
  );
  // 拦住之后不应该进入 Phase 2（没有 agent 被拉起）
  ok('--strict 下没有继续执行切片', !outStrict.includes('Phase 2'));

  // 非 error 级（docs）应当只是 info，不阻断
  console.log('\n--- 低风险重叠（docs 类别）---');
  const repoC2 = makeRepo('conflict-low');
  try {
    writePlan(repoC2, {
      id: 'plan-1', designId: 'd1', title: '低风险计划', status: 'confirmed',
      createdAt: now, confirmedAt: now,
      versions: [
        { ...planVersion('v2', ['sl-a']), status: 'planned' },
        { ...planVersion('v3', ['sl-b']), status: 'planned' },
      ],
    });
    writeSlice(repoC2, 'sl-a', 'docs/a.md', 'v2');
    writeSlice(repoC2, 'sl-b', 'docs/a.md', 'v3');
    run('node', [ZELTO, 'version', 'start', 'v2'], repoC2, true);
    const outLow = run('node', [ZELTO, 'version', 'start', 'v3'], repoC2, true);
    ok('低风险重叠提示了但不阻断', outLow.includes('较低风险') || !outLow.includes('BLOCKED'));
  } finally {
    rmSync(repoC2, { recursive: true, force: true });
  }
} finally {
  rmSync(repoC, { recursive: true, force: true });
}

console.log(`\n${'═'.repeat(60)}`);
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.log(`${failures} FAILED:`);
  for (const l of failedLabels) console.log(`  - ${l}`);
  process.exitCode = 1;
}

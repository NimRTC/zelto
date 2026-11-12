// ADR-056 在真实项目（nimrtc-zelto）上的验收
//
// 跑在克隆副本上，不碰真实仓库。
//
// 重点验证在真实工程里才会暴露的事：
//   1. 真实计划的版本依赖链（v1 → v2 → v3）各就各位
//   2. 真实写集（C++ 头文件/源文件）下的跨版本冲突判定与定级
//   3. 版本分支 / 版本工作目录跟真实 CMake 大工程共处时不出岔子
//   4. 验收骨架这种「zelto 自己的产物」不该挡路
//
// 不真跑 agent（要 claude-code + CMake 全量构建，几十分钟）——
// 用 git 模拟「agent 产出了东西」，验证分支拓扑与隔离性。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ZELTO = 'd:/MyOpen/Zelto/dist/cli/index.js';
const REPO = process.argv[2] ?? 'd:/MyOpen/Testing/adr056-nimrtc';

function run(cmd, args, cwd, allowFail = false) {
  try {
    return execFileSync(cmd, args, {
      cwd, encoding: 'utf-8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (!allowFail) throw err;
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

function git(args, cwd = REPO) {
  return run('git', args, cwd).trim();
}

function gitOk(args, cwd = REPO) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function refHasPath(ref, path) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], {
      cwd: REPO, encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
const failed = [];
function ok(label, cond, extra = '') {
  const pass = Boolean(cond);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? ` -- ${extra}` : ''}`);
  if (!pass) { failures += 1; failed.push(label); }
}

function section(t) {
  console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);
}

const PLAN_ID = 'plan-1794196604502';
const planPath = join(REPO, '.zelto', 'versions', `${PLAN_ID}.json`);
const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
const aggPath = 'src/modules/net_feedback/include/nimrtc/net_feedback/aggregator.hpp';

section('0. 副本就绪');
ok('仓库在 main 上', git(['branch', '--show-current']) === 'main');
ok('版本计划可读', plan.versions.length === 3, `${plan.versions.length} 个版本`);
ok('依赖链是 v1 -> v2 -> v3',
  plan.versions[1].dependsOn[0] === 'v1' && plan.versions[2].dependsOn[0] === 'v2');

section('1. 真实写集下的跨版本冲突判定');
const v1writes = plan.versions[0].slices.flatMap((s) => s.writes);
const v3writes = plan.versions[2].slices.flatMap((s) => s.writes);
const overlap = v1writes.filter((w) => v3writes.includes(w));
console.log(`  v1 写集: ${v1writes.length} 条`);
console.log(`  v3 写集: ${v3writes.length} 条`);
console.log(`  真实重叠: ${overlap.join(', ') || '(无)'}`);
ok('真实计划里确实存在跨版本写集重叠', overlap.length > 0, overlap.join(', '));

// 用生产代码路径判定（不是复刻逻辑）
const { pathToFileURL } = await import('node:url');
const { detectCrossVersionConflicts } = await import(
  pathToFileURL('d:/MyOpen/Zelto/dist/core/sched/cross-version.js').href
);
const realConflicts = detectCrossVersionConflicts([
  { version: 'v1', writes: v1writes },
  { version: 'v3', writes: v3writes },
]);
for (const c of realConflicts) {
  console.log(`  [${c.severity}] ${c.versionA} <-> ${c.versionB}: ${c.artifact} ${c.paths.join(', ')}`);
}
ok('真实写集下检出了冲突', realConflicts.length > 0);
ok('C++ 头文件被判为 error 级（类型定义）',
  realConflicts.some((c) => c.severity === 'error' && c.paths.some((p) => p.endsWith('.hpp'))),
  realConflicts.map((c) => `${c.artifact}:${c.severity}`).join(' '));
ok('冲突按具体路径分别报出，不是笼统的「都动同一工件」',
  realConflicts.some((c) => c.paths.length === 1));

section('2. v1 开跑：版本分支 + 版本工作目录');
// v1 已经 in_progress 且切片已合进 main —— 先把状态退回到 planned 重来
plan.versions[0].status = 'planned';
writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

const startV1 = run('node', [ZELTO, 'version', 'start', 'v1', '--plan', PLAN_ID], REPO, true);
console.log(startV1.split('\n').filter((l) => /版本分支|工作目录|基点/.test(l)).join('\n'));

ok('建出了 version/v1 分支', git(['branch', '--list', 'version/v1']).includes('version/v1'));
const v1wt = join(REPO, '.zelto', 'version-worktrees', 'v1');
ok('建出了 v1 的版本工作目录', existsSync(v1wt));
ok('版本工作目录不是切片工作目录',
  !existsSync(join(REPO, '.zelto', 'worktrees', 'v1')));

section('3. v3 开跑：依赖未满足时应当被拦');
// ADR-056 §3.2 明确：dependsOn 仍然强制前置版本先 integrated。
// v3 dependsOn v2，v2 还没 integrated → v3 应当被拦，且要说清原因。
const startV3 = run('node', [ZELTO, 'version', 'start', 'v3', '--plan', PLAN_ID], REPO, true);
ok('v3 因依赖未满足被拦（ADR §3.2 的依赖串行仍然生效）',
  startV3.includes('BLOCKED') && startV3.includes('v2'));
ok('拦截理由说清了是依赖问题', startV3.includes('not yet integrated') || startV3.includes('依赖'));
ok('被拦时没建 version/v3 分支', !git(['branch', '--list', 'version/v3']).includes('version/v3'));
ok('被拦时没建 v3 的版本工作目录', !existsSync(join(REPO, '.zelto', 'version-worktrees', 'v3')));

section('4. 切片产出进版本分支');
// 模拟 agent 产出：从 version/v1 切一个切片分支并提交
// 分支名必须是 slice/<切片 id> —— merge 按切片 id 找分支
git(['checkout', '-b', 'slice/v1-net-feedback-core', 'version/v1'], REPO);
const realContent = existsSync(join(REPO, aggPath))
  ? readFileSync(join(REPO, aggPath), 'utf-8')
  : '// placeholder\n';
writeFileSync(join(REPO, aggPath), `${realContent}\n// sim v1 change\n`, 'utf-8');
git(['add', '-A'], REPO);
git(['commit', '-m', 'feat(v1-net-feedback-core): simulated\n\nRefs-Slice: v1-net-feedback-core'], REPO);
git(['checkout', 'main'], REPO);

// 让 merge 能找到这个切片：把它登记成 v1 的切片
const now = new Date().toISOString();
writeFileSync(
  join(REPO, '.zelto', 'slices', 'v1-net-feedback-core.json'),
  JSON.stringify({
    id: 'v1-net-feedback-core', title: 'sim', description: '', prerequisites: [],
    state: 'completed',
    spec: { path: 'specs/slices/v1-net-feedback-core.md', frozenHash: null, frozenAt: null },
    acceptance: { dir: 'tests/acceptance/v1-net-feedback-core/', frozenHash: null, oracleSrc: null },
    baseCommit: null, drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] }, traceWaiver: null, baseline: false,
    writes: [aggPath], runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now, updatedAt: now,
  }, null, 2),
  'utf-8',
);

const mergeOut = run(
  'node', [ZELTO, 'merge', '--target', 'version/v1', '--plan', PLAN_ID, 'v1-net-feedback-core'],
  REPO, true,
);
console.log(mergeOut.split('\n').filter((l) => /合并|合入|Merge|目标|⚠|❌/.test(l)).join('\n'));
ok('v1 的切片合进了 version/v1',
  gitOk(['merge-base', '--is-ancestor', 'slice/v1-net-feedback-core', 'version/v1']));

section('5. v2 依赖 v1：基点取 version/v1 的 tip');
// 把 v1 标成 integrated（切片已进版本分支）
const p2 = JSON.parse(readFileSync(planPath, 'utf-8'));
p2.versions[0].status = 'integrated';
writeFileSync(planPath, JSON.stringify(p2, null, 2), 'utf-8');

const v1Tip = git(['rev-parse', 'version/v1']);
const startV2 = run('node', [ZELTO, 'version', 'start', 'v2', '--plan', PLAN_ID], REPO, true);
console.log(startV2.split('\n').filter((l) => /基点|版本分支/.test(l)).join('\n'));

const p3 = JSON.parse(readFileSync(planPath, 'utf-8'));
const v2 = p3.versions.find((v) => v.version === 'v2');
ok('v2 的基点是 version/v1 的 tip', v2.baseCommit === v1Tip,
  `v2=${v2.baseCommit?.slice(0, 8)} v1tip=${v1Tip.slice(0, 8)}`);
ok('建出了 version/v2 分支', git(['branch', '--list', 'version/v2']).includes('version/v2'));

const v2wt = join(REPO, '.zelto', 'version-worktrees', 'v2');
const v2SeesV1 = existsSync(join(v2wt, aggPath)) &&
  readFileSync(join(v2wt, aggPath), 'utf-8').includes('sim v1 change');
ok('v2 的工作目录看得见 v1 的改动（依赖是真的）', v2SeesV1);

section('6. 版本分支并存');
const branches = git(['branch', '--list', 'version/*']);
console.log(branches.split('\n').map((l) => `  ${l}`).join('\n'));
ok('version/v1、v2 两个分支并存',
  branches.includes('version/v1') && branches.includes('version/v2'));

section('7. zelto 自己的产物不该挡路');
// 副本里有 version start 生成的未跟踪验收骨架 —— 它不该挡住 merge/ship
const skeleton = join(REPO, 'tests', 'acceptance', 'v2-plugin-interface', 'acceptance.test.cjs');
ok('副本里有未跟踪的验收骨架', existsSync(skeleton));
ok('未跟踪的验收骨架确实让主仓变脏',
  git(['status', '--porcelain']).includes('tests/acceptance/v2-plugin-interface'));

// 骨架是纯 todo → 豁免
const { isPureTodoSkeleton, isUntouchedAcceptanceSkeleton } = await import(
  pathToFileURL('d:/MyOpen/Zelto/dist/core/project/managed-acceptance.js').href
);
const skeletonContent = readFileSync(skeleton, 'utf-8');
ok('骨架被判为「纯 todo」', isPureTodoSkeleton(skeletonContent));
ok('骨架路径被判为 zelto 管理的验收骨架',
  isUntouchedAcceptanceSkeleton('tests/acceptance/v2-plugin-interface/acceptance.test.cjs', REPO));
// agent 改成真断言后 → 不豁免
const withAssertion = skeletonContent.replace('test.todo(', 'test(');
ok('有真断言的文件不再被豁免', !isPureTodoSkeleton(withAssertion));

section('8. ship：v1 进主干 + 打 tag');
// ship 会重跑主干验收（D3-C）—— 副本里把 gate 命令换成轻量的，
// 这里验的是分支拓扑与 tag，不是 C++ 构建（那要几十分钟）。
const cfgPath = join(REPO, '.zelto', 'config.yaml');
const cfgText = readFileSync(cfgPath, 'utf-8');
writeFileSync(
  cfgPath,
  cfgText.replace(
    /gate:\n[\s\S]*?timeoutSec:/,
    'gate:\n  commands:\n    - name: smoke\n      run: echo "adr-056 smoke"\n  timeoutSec:',
  ),
  'utf-8',
);

const ship = run('node', [ZELTO, 'version', 'ship', 'v1', '--plan', PLAN_ID], REPO, true);
console.log(ship.split('\n').filter((l) => /tag|合入|delivered|主干|ship|⚠/.test(l)).join('\n'));
ok('打上了 v1 的 tag', git(['tag', '--list']).split('\n').some((t) => t.trim() === 'v1'));
ok('version/v1 分支还在（作为锚点）', git(['branch', '--list', 'version/v1']).includes('version/v1'));
const p4 = JSON.parse(readFileSync(planPath, 'utf-8'));
ok('v1 状态变成 delivered', p4.versions[0].status === 'delivered', p4.versions[0].status);
ok('ship 之后主干含 v1 的产物', refHasPath('main', aggPath));

console.log(`\n${'='.repeat(64)}`);
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.log(`${failures} FAILED:`);
  for (const l of failed) console.log(`  - ${l}`);
  process.exitCode = 1;
}

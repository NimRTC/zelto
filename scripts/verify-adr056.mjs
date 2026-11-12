// ADR-056 端到端验证（手动脚本，非 npm test 的一部分）
//
// 场景：
//   1. 建仓库 + zelto init
//   2. 建版本计划（v2 含两个切片）
//   3. zelto version start v2 —— 建版本分支与版本工作目录
//   4. 切片产物合入**版本分支**（不是主干）
//   5. zelto version ship v2 —— 版本分支合入主干 + 打 tag
//
// 验证点：
//   - 版本分支建出来了
//   - 切片合进了 version/v2，主干**没有**被动
//   - ship 之后主干拿到了切片的改动
//   - tag 打上了

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZELTO = join(process.cwd(), 'dist', 'cli', 'index.js');

function run(cmd, args, cwd, allowFail = false) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
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

function git(args, cwd) {
  return run('git', args, cwd).trim();
}

function ok(label, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const repo = mkdtempSync(join(tmpdir(), 'zelto-adr056-e2e-'));
console.log(`仓库：${repo}\n`);

try {
  // ── 1. 基础仓库 ──
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# test\n', 'utf-8');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(repo, '.gitignore'), '.zelto/\nnode_modules/\n', 'utf-8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);

  // ── 2. zelto init ──
  run('node', [ZELTO, 'init'], repo);

  // ── 3. 版本计划 ──
  const versionsDir = join(repo, '.zelto', 'versions');
  mkdirSync(versionsDir, { recursive: true });
  const now = new Date().toISOString();
  const plan = {
    id: 'plan-1',
    designId: 'd1',
    title: '测试计划',
    status: 'confirmed',
    createdAt: now,
    confirmedAt: now,
    versions: [
      {
        version: 'v2',
        dependsOn: [],
        description: '版本二',
        integrationTestDir: 'tests/acceptance/v2/',
        status: 'planned',
        slices: [
          { id: 'sl-a', module: 'm', title: 'A', writes: ['src/a.ts'], specPath: 'specs/slices/sl-a.md' },
          { id: 'sl-b', module: 'm', title: 'B', writes: ['src/b.ts'], specPath: 'specs/slices/sl-b.md' },
        ],
      },
    ],
  };
  writeFileSync(join(versionsDir, 'plan-1.json'), JSON.stringify(plan, null, 2), 'utf-8');

  // ── 4. 建切片文件与规格 ──
  const slicesDir = join(repo, '.zelto', 'slices');
  mkdirSync(slicesDir, { recursive: true });
  mkdirSync(join(repo, 'specs', 'slices'), { recursive: true });

  for (const [id, file] of [['sl-a', 'src/a.ts'], ['sl-b', 'src/b.ts']]) {
    const slice = {
      id,
      title: id,
      description: '',
      prerequisites: [],
      state: 'frozen',
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${id}`, frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null,
      baseline: false,
      writes: [file],
      runs: [],
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: now,
      updatedAt: now,
    };
    writeFileSync(join(slicesDir, `${id}.json`), JSON.stringify(slice, null, 2), 'utf-8');
    writeFileSync(
      join(repo, 'specs', 'slices', `${id}.md`),
      `---\nid: ${id}\nversion: v2\n---\n\n# ${id}\n\n## 范围\n\n- ${file}\n`,
      'utf-8',
    );
  }

  // ── 5. version start：建版本分支与版本工作目录 ──
  console.log('--- zelto version start v2 ---');
  const startOut = run('node', [ZELTO, 'version', 'start', 'v2'], repo, true);
  console.log(startOut.split('\n').slice(0, 25).join('\n'));

  const branches = git(['branch', '--list'], repo);
  ok('版本分支 version/v2 建出来了', branches.includes('version/v2'), branches.trim());
  ok(
    '版本工作目录建出来了',
    existsSync(join(repo, '.zelto', 'version-worktrees', 'v2')),
    join('.zelto', 'version-worktrees', 'v2'),
  );

  // ── 6. 切片产物：在切片分支上提交 ──
  const versionTip = git(['rev-parse', 'version/v2'], repo);
  for (const [id, file] of [['sl-a', 'src/a.ts'], ['sl-b', 'src/b.ts']]) {
    git(['checkout', '-b', `slice/${id}`, versionTip], repo);
    writeFileSync(join(repo, file), `export const ${id} = '${id}';\n`, 'utf-8');
    git(['add', '-A'], repo);
    git(['commit', '-m', `feat(${id}): slice approved\n\nRefs-Slice: ${id}`], repo);
  }
  git(['checkout', 'main'], repo);

  // ── 7. 签字（已批准的签字请求） ──
  const locksDir = join(repo, '.zelto', 'locks');
  mkdirSync(locksDir, { recursive: true });
  for (const id of ['sl-a', 'sl-b']) {
    writeFileSync(
      join(locksDir, `sign-${id}.json`),
      JSON.stringify({ sliceId: id, status: 'approved', by: 'human', at: now }, null, 2),
      'utf-8',
    );
  }

  // ── 8. merge --target version/v2：合进版本分支，不碰主干 ──
  console.log('\n--- zelto merge --target version/v2 ---');
  const mergeOut = run('node', [ZELTO, 'merge', '--target', 'version/v2'], repo, true);
  console.log(mergeOut.split('\n').slice(0, 25).join('\n'));

  ok('主干**没有**拿到切片产物（合进了版本分支，不是主干）', !existsSync(join(repo, 'src', 'a.ts')));

  let versionHasA = false;
  try {
    git(['cat-file', '-e', 'version/v2:src/a.ts'], repo);
    versionHasA = true;
  } catch {
    versionHasA = false;
  }
  ok('版本分支 version/v2 拿到了切片产物', versionHasA);

  // ── 9. version ship：版本分支合入主干 + 打 tag ──
  console.log('\n--- zelto version ship v2 ---');
  const shipOut = run('node', [ZELTO, 'version', 'ship', 'v2'], repo, true);
  console.log(shipOut.split('\n').slice(0, 30).join('\n'));

  ok('ship 之后主干拿到 src/a.ts', existsSync(join(repo, 'src', 'a.ts')));
  ok('ship 之后主干拿到 src/b.ts', existsSync(join(repo, 'src', 'b.ts')));

  const tags = git(['tag', '--list'], repo);
  ok('版本 tag 打上了', tags.trim().length > 0, tags.trim());

  const branchesAfter = git(['branch', '--list'], repo);
  ok('版本分支保留（追溯锚点）', branchesAfter.includes('version/v2'));

  // ── 10. 事件留痕 ──
  let eventText = '';
  const collect = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collect(full);
      else if (name.endsWith('.jsonl')) eventText += readFileSync(full, 'utf-8');
    }
  };
  collect(join(repo, '.zelto', 'events'));
  ok('写了 merge 事件', eventText.includes('merge.'));
  ok('写了 version.delivered 事件', eventText.includes('version.delivered'));
} finally {
  if (!process.exitCode) {
    rmSync(repo, { recursive: true, force: true });
  } else {
    console.log(`\n（仓库保留在 ${repo} 供排查）`);
  }
}

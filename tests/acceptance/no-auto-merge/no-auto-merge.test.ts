// ADR-018 验收测试：签字只改状态，合并必须显式执行
//
// 这组测试守的是一条硬约束（AGENTS.md 负向清单）：不自动合并。
//
// 三件事必须成立：
//  1. `zelto sign <id> --approve` 之后，主分支上**没有**这个切片的产物
//  2. `zelto merge <id>` 之后，主分支上**才有**这个切片的产物
//  3. `zelto sign --push` 被拒绝——推送属于合并，不属于签字
//
// 跑的是真实 CLI 进程（dist/cli/index.js），所以先 `npm run build` 再跑。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ZELTO_CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(tmpdir(), `zelto-accept-nomerge-${Date.now()}`);
const ZELTO_DIR = join(TEST_DIR, '.zelto');
const SLICES_DIR = join(ZELTO_DIR, 'slices');
const EVENTS_DIR = join(ZELTO_DIR, 'events');
const LOCKS_DIR = join(ZELTO_DIR, 'locks');

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [ZELTO_CLI, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    env: { ...process.env, ZELTO_DIR: TEST_DIR },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** 文件是否已经进了主分支（HEAD 里有它） */
function inHead(file: string): boolean {
  const result = spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

/** 现有分支列表 */
function branches(): string[] {
  const result = spawnSync('git', ['branch', '--format=%(refname:short)'], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
  });
  return result.stdout.split('\n').map((b) => b.trim()).filter(Boolean);
}

/**
 * 造一个「已跑完、已签字、产物在分支上」的切片。
 *
 * 产物直接提交到 slice/<id> 分支上——这模拟切片在自己的 worktree 里跑完、
 * 改动已经在分支上的情形。
 */
async function setupSignedSlice(id: string, file: string, content: string) {
  // 切片文件
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'completed',
    spec: { path: `specs/slices/${id}.md`, frozenHash: 'sha256:test', frozenAt: new Date().toISOString() },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    writes: [file],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify(slice, null, 2), 'utf-8');

  // 产物提交到切片分支上
  git('checkout', '-b', `slice/${id}`);
  const filePath = join(TEST_DIR, file);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  git('add', file);
  git('commit', '-m', `feat: ${id} output\n\nRefs-Slice: ${id}`);
  git('checkout', 'main');

  // 已批准的签字请求
  const signReq = {
    id: `sign-${id}-1`,
    sliceId: id,
    status: 'approved',
    requestedAt: new Date().toISOString(),
    requestedBy: 'zelto',
    decidedAt: new Date().toISOString(),
    decidedBy: 'human',
    comment: null,
  };
  await writeFile(join(LOCKS_DIR, `sign-${id}-1.json`), JSON.stringify(signReq, null, 2), 'utf-8');
}

describe('验收：签字不自动合并（ADR-018）', { concurrency: false }, () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(LOCKS_DIR, { recursive: true });

    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    // .zelto 是 zelto 自己的状态目录，不进版本库——否则主仓库工作区不干净，
    // 合并会按设计跳过（ADR-012 的前置守卫）
    await writeFile(join(TEST_DIR, '.gitignore'), '.zelto/\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'README.md'), '# base\n', 'utf-8');
    git('add', '.gitignore', 'README.md');
    git('commit', '-m', 'base');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 每个用例从干净的 main 开始：删掉上一次的切片分支与签字请求
    git('checkout', 'main');
    git('reset', '--hard', 'HEAD');
    for (const branch of branches()) {
      if (branch.startsWith('slice/')) git('branch', '-D', branch);
    }
    for (const file of await readdir(LOCKS_DIR)) {
      await rm(join(LOCKS_DIR, file), { force: true });
    }
    for (const file of await readdir(SLICES_DIR)) {
      await rm(join(SLICES_DIR, file), { force: true });
    }
  });

  it('签字通过后主分支上还没有产物', async () => {
    await setupSignedSlice('nomerge-a', 'src/a.ts', 'export const a = 1;\n');

    const result = zelto('sign', 'nomerge-a', '--approve');
    assert.equal(result.status, 0, `sign should exit 0: ${result.stdout} ${result.stderr}`);

    // 关键断言：产物**没有**进主分支
    assert.equal(
      inHead('src/a.ts'),
      false,
      `签字后不应自动合并——但 src/a.ts 已经在 HEAD 里了：\n${git('log', '--oneline', '-5')}`,
    );
  });

  it('签字通过后提示下一步是显式合并', async () => {
    await setupSignedSlice('nomerge-b', 'src/b.ts', 'export const b = 1;\n');

    const result = zelto('sign', 'nomerge-b', '--approve');
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes('zelto merge'),
      `应提示下一步跑 zelto merge，输出是：${result.stdout}`,
    );
  });

  it('显式跑 zelto merge 之后产物才进主分支', async () => {
    await setupSignedSlice('nomerge-c', 'src/c.ts', 'export const c = 1;\n');

    const merge = zelto('merge', 'nomerge-c');
    assert.equal(merge.status, 0, `merge should exit 0: ${merge.stdout} ${merge.stderr}`);
    assert.ok(
      inHead('src/c.ts'),
      `合并后产物应进主分支：\n${git('log', '--oneline', '-5')}`,
    );
  });

  it('zelto merge 不带 id 时合并全部已批准待合的切片', async () => {
    await setupSignedSlice('nomerge-d', 'src/d.ts', 'export const d = 1;\n');
    await setupSignedSlice('nomerge-e', 'src/e.ts', 'export const e = 1;\n');

    const merge = zelto('merge');
    assert.equal(merge.status, 0, `merge should exit 0: ${merge.stdout} ${merge.stderr}`);
    assert.ok(inHead('src/d.ts'), 'nomerge-d 应被合并');
    assert.ok(inHead('src/e.ts'), 'nomerge-e 应被合并');
  });

  it('zelto sign 拒绝 --push 并指向 zelto merge --push', async () => {
    await setupSignedSlice('nomerge-f', 'src/f.ts', 'export const f = 1;\n');

    const result = zelto('sign', 'nomerge-f', '--approve', '--push');
    assert.equal(result.status, 1, `应拒绝 --push：${result.stdout} ${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes('merge'), `应指向 zelto merge --push，输出是：${output}`);
  });

  it('合并成功后写 merge.completed 事件', async () => {
    await setupSignedSlice('nomerge-g', 'src/g.ts', 'export const g = 1;\n');

    const merge = zelto('merge', 'nomerge-g');
    assert.equal(merge.status, 0, `merge should exit 0: ${merge.stdout} ${merge.stderr}`);

    const eventFile = join(EVENTS_DIR, 'nomerge-g', 'events.jsonl');
    assert.ok(existsSync(eventFile), `事件文件应存在：${eventFile}`);
    const content = await readFile(eventFile, 'utf-8');
    assert.ok(content.includes('merge.completed'), `应有 merge.completed 事件：${content}`);
  });
});

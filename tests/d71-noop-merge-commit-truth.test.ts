// D-71：ship 的 mergeCommit 不能是「HEAD 恰好是啥」—— 追溯链不能说假话
//
// 病灶（实测 nimrtc-zelto v1，2026-11-17）：
//
//   v4 delivered at 22:27:04  mergeCommit=5e6e0abc  （Ship version version/v4）
//   v1 delivered at 22:35:26  mergeCommit=5e6e0abc  ← 同一个提交！
//
// v1 的 ship 实际**没有产生新提交** —— 它的产物早已在分支上了，
// `git merge` 报 "Already up to date"，HEAD 一动不动。
//
// 但 ship 的事件与 tag 记的是 `mergeCommit = rev-parse HEAD` ——
// **不管这次合并有没有动过 HEAD**。于是 v1 记下了 HEAD 当时的位置，
// 那恰好是 v4 留下的 5e6e0abc。
//
// 后果（C4：事件是追溯的唯一证据载体）：
//   - tag `v1` 和 tag `v4` 指向**同一个提交**；
//   - `git merge-base --is-ancestor v1 main` 返回假 ——
//     追溯链说「v1 在主干里」，git 说没在；
//   - 人查「v1 到底合到哪了」，得到一个**别人的**提交号。
//
// **假完成比不完成更坏** —— 它让人以为可以往下走。
//
// 这一组用例守的是：
//   1. 空操作合并（产物早已在目标分支）→ mergeCommit 记 **null**，不是 HEAD；
//   2. 事件里的 noop 标记为 true；
//   3. tag 打在**包含本版本内容的提交**上（不是「本次合并产生的」）；
//   4. 正常合并（有新提交）→ mergeCommit 仍是那个新提交，不能被改坏。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/**
 * 主仓里一份最小可用的 zelto 项目（版本计划 + 一个已完成的切片）。
 *
 * `noop` 决定版本分支的产物是否**已经在 main 上**：
 *   - false → 版本分支有 main 上没有的提交 → 正常合并（产生新提交）
 *   - true  → 版本分支的提交已经在 main 上 → 空操作合并
 */
function makeProject(dir: string, opts: { noop: boolean }): { baseCommit: string } {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);

  const baseCommit = git(['rev-parse', 'HEAD'], dir).trim();

  git(['checkout', '-q', '-b', 'version/vx'], dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.txt'), 'feature\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'version work'], dir);
  const versionTip = git(['rev-parse', 'HEAD'], dir).trim();
  git(['checkout', '-q', 'main'], dir);

  if (opts.noop) {
    // 把版本分支的提交**搬到 main 上** —— 版本分支的产物已在目标分支，
    // ship 会走空操作路径（git merge 报 "Already up to date"）。
    git(['merge', '-q', '--no-ff', 'version/vx', '-m', 'hand landed'], dir);
  }

  mkdirSync(join(dir, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(dir, '.zelto', 'versions'), { recursive: true });
  writeFileSync(
    join(dir, '.zelto', 'versions', 'plan-1.json'),
    JSON.stringify(
      {
        id: 'plan-1',
        title: '测试计划',
        status: 'confirmed',
        createdAt: '2026-01-01T00:00:00.000Z',
        versions: [
          {
            version: 'vx',
            dependsOn: [],
            description: '测试版本',
            slices: [{ id: 'vx-slice', title: '片', module: 'm', writes: [] }],
            integrationTestDir: 'tests/integration/vx',
            status: 'integrated',
            branch: 'version/vx',
            baseCommit,
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(
    join(dir, '.zelto', 'slices', 'vx-slice.json'),
    JSON.stringify(
      {
        id: 'vx-slice',
        title: '片',
        state: 'completed',
        spec: { path: 'specs/slices/vx-slice.md', frozenHash: null, frozenAt: null },
        acceptance: {
          dir: 'tests/acceptance/vx-slice/',
          frozenHash: null,
          oracleSrc: null,
        },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes: [],
        runs: [],
        clarifyRounds: 0,
        stall: { class: null, autoResolved: 0, gateRetries: 0 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
    'utf-8',
  );

  return { baseCommit, versionTip } as { baseCommit: string } & { versionTip: string };
}

/** 跑一次 `zelto version ship vx` */
function runShip(cwd: string): { stdout: string; stderr: string; code: number } {
  const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
  const r = spawnSync('node', [cli, 'version', 'ship', 'vx'], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

/** 读某个版本的事件流里的某类事件 */
function readEvents(dir: string, type: string): Array<Record<string, unknown>> {
  const file = join(dir, '.zelto', 'events', 'version-vx', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

describe('D-71：ship 的 mergeCommit 必须是「本次合并产生的」，空操作时记 null', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d71-'));
    repo = join(dir, 'repo');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('空操作合并 → mergeCommit 记 null，noop 记 true（不是 HEAD 顶替）', () => {
    makeProject(repo, { noop: true });

    const headBefore = git(['rev-parse', 'HEAD'], repo).trim();

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    // 确认这次合并确实没动 HEAD
    assert.equal(
      git(['rev-parse', 'HEAD'], repo).trim(),
      headBefore,
      '空操作合并的前提就是 HEAD 不变',
    );

    const delivered = readEvents(repo, 'version.delivered');
    assert.equal(delivered.length, 1, '应当有且只有一条 version.delivered 事件');
    const payload = delivered[0].payload as Record<string, unknown>;

    assert.equal(
      payload.mergeCommit,
      null,
      '空操作合并时 mergeCommit 必须是 null —— 写 HEAD 顶替是说假话',
    );
    assert.equal(payload.noop, true, '空操作合并必须标记 noop=true');
  });

  it('空操作合并 → tag 打在版本分支 tip 上（每个版本各不相同，不能撞车）', () => {
    makeProject(repo, { noop: true });

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    const delivered = readEvents(repo, 'version.delivered');
    const payload = delivered[0].payload as Record<string, unknown>;

    // tag 存在，且指向的提交确实包含本版本的产物
    const tag = payload.tag as string | null;
    assert.ok(tag, '空操作合并也应当打 tag（内容在目标分支上，有诚实锚点）');

    const tagged = git(['rev-parse', `${tag}^{}`], repo).trim();
    const hasProduct = git(['ls-tree', '-r', '--name-only', tagged], repo).includes(
      'src/feature.txt',
    );
    assert.ok(hasProduct, `tag "${tag}" 指向的提交必须包含本版本的产物`);

    // D-71 核心：tag 不能指向「目标分支当前位置」——
    // 那个位置可能是**别的版本** ship 留下的提交。
    // 空操作合并时锚点必须是**版本分支 tip**。
    const versionTip = git(['rev-parse', 'version/vx'], repo).trim();
    assert.equal(
      tagged,
      versionTip,
      '空操作合并的 tag 必须打在版本分支 tip 上（每个版本各不相同）',
    );
  });

  it('空操作的第二次 ship：tag 锚在版本分支 tip 上，不认领第一次 ship 的提交', () => {
    // v1 病灶：v1 ship 是空操作，HEAD 停在 v4 ship 留下的提交上 →
    // tag v1 与 tag v4 指向同一个提交。
    //
    // 这里复现：先 ship 一次（留下提交 X），再让版本分支的产物落到主干，
    // 第二次 ship 走空操作 —— 第二次不能把 X 记成自己的 mergeCommit。
    makeProject(repo, { noop: false });

    const first = runShip(repo);
    assert.equal(first.code, 0, `第一次 ship 应当成功：${first.stdout}\n${first.stderr}`);
    const firstCommit = git(['rev-parse', 'HEAD'], repo).trim();

    git(['reset', '-q', '--hard', 'HEAD~1'], repo);
    git(['merge', '-q', '--no-ff', 'version/vx', '-m', 'hand landed'], repo);

    const planPath = join(repo, '.zelto', 'versions', 'plan-1.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    const versions = plan.versions as Array<Record<string, unknown>>;
    versions[0].status = 'integrated';
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    const second = runShip(repo);
    assert.equal(second.code, 0, `第二次 ship 应当成功：${second.stdout}\n${second.stderr}`);

    const delivered = readEvents(repo, 'version.delivered');
    const last = delivered[delivered.length - 1].payload as Record<string, unknown>;

    assert.notEqual(
      last.mergeCommit,
      firstCommit,
      '空操作的第二次 ship 不能把第一次 ship 的提交记成自己的 mergeCommit',
    );
    assert.equal(last.mergeCommit, null, '空操作合并的 mergeCommit 必须是 null');
    assert.equal(last.noop, true, '第二次 ship 应标记 noop=true');

    // ── D-76 D2：空操作时 tag 锚在**版本分支 tip**上 ──────────────
    //
    // 注意比的是**tag 指向的提交**，不是 tag 的名字 ——
    // 同一个版本 ship 两次，tag 名字本来就该一样（都是 "vx"）。
    //
    // 早先这条断言写的是 `assert.notEqual(secondTag, firstTag)`：
    // 它比的是 tag 名字，而同一个版本的两次 ship 名字必然相同。
    // 它之所以「通过」，是因为二次 ship 时 `tagVersion()` 返回 false
    // → 事件里记 `tag: null` → null ≠ "vx" → 断言成立。
    //
    // 也就是说：**D-73 的缺陷恰好满足了一条写错的断言**。
    // D-73 修好（tag 名不再被抹成 null）后，这条断言就露馅了。
    //
    // 病灶的实质不是「tag 名字一样」—— 同一个版本本来就该用同一个 tag 名。
    // 实质是「tag 指向了**别的版本**留下的提交」。
    // 所以判据是：空操作时锚点 = 版本分支 tip（这一版的产物汇聚点）。
    const versionTip = git(['rev-parse', 'version/vx'], repo).trim();
    assert.equal(
      last.anchorCommit,
      versionTip,
      '空操作合并的 tag 必须锚在版本分支 tip 上（ADR-076 D2）',
    );

    const tagName = last.tag as string | null;
    assert.ok(tagName, '事件里应记下 tag 名');
    assert.equal(
      git(['rev-parse', `${tagName}^{}`], repo).trim(),
      versionTip,
      'git 里这个 tag 必须指向版本分支 tip',
    );
  });

  it('两个**不同**版本的 tag 不会撞在同一个提交上（v1 与 v4 撞车的病灶）', () => {
    // 真正的撞车场景：**版本 A** 的 ship 是空操作，
    // HEAD 停在**版本 B** ship 留下的提交上 ——
    // 如果空操作时锚点取 HEAD，tag A 与 tag B 就指向同一个提交。
    //
    // 这里造两个版本：v1 与 v2，各有自己的版本分支与提交。
    makeProject(repo, { noop: false });

    // 加一个 v2 版本：分支与提交都与 v1 不同
    git(['checkout', '-q', '-b', 'version/vy'], repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'other.txt'), 'other\n', 'utf-8');
    // 只 add 这一个文件 —— `git add -A` 会把未跟踪的 `.zelto/` 状态目录
    // 一起提交进去，切回 main 时那些文件就跟着消失了。
    git(['add', '--', 'src/other.txt'], repo);
    git(['commit', '-q', '-m', 'version vy work'], repo);
    const vyTip = git(['rev-parse', 'HEAD'], repo).trim();
    git(['checkout', '-q', 'main'], repo);

    const planPath = join(repo, '.zelto', 'versions', 'plan-1.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    const versions = plan.versions as Array<Record<string, unknown>>;
    versions.push({
      version: 'vy',
      dependsOn: [],
      description: '第二版',
      slices: [{ id: 'vy-slice', title: '片', module: 'm', writes: [] }],
      integrationTestDir: 'tests/integration/vy',
      status: 'integrated',
      branch: 'version/vy',
      baseCommit: git(['rev-parse', 'HEAD'], repo).trim(),
    });
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    writeFileSync(
      join(repo, '.zelto', 'slices', 'vy-slice.json'),
      JSON.stringify({
        id: 'vy-slice',
        title: '片',
        state: 'completed',
        spec: { path: 'specs/slices/vy-slice.md', frozenHash: null, frozenAt: null },
        acceptance: { dir: 'tests/acceptance/vy-slice/', frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes: [],
        runs: [],
        clarifyRounds: 0,
        stall: { class: null, autoResolved: 0, gateRetries: 0 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );

    // 先 ship v1（正常合并，产生提交 X）
    const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
    const shipV1 = spawnSync('node', [cli, 'version', 'ship', 'vx'], { cwd: repo, encoding: 'utf-8' });
    assert.equal(shipV1.status, 0, `v1 ship 应当成功：${shipV1.stdout}\n${shipV1.stderr}`);

    // 再 ship v2 —— 它的产物也已经在 main 上（空操作）
    git(['merge', '-q', '--no-ff', 'version/vy', '-m', 'vy landed'], repo);
    const plan2 = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    (plan2.versions as Array<Record<string, unknown>>).forEach((v) => {
      v.status = 'integrated';
    });
    writeFileSync(planPath, JSON.stringify(plan2, null, 2), 'utf-8');

    const shipV2 = spawnSync('node', [cli, 'version', 'ship', 'vy'], { cwd: repo, encoding: 'utf-8' });
    assert.equal(shipV2.status, 0, `v2 ship 应当成功：${shipV2.stdout}\n${shipV2.stderr}`);

    const tagV1 = git(['rev-parse', 'vx^{}'], repo).trim();
    const tagV2 = git(['rev-parse', 'vy^{}'], repo).trim();

    assert.notEqual(
      tagV1,
      tagV2,
      '两个版本的 tag 不能指向同一个提交（那正是 v1 与 v4 撞车的病灶）',
    );
    assert.equal(tagV2, vyTip, '空操作的 v2 tag 必须锚在自己的版本分支 tip 上');
  });

  it('空操作合并 → 输出明说「没有产生新提交」', () => {
    makeProject(repo, { noop: true });

    const res = runShip(repo);
    assert.ok(
      res.stdout.includes('空操作'),
      `空操作合并的输出必须说「空操作」：\n${res.stdout}`,
    );
  });

  it('正常合并（有新提交）→ mergeCommit 就是那个新提交（不能被改坏）', () => {
    makeProject(repo, { noop: false });

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    const delivered = readEvents(repo, 'version.delivered');
    const payload = delivered[0].payload as Record<string, unknown>;

    const mergeCommit = payload.mergeCommit as string | null;
    assert.ok(mergeCommit, '正常合并必须有 mergeCommit');
    assert.equal(
      mergeCommit,
      git(['rev-parse', 'HEAD'], repo).trim(),
      '正常合并的 mergeCommit 必须就是本次合并产生的新提交',
    );
    assert.equal(payload.noop, false, '正常合并不是 noop');
  });

  it('两次 ship 连续跑 → 第二个不能把第一个的提交记成自己的', () => {
    // 这是 v1 病灶的复现：先 ship 一次（留下提交 X），
    // 再让版本分支的产物落到主干上，第二次 ship 走空操作 ——
    // 第二次绝不能把 X 记成自己的 mergeCommit。
    makeProject(repo, { noop: false });

    const first = runShip(repo);
    assert.equal(first.code, 0, `第一次 ship 应当成功：${first.stdout}\n${first.stderr}`);
    const firstCommit = git(['rev-parse', 'HEAD'], repo).trim();

    // 现在把版本分支的提交搬到 main 上 → 第二次 ship 走空操作
    git(['reset', '-q', '--hard', 'HEAD~1'], repo);
    git(['merge', '-q', '--no-ff', 'version/vx', '-m', 'hand landed'], repo);

    // 版本状态已被第一次 ship 置为 delivered —— 复位到 integrated 才能再 ship
    const planPath = join(repo, '.zelto', 'versions', 'plan-1.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    const versions = plan.versions as Array<Record<string, unknown>>;
    versions[0].status = 'integrated';
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    const second = runShip(repo);
    assert.equal(second.code, 0, `第二次 ship 应当成功：${second.stdout}\n${second.stderr}`);

    const delivered = readEvents(repo, 'version.delivered');
    const last = delivered[delivered.length - 1].payload as Record<string, unknown>;

    assert.notEqual(
      last.mergeCommit,
      firstCommit,
      '空操作的第二次 ship 不能把第一次 ship 的提交记成自己的 mergeCommit',
    );
    assert.equal(last.mergeCommit, null, '空操作合并的 mergeCommit 必须是 null');
  });
});

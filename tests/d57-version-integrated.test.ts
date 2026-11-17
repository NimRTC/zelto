// D-57：版本状态不能被「合并了一次」带成 integrated
//
// 病灶（实测 nimrtc-zelto v3，2026-11-18）：
//   版本 v3 有两片。v3-chrome-waterfall 跑了、过了门禁、合进来了；
//   v3-weaknet-verdict **一片都没跑**（还冻着，`runs: []`）。
//
//   合完第一片后，`zelto version status` 显示：
//     ✅ v3: integrated — [v3-chrome-waterfall, v3-weaknet-verdict]
//
//   假的。有一片根本没跑。
//
// 病灶在哪：合并后同步版本计划的那段判据写的是
//   「切片分支不存在 → 当作已合入」
// 而**从没跑过的切片压根没有分支** —— 于是它被算成「已合入」。
//
// 为什么这是坏的不是好的：
//   - 报错会让人停下；假完成会让人往前走；
//   - `version ship` 的前置条件正是 `integrated` → 一版没做完的东西能被交出去；
//   - 人唯一的判断依据就是 status 那一行字。
//
// 这一组用例守的是：
//   1. 有一片没跑（frozen）→ 版本**不能**被判成 integrated；
//   2. 有一片跑挂了（不是 completed）→ 同样不能；
//   3. 每片都 completed → 才允许 integrated；
//   4. 切片状态文件读不出来 → 当作没做完（「不知道」不等于「做完了」）；
//   5. 计划里的状态本来就不是 integrated → 不复核、不改判。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-d57-'));
const REPO = join(TEST_DIR, 'repo');
const originalCwd = process.cwd();

function git(args: string[], cwd = REPO): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** 切片状态文件 —— 判 integrated 的真源（C1：状态只在文件里）。 */
function writeSliceState(id: string, state: string): void {
  mkdirSync(join(REPO, '.zelto', 'slices'), { recursive: true });
  writeFileSync(
    join(REPO, '.zelto', 'slices', `${id}.json`),
    JSON.stringify(
      {
        id,
        title: id,
        state,
        spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
        acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
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
}

/** 版本计划里的一片（只要 id 就够判 completed，但类型要全）。 */
const SLICE_A = { id: 'v3-a', module: 'm', title: 't', writes: ['a.txt'], specPath: 'specs/slices/v3-a.md' };
const SLICE_B = { id: 'v3-b', module: 'm', title: 't', writes: ['b.txt'], specPath: 'specs/slices/v3-b.md' };

describe('D-57：版本 integrated 的判据是「每片都 completed」', () => {
  before(() => {
    mkdirSync(join(REPO, '.zelto', 'versions'), { recursive: true });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@zelto.local']);
    git(['config', 'user.name', 'zelto test']);
    writeFileSync(join(REPO, 'a.txt'), 'a');
    writeFileSync(join(REPO, 'b.txt'), 'b');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    // 切片状态是相对路径 `.zelto/slices/` 读的 —— 得切到临时仓库里。
    process.chdir(REPO);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
  });

  it('一片 completed + 一片从没跑过 → 不算全做完', async () => {
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'frozen');

    const { allSlicesCompleted } = await import('../src/cli/commands/merge-executor.js');
    assert.equal(
      await allSlicesCompleted([SLICE_A, SLICE_B], REPO),
      false,
      '有一片冻着 → 不能算全做完',
    );
  });

  it('有一片跑挂了（不是 completed）→ 同样不算', async () => {
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'stalled');

    const { allSlicesCompleted } = await import('../src/cli/commands/merge-executor.js');
    assert.equal(await allSlicesCompleted([SLICE_A, SLICE_B], REPO), false);
  });

  it('每片都 completed → 才算全做完', async () => {
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'completed');

    const { allSlicesCompleted } = await import('../src/cli/commands/merge-executor.js');
    assert.equal(await allSlicesCompleted([SLICE_A, SLICE_B], REPO), true);
  });

  it('切片状态文件读不出来 → 当作没做完', async () => {
    writeSliceState('v3-a', 'completed');
    // v3-b 的状态文件**不存在**（模拟状态文件丢了 / 还没建）
    rmSync(join(REPO, '.zelto', 'slices', 'v3-b.json'), { force: true });

    const { allSlicesCompleted } = await import('../src/cli/commands/merge-executor.js');
    assert.equal(
      await allSlicesCompleted([SLICE_A, SLICE_B], REPO),
      false,
      '读不到状态 ≠ 做完了',
    );
  });

  it('version status 显示的是事实：有一片没跑就不能显示 integrated', async () => {
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'frozen');

    const { realVersionState } = await import('../src/cli/commands/ai-pipeline.js');
    const version = {
      version: 'v3',
      dependsOn: [],
      description: '两片',
      slices: [SLICE_A, SLICE_B],
      integrationTestDir: 'tests/acceptance/v3',
      status: 'integrated' as const,
    };
    // 计划记的是 integrated，但事实是 in_progress → 显示事实
    assert.equal(
      await realVersionState(version, { versions: [version] } as never),
      'in_progress',
      '有一片没跑 → 必须显示 in_progress，不能显示 integrated',
    );
  });

  it('每片都 completed → 计划记的没错，按计划显示', async () => {
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'completed');

    const { realVersionState } = await import('../src/cli/commands/ai-pipeline.js');
    const version = {
      version: 'v3',
      dependsOn: [],
      description: '两片',
      slices: [SLICE_A, SLICE_B],
      integrationTestDir: 'tests/acceptance/v3',
      status: 'integrated' as const,
    };
    assert.equal(await realVersionState(version, { versions: [version] } as never), null);
  });

  it('计划里的状态本来就不是 integrated → 不复核（planned 不该被改判）', async () => {
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'frozen');

    const { realVersionState } = await import('../src/cli/commands/ai-pipeline.js');
    const version = {
      version: 'v3',
      dependsOn: [],
      description: '两片',
      slices: [SLICE_A, SLICE_B],
      integrationTestDir: 'tests/acceptance/v3',
      status: 'planned' as const,
    };
    assert.equal(await realVersionState(version, { versions: [version] } as never), null);
  });

  it('ship 的闸门也核切片状态 —— 一片没跑就不许交出去', async () => {
    // ship 是**唯一**把版本推进主干的闸门。
    // 闸门放行一个没做完的版本 → 半成品进主干，后面谁都查不出来。
    writeSliceState('v3-a', 'completed');
    writeSliceState('v3-b', 'frozen');

    const { allSlicesCompleted } = await import('../src/cli/commands/merge-executor.js');
    assert.equal(
      await allSlicesCompleted([SLICE_A, SLICE_B], REPO),
      false,
      'ship 闸门必须拒绝：有一片没跑',
    );
  });
});

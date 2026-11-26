// ADR-126：产物证据 —— 「这片做完了」能不能在版本分支上**查证**
//
// 病灶（实测 nimrtc-v14，2026-11-26）：
//
//   ADR-114 给计划对照加了 `onBranch` 一列（切片**状态文件**是否已提交进
//   所属分支）。但 `.zelto/` 整体在 `.gitignore` 里 —— 状态文件**永远不会**
//   进版本分支。于是这列**恒为 0**：v1/v2/v3/v4 全部是 0。
//
//   它不只没有信息量，还给出**误导性**结论：
//   「分支上完成 0 / 盘上完成 10」读起来像「这版什么都没做完」，
//   而真相是「这版的产物**就在**分支上，只是状态文件没进 git」。
//
//   实测 nimrtc-v14 按 `Refs-Slice:` trailer 查：
//     version/v1 → 4 片 / version/v2 → 5 片 / version/v3 → 21 片 / version/v4 → 25 片
//   —— 产物一直都在分支上。
//
// 这个文件钉住：
//   1. 产物证据的三态：在分支（true）/ 查不到（false）/ 不知道（null）
//   2. trailer 的判据：一个片的**多个**提交都算它一个
//   3. 归属错位要**暴露**（查的是所属版本分支，不是「哪儿有算哪儿」）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  annotateArtifactEvidence,
  annotateArtifactEvidenceSync,
  describeArtifactHit,
} from '../src/core/project/artifact-evidence.js';

const ROOT = join(tmpdir(), `zelto-adr126-${Date.now()}`);

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

before(async () => {
  await mkdir(ROOT, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
});

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** 造一个带 Refs-Slice trailer 的提交。 */
async function commitWithSlice(file: string, content: string, sliceId: string, message: string) {
  // 每个用例的「第一步」都会碰到同一个文件名 —— 用计数器保证内容始终是新的
  commitSeq += 1;
  await writeFile(join(ROOT, file), `${content}#${Date.now()}-${commitSeq}`, 'utf-8');
  git('add', file);
  git('commit', '-q', '-m', `${message}\n\nRefs-Slice: ${sliceId}\n`);
}
let commitSeq = 0;

describe('ADR-126: 产物证据（真实 git）', () => {
  it('分支上有 Refs-Slice 提交 → onBranch = true，并给出短哈希与标题', async () => {
    await commitWithSlice('a.txt', 'a', 'slice-a', 'feat(slice-a): 做点事');
    git('branch', '-f', 'version/v1');

    const rows = await annotateArtifactEvidence(ROOT, 'version/v1', [{ id: 'slice-a' }]);
    assert.equal(rows[0].onBranch, true);
    assert.ok(rows[0].commit, '要给出命中的短哈希');
    assert.ok((rows[0].subject || '').includes('slice-a'));
  });

  it('分支上没有这一片 → onBranch = false（不是「未知」）', async () => {
    await commitWithSlice('b.txt', 'b', 'slice-b', 'feat(slice-b): 另一片');
    git('branch', '-f', 'version/v1');

    const rows = await annotateArtifactEvidence(ROOT, 'version/v1', [{ id: 'slice-not-here' }]);
    assert.equal(rows[0].onBranch, false);
    assert.equal(rows[0].commit, null);
  });

  it('一个片的多个提交都算它一个（取最新的那个）', async () => {
    await commitWithSlice('c.txt', 'c1', 'slice-multi', 'feat(slice-multi): 第一步');
    await commitWithSlice('d.txt', 'd', 'slice-multi', 'test(slice-multi): 第二步');
    git('branch', '-f', 'version/v1');

    const rows = await annotateArtifactEvidence(ROOT, 'version/v1', [{ id: 'slice-multi' }]);
    assert.equal(rows[0].onBranch, true);
    // 取**最新**的提交（git log 是新→旧）
    assert.ok((rows[0].subject || '').includes('第二步'), `实际：${rows[0].subject}`);
  });

  it('分支不存在 → onBranch = null（拿不到证据，不说「没有」）', async () => {
    const rows = await annotateArtifactEvidence(ROOT, 'version/nope', [{ id: 'slice-a' }]);
    assert.equal(rows[0].onBranch, null, '「不知道」不许说成「没有」');
  });

  it('不是 git 仓库 → onBranch = null', async () => {
    const notRepo = join(tmpdir(), `zelto-adr126-norepo-${Date.now()}`);
    await mkdir(notRepo, { recursive: true });
    const rows = await annotateArtifactEvidence(notRepo, 'version/v1', [{ id: 'slice-a' }]);
    assert.equal(rows[0].onBranch, null);
    await rm(notRepo, { recursive: true, force: true });
  });

  it('trailer 里多个切片 id（逗号分隔）都认', async () => {
    await writeFile(join(ROOT, 'e.txt'), 'e', 'utf-8');
    git('add', 'e.txt');
    git('commit', '-q', '-m', 'feat: 一次提交两片\n\nRefs-Slice: slice-x, slice-y\n');
    git('branch', '-f', 'version/v2');

    const rows = await annotateArtifactEvidence(ROOT, 'version/v2', [
      { id: 'slice-x' },
      { id: 'slice-y' },
    ]);
    assert.equal(rows[0].onBranch, true);
    assert.equal(rows[1].onBranch, true);
  });

  it('归属错位要暴露：查的是**所属版本**的分支，不是「哪儿有算哪儿」', async () => {
    // slice-misplaced 的产物在 version/v2 上（v2 已越过 v1，v2 不是 v1 的祖先），
    // 但计划说它属于 v1
    await commitWithSlice('f.txt', 'f', 'slice-misplaced', 'feat(slice-misplaced): 合错版本');
    git('branch', '-f', 'version/v2');

    const rows = await annotateArtifactEvidence(ROOT, 'version/v1', [{ id: 'slice-misplaced' }]);
    assert.equal(rows[0].onBranch, false, '所属分支查不到就说查不到 —— 不替它改归属');
    assert.equal(rows[0].ancestorOnBranch, false, '也不许假装它「随祖先并入」');
  });
});

describe('ADR-126r2: 祖先分支上的产物也在，但要说清是「祖先」', () => {
  it('栈式版本：v2 在 v1 之上切 —— v1 的片对 v2 是 ancestorOnBranch=true，onBranch 仍为 false', async () => {
    await commitWithSlice('a.txt', 'a', 'slice-in-v1', 'feat: v1 的片');
    git('branch', '-f', 'version/v1');
    await commitWithSlice('b.txt', 'b', 'slice-in-v2', 'feat: v2 的片');
    git('branch', '-f', 'version/v2');

    const [row] = await annotateArtifactEvidence(ROOT, 'version/v2', [{ id: 'slice-in-v1' }]);
    // 判据「在所属分支上」：只认这一版自己的提交，祖先带来的不算
    assert.equal(row.onBranch, false);
    assert.equal(row.commit, null);
    // 但产物确实随栈进入了 v2 —— 不能因此说「v2 里没有」
    assert.equal(row.ancestorOnBranch, true);
    assert.ok(row.ancestorCommit);
  });

  it('同一条线上更早的分支不算祖先：它的 tip 被 version/v3 越过 → 不是祖先', async () => {
    // version/early 在当时的 main tip 上挂一个空提交，之后 main 继续前进、
    // v3 从新 tip 切 —— early 的 tip 不在 v3 历史里
    const earlyBase = git('rev-parse', 'HEAD').trim();
    git('commit', '-q', '--allow-empty', '-m', 'chore: early 分支的起点');
    git('branch', '-f', 'version/early');
    git('reset', '-q', '--hard', earlyBase);
    await commitWithSlice('e.txt', 'e', 'slice-main', 'feat: 主干继续');
    git('branch', '-f', 'version/v3');

    // early 的 tip 是 v3 的兄弟提交，不是祖先 —— 任何片都不许说「随祖先并入」
    const [row] = await annotateArtifactEvidence(ROOT, 'version/v3', [{ id: 'slice-early-only' }]);
    assert.equal(row.onBranch, false);
    assert.equal(row.ancestorOnBranch, false);
  });

  it('所属分支不存在 → 两列都是 null（不知道）', async () => {
    const [row] = await annotateArtifactEvidence(ROOT, 'version/nope', [{ id: 'slice-in-v1' }]);
    assert.equal(row.onBranch, null);
    assert.equal(row.ancestorOnBranch, null);
  });
});

describe('ADR-126: 同步版与展示', () => {
  it('同步版：命中 / 不命中 / 不知道 三态', () => {
    const found = new Map([['hit', { hash: 'abc12345', subject: 'feat(hit): 干活' }]]);
    const rows = annotateArtifactEvidenceSync([{ id: 'hit' }, { id: 'miss' }], found);
    assert.equal(rows[0].onBranch, true);
    assert.equal(rows[1].onBranch, false);

    const unknown = annotateArtifactEvidenceSync([{ id: 'hit' }], null);
    assert.equal(unknown[0].onBranch, null);
  });

  it('describeArtifactHit 给出人话', () => {
    assert.equal(describeArtifactHit(null), '查不到产物提交');
    assert.equal(describeArtifactHit({ commit: 'abc12345', subject: null }), 'abc12345');
    assert.equal(
      describeArtifactHit({ commit: 'abc12345', subject: 'feat(x): 干活' }),
      'abc12345 feat(x): 干活',
    );
  });
});

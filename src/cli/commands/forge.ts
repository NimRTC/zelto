// zelto forge —— 把追溯链摆到远端评审平台（ADR-094 §6）
//
// **PR 是追溯链的载体，不是评审主体**（ADR-094 D7）。
//
// 批准权单点留在 zelto：这个命令**不**检查 PR 是否被 approve，
// **不**在 approve 时触发合并。GitHub 上 reviewer 点了 approve，
// zelto 也不认 —— 那不是缺陷，是刻意的单点（ADR-018）。
//
// **默认不真的开 PR**（ADR-094 D9）：开 PR 是**对外可见**的动作
// （远端 reviewer 会收到通知）。zelto 对这类动作一贯要求显式
// （`--hotfix` 必须配 `--yes`，ADR-015）。
// 不加 `--open` 时只打印将要提交的内容。

import { join } from 'node:path';
import { getDefaultFormatter } from '../output-formatter.js';
import { register, events, store, ZELTO_DIR, worktreeManager } from './shared.js';
import { collectSignReviewFacts } from '../sign-review/collect-facts.js';
import { buildForgeTraceFacts, renderPrBody } from '../../core/forge/index.js';
import { GitHubForgeAdapter } from '../../adapters/github/index.js';
import { resolveSliceOwnership } from '../../core/version/branch.js';

register('forge', async (args: string[]): Promise<number> => {
  const f = getDefaultFormatter();
  const subcmd = args[0];

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    f.error('USAGE', 'Usage: zelto forge pr <slice-id> [--open] [--base <branch>] [--print-body]');
    f.out('       zelto forge pr <slice-id>            预览将要提交的内容（不开 PR）');
    f.out('       zelto forge pr <slice-id> --open      真的开 PR');
    f.out('         --base <branch>  目标分支；缺省按切片归属解析（ADR-056）');
    f.out('         --print-body    只输出正文（手动贴到别处时用）');
    return 1;
  }

  if (subcmd !== 'pr') {
    f.error('USAGE', `Unknown forge subcommand: ${subcmd}`);
    f.out('       zelto forge pr <slice-id> [--open] [--base <branch>] [--print-body]');
    return 1;
  }

  const sliceId = args[1];
  if (!sliceId || sliceId.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto forge pr <slice-id> [--open] [--base <branch>]');
    return 1;
  }

  const isJson = args.includes('--json');
  const shouldOpen = args.includes('--open');
  const printBodyOnly = args.includes('--print-body');
  const baseIdx = args.indexOf('--base');
  const explicitBase = baseIdx >= 0 && args[baseIdx + 1] && !args[baseIdx + 1].startsWith('--')
    ? args[baseIdx + 1]
    : null;

  // ── 切片存在性 ──────────────────────────────────────────────────────
  if (!(await store.exists(sliceId))) {
    f.error('NOT_FOUND', `Slice "${sliceId}" not found.`);
    return 1;
  }

  const slice = await store.read(sliceId);

  // ── 分支解析 ────────────────────────────────────────────────────────
  //
  // head 固定是切片的分支（worktree 管理器定的，ADR-011）。
  // base 按**切片自己的归属**解析（ADR-056）—— 切片合进 `version/v1`，
  // PR 的 base 就该是 `version/v1`，不是 `main`。
  const manager = worktreeManager();
  const headBranch = manager.branchFor(sliceId);

  let baseBranch = explicitBase;
  if (!baseBranch) {
    try {
      const ownership = resolveSliceOwnership(sliceId, {
        versionsDir: join(ZELTO_DIR, 'versions'),
        specPath: slice.spec.path,
      });
      baseBranch = ownership.branch;
    } catch {
      // 归属解析不出来（歧义 / 计划坏了）→ 退回主干。
      // 不猜 —— 归属不明时最保守的读法是「合到主干」。
      baseBranch = null;
    }
  }
  if (!baseBranch) baseBranch = 'main';

  // ── 事实收集（复用签字复查的唯一实源，ADR-070）─────────────────────
  const review = await collectSignReviewFacts(sliceId);
  const sliceEvents = await events.read(sliceId);
  const facts = buildForgeTraceFacts(slice, review, sliceEvents, {
    head: headBranch,
    base: baseBranch,
  });

  // ── D12：开 PR 要求已签字 ───────────────────────────────────────────
  //
  // PR body 里的追溯块要有 signId。没签字就没有签字可引，
  // 且「没签字就开 PR」会让远端 reviewer 以为这片已经过门禁。
  //
  // 但**预览**（默认模式）不要求 —— 人可能想先看 body 长什么样
  // 再决定签不签。
  if (shouldOpen && !facts.signId) {
    if (isJson) {
      f.data({
        sliceId,
        action: 'blocked',
        error: '未签字的切片不许开 PR',
        hint: `zelto sign ${sliceId} --approve`,
      });
    } else {
      f.error('NOT_SIGNED', `切片 "${sliceId}" 还没有签字 —— 不许开 PR。`);
      f.out('');
      f.out('  PR body 里的追溯块要引用签字请求（signId）。');
      f.out('  没签字就开 PR，会让远端 reviewer 以为这片已经过门禁。');
      f.out('');
      f.out(`  先签字：zelto sign ${sliceId} --approve`);
      f.out(`  再开 PR：zelto forge pr ${sliceId} --open`);
      f.out('');
      f.out('  （不加 --open 可以先预览 body 长什么样）');
    }
    return 1;
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  const rendered = renderPrBody(facts, new Date().toISOString());

  if (printBodyOnly) {
    // 只输出正文 —— 供人手动贴到别处（GitLab / 内部系统 / issue）。
    process.stdout.write(rendered.body);
    return 0;
  }

  if (isJson) {
    // `f.data()` 而不是 `f.out()` ——
    // out() 在 JSON 模式下把内容包成 `{message: "..."}`（那是给人看的字符串），
    // 而这里要给的是**结构化对象**（title / body / trace 各字段）。
    // 用 out() 会把整个对象塞进 message 里，调用方还得二次 parse。
    f.data({
      sliceId,
      action: shouldOpen ? 'open' : 'preview',
      title: rendered.title,
      base: baseBranch,
      head: headBranch,
      body: rendered.body,
      trace: rendered.trace,
    });
    if (!shouldOpen) return 0;
  } else if (!shouldOpen) {
    // ── 预览模式（默认）──────────────────────────────────────────────
    f.out(`# PR 预览 —— zelto forge pr ${sliceId}`);
    f.out('');
    f.out(`  标题：${rendered.title}`);
    f.out(`  目标：${baseBranch}   来源：${headBranch}`);
    f.out('');
    f.out('--- 正文 ---');
    f.out(rendered.body);
    f.out('--- 正文结束 ---');
    f.out('');
    f.out('  这是预览，**没有开 PR**。');
    f.out(`  真要开：zelto forge pr ${sliceId} --open`);
    return 0;
  }

  // ── 真开 PR ─────────────────────────────────────────────────────────
  const adapter = new GitHubForgeAdapter(process.cwd());

  // D10：`gh` 缺失 / 未登录 → 明确报错，不静默降级。
  const availability = await adapter.isAvailable();
  if (!availability.available) {
    if (isJson) {
      f.data({
        sliceId,
        action: 'blocked',
        error: availability.reason,
        remedy: availability.remedy,
      });
    } else {
      f.error('FORGE_UNAVAILABLE', availability.reason ?? '远端评审平台不可用');
      if (availability.remedy) {
        f.out('');
        f.out(availability.remedy);
      }
      f.out('');
      f.out('  **PR 没有开成。**');
    }
    return 1;
  }

  let result;
  try {
    result = await adapter.openPr({
      title: rendered.title,
      body: rendered.body,
      base: baseBranch,
      head: headBranch,
      dryRun: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      f.data({ sliceId, action: 'failed', error: msg });
    } else {
      f.error('FORGE_FAILED', `开 PR 失败：${msg}`);
      f.out('');
      f.out('  **PR 没有开成。**');
      f.out(`  正文已经备好，可以手动贴：zelto forge pr ${sliceId} --print-body`);
    }
    return 1;
  }

  // ── 事件（只记真开成功的）──────────────────────────────────────────
  //
  // 预览模式**不写事件** —— 它什么都没做。写成事件会让人以为
  // 「已经开了 PR」（ADR-094 §6.5）。
  await events.append(sliceId, 'forge.pr_opened', 'zelto', {
    sliceId,
    url: result.url,
    number: result.number,
    base: result.base,
    head: result.head,
    signId: facts.signId,
    title: rendered.title,
    via: 'cli',
  });

  if (isJson) {
    f.data({
      sliceId,
      action: 'opened',
      url: result.url,
      number: result.number,
      base: result.base,
      head: result.head,
    });
  } else {
    f.out(`zelto forge pr ${sliceId} -- ✅ PR opened`);
    if (result.url) f.out(`  URL:  ${result.url}`);
    f.out(`  ${headBranch} → ${baseBranch}`);
    f.out('');
    f.out('  批准权在 zelto 里 —— GitHub 上点 approve 不会触发合并。');
    f.out(`  合并是显式动作：zelto merge ${sliceId}`);
  }

  return 0;
});

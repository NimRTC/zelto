// 编排入口 —— `zelto sign --review <id>`（ADR-070 §5）
//
// 依次调用：收集（collectSignReviewFacts，CLI 层）→ 判定
// （evaluateSignChecks，core 层纯函数）→ 渲染（renderSignReview）→ stdout。
//
// 只读性：review 本身不写 `.zelto` 下任何文件、不追加任何事件（C4）。
// TTY 下确认签字后走现有 `--approve` 路径（ADR-070 §5.4）；
// 非 TTY 只打印、不提示（ADR-070 §5.5，沿用 core-slice.ts 不等人做法）。

import { createInterface } from 'node:readline';
import { evaluateSignChecks } from '../../core/sign-review/evaluate.js';
import type { SignCheck, SignReviewFacts } from '../../core/sign-review/types.js';
import { SignManager } from '../../core/gate/sign.js';
import { collectSignReviewFacts } from '../sign-review/collect-facts.js';
import { renderSignReview } from '../sign-review/render.js';
import { events, store, ZELTO_DIR } from './shared.js';

/**
 * `--json` 输出的结构（ADR-070 §5.5）：事实与判定来自同一处，
 * 将来的 `cockpit` 复用这一份结构。
 */
export interface SignReview {
  facts: SignReviewFacts;
  checks: SignCheck[];
}

/**
 * 跑一次签字复查。
 *
 * @param sliceId 切片 id
 * @param options.json 输出结构化 `SignReview`（facts + checks）而不是终端文本
 * @returns 退出码：0 成功；1 收集失败或批准失败
 */
export async function runSignReview(
  sliceId: string,
  options: { json?: boolean } = {},
): Promise<number> {
  const isJson = options.json ?? false;

  let facts: SignReviewFacts;
  try {
    facts = await collectSignReviewFacts(sliceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId, error: msg }));
    } else {
      console.error(`Error collecting review facts for "${sliceId}": ${msg}`);
    }
    return 1;
  }

  const checks = evaluateSignChecks(facts);

  if (isJson) {
    const review: SignReview = { facts, checks };
    console.log(JSON.stringify(review));
    return 0;
  }

  console.log(renderSignReview(checks, facts));

  // 非 TTY 只打印、不提示确认 —— 脚本管道/重定向下不等人回答（ADR-070 §5.5）。
  if (!process.stdin.isTTY) {
    return 0;
  }

  // TTY：确认后走现有 --approve 路径，同一个 signManager.approve()、
  // 同一个事件流，不新增动作类型（ADR-070 §5.4）。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('\n确认签字？[y/N] ', resolve);
  });
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === 'y' || trimmed === 'yes') {
    return approveSlice(sliceId);
  }
  return 0;
}

/**
 * 与 `--approve` 分支同一条路径：没有 pending 请求时自动发起一个再批准
 * （gate-sign.ts 里 `--approve` 的既有行为，ADR-070 §5.4 要求一致）。
 */
async function approveSlice(sliceId: string): Promise<number> {
  try {
    const signManager = new SignManager(ZELTO_DIR, events, store);
    const pending = await signManager.list('pending');
    const req = pending.find((r) => r.sliceId === sliceId);
    if (!req) {
      const newReq = await signManager.request(sliceId, 'human');
      await signManager.approve(newReq.id, 'human', null);
      console.log(`zelto sign ${sliceId} -- ✅ Approved (auto-requested)`);
    } else {
      await signManager.approve(req.id, 'human', null);
      console.log(`zelto sign ${sliceId} -- ✅ Approved`);
    }

    // ADR-018：签字只改状态。合并是显式动作 —— zelto merge <id>
    console.log(`下一步：zelto merge ${sliceId}`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error approving "${sliceId}": ${msg}`);
    return 1;
  }
}

// 「以后都允许」的交互提问 —— 问人，不是判定（ADR-133 补充）
//
// ── 这一层放哪 ────────────────────────────────────────────────────────
//
// 判定在 `src/hook/acp-always.ts`（纯计算，C3）。
// 这里只做**问人**与**记账** —— 有 I/O，不进 hook 层。
//
// ── 三个选项 ──────────────────────────────────────────────────────────
//
//   1 = 仅本次（默认）—— 走 allow_once，与现在完全一致
//   2 = 以后都允许      —— 记进 zelto 的授权记忆（**不是** agent 的）
//   3 = 拒绝
//
// ── 非 TTY 一律不放开 ────────────────────────────────────────────────
//
// 用户拍板（2026-11-27）：非 TTY（CI、后台跑）时**不放开**。
//
// 理由：非 TTY 意味着**没有人**能回答 —— 提问只会挂死，
// 而「不问就放开」等于把「以后都允许」变成默认开启，
// 那与「缺省是关的」直接矛盾。
//
// 所以非 TTY 下：只走 allow_once（本次），不提问，不放开。

import { createInterface } from 'node:readline';

/** 用户的三个选择。 */
export type AlwaysPromptChoice = 'once' | 'always' | 'reject';

/**
 * 问人要不要「以后都允许」。
 *
 * @param path — 相对 worktree 的路径（给人看的）
 * @param input — 输入流（默认 stdin）
 * @param output — 输出流（默认 stdout）
 * @returns 人的选择；非 TTY 时返回 `'once'`
 */
export async function promptAlwaysAllow(
  path: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<AlwaysPromptChoice> {
  // 非 TTY → 不问、不放开（见文件头）。
  if (!(input as NodeJS.ReadStream).isTTY) return 'once';

  output.write(`\n`);
  output.write(`  agent 想写入：${path}\n`);
  output.write(`  该路径在当前切片的写集内，且在允许「以后都允许」的白名单里。\n`);
  output.write(`\n`);
  output.write(`    1) 仅本次允许（默认）\n`);
  output.write(`    2) 以后都允许（本次切片内，不再重复询问）\n`);
  output.write(`    3) 拒绝\n`);
  output.write(`\n`);

  const rl = createInterface({ input: input as NodeJS.ReadableStream, output: output as NodeJS.WritableStream });
  const answer = await new Promise<string>((resolve) => {
    rl.question('  选择 [1/2/3]: ', resolve);
  });
  rl.close();

  const trimmed = answer.trim();
  if (trimmed === '2') return 'always';
  if (trimmed === '3') return 'reject';
  // 其余（含空回车）→ 仅本次
  return 'once';
}

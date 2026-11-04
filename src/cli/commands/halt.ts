// zelto halt —— 拉闸
//
// 「高速」必须有刹车。现在 zelto 只有被动停机（agent 自己挂了、被 hook 拦了），
// 批次跑偏时人只能 Ctrl-C —— 进程一死，半成品 worktree、写集预约、
// 切片状态全留在盘上，恢复得全靠手工。
//
// `zelto halt` 让批次**主动**停下来：
//   1. 人喊停 → 写一份暂停请求到 `.zelto/halts/<scope>.json`（C1：状态只在文件里）
//   2. 正在跑的批次在安全点上读到它 → 不再启动新的 agent，
//      已经跑起来的 agent 被停掉（adapter.stop），现场保留
//   3. 人处理完 → `zelto halt --clear` 解除 → 重新跑批次继续
//
// 为什么要「文件 + 安全点」而不是「信号」：
//   - zelto 不常驻（AGENTS.md 禁区：常驻 daemon），两个进程之间没有通道
//   - 杀掉正在写的 agent 会留下半截文件；安全点停手能把现场交回给人
//
// C3: 判定确定 —— 读文件、比对作用域，没有模型参与
// C4: 每个动作写事件（拉闸、解除都留痕）

import { resolve } from 'node:path';

import { HaltStore, findStuckRunningSlices, rollbackHaltedSlices } from '../../core/halt/index.js';
import type { HaltRollbackResult } from '../../core/halt/index.js';
import { ReservationStore } from '../../core/sched/index.js';
import { events, register, store, ZELTO_DIR, existingWorktreePath } from './shared.js';

function haltStore(): HaltStore {
  return new HaltStore(ZELTO_DIR);
}

/** 打印现场：哪些切片在跑、预约还在谁手上、worktree 在哪 */
async function printScene(): Promise<void> {
  const ids = await store.list();
  const reservations = new ReservationStore(resolve(process.cwd(), '.zelto', 'locks'));
  const active = await reservations.active().catch(() => []);

  console.log('现场：');

  let printed = 0;
  for (const id of ids) {
    const slice = await store.read(id).catch(() => null);
    if (!slice) continue;

    const worktree = existingWorktreePath(id);
    const held = active.find((r) => r.sliceId === id);
    const interesting = slice.state === 'running' || Boolean(worktree) || Boolean(held);
    if (!interesting) continue;

    printed++;
    console.log(`  ${id} — ${slice.state}`);
    if (worktree) console.log(`    worktree:  ${worktree}`);
    if (held) console.log(`    预约:       ${held.writes.join(', ') || '(空)'}`);
    if (slice.state === 'running') {
      console.log('    ⚠️  running 状态的切片不会自动回退 —— 人工确认后 zelto resume 或 zelto abandon');
    }
  }

  if (printed === 0) {
    console.log('  （没有正在跑的切片，也没有未释放的预约）');
  }
}

/**
 * 把「卡在 running」的切片强制回退。
 *
 * 场景：批次进程崩了 / 被 Ctrl-C 杀了 —— 切片永远卡在 `running`，
 * 准入只认 `frozen`，于是它再也跑不了，只能手工 abandon。
 *
 * 判定标准是确定性的（C3）：状态是 `running`，且持有预约的进程已经死了。
 * 批次还活着时不动 —— 不能跟正在跑的批次抢切片。
 */
async function rollbackStuckSlices(
  reason: string,
  scope: string,
): Promise<HaltRollbackResult[]> {
  const reservations = new ReservationStore(resolve(process.cwd(), '.zelto', 'locks'));
  const all = await reservations.list().catch(() => []);
  const stuck = await findStuckRunningSlices(store, all);

  if (stuck.length === 0) return [];

  return rollbackHaltedSlices(store, events, stuck, {
    reason,
    scope,
    actor: 'human',
  });
}

register('halt', async (args) => {
  const isJson = args.includes('--json');
  const halts = haltStore();

  // ── zelto halt --list：看当前暂停请求 ───────────────────────────────
  if (args.includes('--list')) {
    const list = await halts.list();
    if (isJson) {
      console.log(JSON.stringify({ halts: list }, null, 2));
      return 0;
    }
    if (list.length === 0) {
      console.log('没有暂停请求（批次在正常跑）。');
      return 0;
    }
    console.log('暂停请求：');
    for (const h of list) {
      console.log(`  ${h.scope} — ${h.requestedAt.slice(0, 19)} by ${h.requestedBy}`);
      if (h.reason) console.log(`    原因: ${h.reason}`);
    }
    return 0;
  }

  // ── zelto halt --clear：解除暂停 ────────────────────────────────────
  // 不带 --scope 时解除全部 —— 「全部停」之后要恢复，逐个 scope 去解容易漏
  if (args.includes('--clear')) {
    const scopeIdx = args.indexOf('--scope');
    const hasScope = scopeIdx >= 0;
    const scope = hasScope ? args[scopeIdx + 1] : null;

    if (hasScope && scope) {
      const removed = await halts.clear(scope);
      if (isJson) {
        console.log(JSON.stringify({ scope, cleared: removed }));
        return 0;
      }
      if (!removed) {
        console.log(`没有 scope="${scope}" 的暂停请求（可能已经解除了）。`);
        return 0;
      }
      console.log(`✅ 已解除暂停（scope: ${scope}）`);
      console.log('   重新跑批次即可继续：zelto run --parallel <ids>');
      return 0;
    }

    const removed = await halts.clearAll();
    if (isJson) {
      console.log(JSON.stringify({ cleared: removed.map((r) => r.scope) }));
      return 0;
    }
    if (removed.length === 0) {
      console.log('没有暂停请求（批次在正常跑）。');
      return 0;
    }
    console.log(`✅ 已解除全部暂停（${removed.map((r) => r.scope).join('、')}）`);
    console.log('   重新跑批次即可继续：zelto run --parallel <ids>');
    return 0;
  }

  // ── zelto halt --rollback：回退卡在 running 的切片 ─────────────────
  //
  // 批次进程崩了 / 被 Ctrl-C 杀了的时候，切片永远卡在 `running`，
  // 准入只认 `frozen`，它就再也跑不了。这里把它们强制回退。
  //
  // 不写暂停请求：这些切片对应的批次已经死了，再喊停没有意义，
  // 反而会把后续的批次也挡住。
  if (args.includes('--rollback')) {
    const scopeIdx = args.indexOf('--scope');
    const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : 'all';
    const reasonIdx = args.indexOf('--reason');
    const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : '回退卡死的切片';

    const results = await rollbackStuckSlices(reason, scope);

    if (isJson) {
      console.log(JSON.stringify({ rolledBack: results, reason, scope }, null, 2));
      return 0;
    }

    if (results.length === 0) {
      console.log('没有卡在 running 的切片（批次还活着，或都已处理）。');
      return 0;
    }

    console.log(`↩️  已回退 ${results.length} 个卡在 running 的切片（原因: ${reason}）`);
    for (const r of results) {
      if (r.reverted) {
        console.log(`  ${r.sliceId}: ${r.from} → ${r.to}（stall: human_halt）`);
      } else {
        console.log(`  ${r.sliceId}: 状态未变（${r.from}），已标记 stall: human_halt`);
      }
    }
    console.log('');
    console.log('继续跑：zelto resume <id> → zelto run <id>');
    console.log('写集预约仍保留（C9）：确认现场后再 zelto reservation release <id>。');
    return 0;
  }

  // ── zelto halt：拉闸 ────────────────────────────────────────────────
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : 'all';
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : '人工拉闸';

  const req = await halts.request(scope, 'human', reason);

  await events.append('batch', 'batch.halted', 'human', {
    scope,
    reason,
    haltId: req.id,
    requestedAt: req.requestedAt,
  });

  if (isJson) {
    console.log(JSON.stringify({ halted: true, ...req }, null, 2));
    return 0;
  }

  console.log(`⏸️  已拉闸（scope: ${scope}）`);
  console.log(`   原因: ${reason}`);
  console.log('');
  await printScene();
  console.log('');
  console.log('正在跑的批次会在下一个安全点停下来（不再启动新的 agent，已跑的 agent 会被停掉）。');
  console.log(`处理完之后：zelto halt --clear${scope === 'all' ? '' : ` --scope ${scope}`}`);

  // 顺带留一份快照：现场要能被事后回看（C4）
  try {
    const { captureSnapshot } = await import('./snapshot.js');
    const snap = await captureSnapshot();
    console.log('');
    console.log(`   现场快照: ${snap.id}`);
  } catch {
    // 快照失败不阻断拉闸
  }

  return 0;
});

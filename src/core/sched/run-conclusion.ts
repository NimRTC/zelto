// 「这一轮有没有结论」—— ADR-129 二
//
// 收尾「先落事实、后释放」的**另一半**：判据必须是**事件流**，不是会话文件。
//
// ZD-050：主管在收尾中途消失时，「这一轮结束了」这个事实丢了 ——
// 之后的人只看到 `run.started`，好像这一轮**还在跑**。会话文件的状态
// 由适配器写，写与不写之间有竞态；事件流是 append-only 的唯一证据载体（C4）。
//
// 所以：给定一个 runId，去事件流里找它的**结论**（`run.finished` / `run.aborted`）。
//   - 找到 → 这一轮有结论；
//   - 没找到 → 这一轮没有结论（可能还活着，也可能已经没人管了 ——
//     由调用方结合进程判据决定是「还在跑」还是「需要接管」）。
//
// C3: 纯计算，输入是已经读出来的事件列表。

export interface RunConclusion {
  /** 结论事件类型 */
  type: 'run.finished' | 'run.aborted';
  /** 结论事件里的退出码（没有就是 null） */
  exitCode: number | null;
  /** 结论事件里的原因（aborted 时有） */
  reason: string | null;
  /** 结论事件发生在什么时候（ISO） */
  at: string | null;
}

/** 事件里可能放 runId 的几个位置（不同时期写的 payload 形状略有差别）。 */
type EventLike = {
  type?: unknown;
  ts?: unknown;
  at?: unknown;
  producedAt?: unknown;
  timestamp?: unknown;
  data?: unknown;
  payload?: unknown;
};

function payloadOf(evt: EventLike): Record<string, unknown> {
  const raw = (evt.payload ?? evt.data) as unknown;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function timeOf(evt: EventLike): string | null {
  for (const k of [evt.ts, evt.at, evt.producedAt, evt.timestamp]) {
    if (typeof k === 'string' && k.length > 0) return k;
  }
  return null;
}

/**
 * 在事件列表里找某一轮运行的结论。
 *
 * `runId` 必须**精确**匹配 —— 不做「前缀匹配」：
 * `…/r1` 与 `…/r10` 是两轮，前缀匹配会把它们混成一个。
 *
 * 同时兼容「旧事件没有 runId」：不给 runId 时返回 null
 * （调用方不得据此断言「有结论」，见 ADR-129「不假装配对成功」）。
 */
export function findRunConclusion(
  events: readonly unknown[],
  runId: string | null | undefined,
): RunConclusion | null {
  if (typeof runId !== 'string' || runId.length === 0) return null;
  let found: RunConclusion | null = null;
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const evt = raw as EventLike;
    if (evt.type !== 'run.finished' && evt.type !== 'run.aborted') continue;
    const payload = payloadOf(evt);
    if (payload.runId !== runId) continue;
    const exitCode =
      typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
        ? payload.exitCode
        : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    // 同一 runId 有多条结论（例如主管异常 + 看门狗接管各写一条）→ 取最后一条：
    // 事件流是 append-only，后写的是后来的处置（更接近真相）。
    found = { type: evt.type, exitCode, reason, at: timeOf(evt) };
  }
  return found;
}

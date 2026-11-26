// 运行身份（`runId`）—— ADR-129 一
//
// 「这一轮是谁、有没有结束」必须能被**离线重算**地判出来（C3）：
//
//   - 同一天被拉起五次，事件流里只有两轮有「结束」（ZD-051）；
//   - retry 会话文件可能比主会话**先落盘**，「最新文件」指向的往往是死掉的那一轮。
//
// 所以 runId 由起跑方在**开跑前**算出，并显式贯穿：
//   run.started / run.finished / run.aborted / task.runId
//
// 格式（确定性、可 grep、可离线重算）：
//
//   `<sliceId>#<startedAt 的 ISO 秒>[ /r<attempt> ]`
//   例：v1-rtcp-processor-collaborator#2026-11-26T09:30:12Z
//       v1-rtcp-processor-collaborator#2026-11-26T09:30:12Z/r1
//
// **不用随机 UUID**：随机数无法离线重算，也无法从日志里的时间反推 ——
// 审计时「这一轮到底对应哪条事件」就成了猜。
//
// C3: 纯计算，不读盘、不触网。

/** 把 ISO 时间戳规整到**秒**（去掉毫秒），保证同一轮在不同进程里算出同一个 id。 */
export function runIdStamp(startedAt: string): string {
  // `toISOString()` 总是 `YYYY-MM-DDTHH:mm:ss.sssZ`
  return startedAt.length >= 19 ? `${startedAt.slice(0, 19)}Z` : startedAt;
}

/**
 * 算一轮运行的 runId。
 *
 * @param sliceId 切片 id
 * @param startedAt 起跑时刻（ISO）—— **必须在 agent 起跑之前**取
 * @param attempt 第几次尝试（0 = 首轮；retry 从 1 开始）
 */
export function makeRunId(sliceId: string, startedAt: string, attempt = 0): string {
  const stamp = runIdStamp(startedAt);
  const base = `${sliceId}#${stamp}`;
  return attempt > 0 ? `${base}/r${attempt}` : base;
}

/** 从 runId 里取切片 id（不合法就原样返回）。 */
export function sliceIdFromRunId(runId: string): string {
  const i = runId.indexOf('#');
  return i > 0 ? runId.slice(0, i) : runId;
}

/** 判断一个值是不是「像」runId（给读到旧数据时的健壮性用）。 */
export function looksLikeRunId(value: unknown): value is string {
  return typeof value === 'string' && value.includes('#') && value.length > 2;
}

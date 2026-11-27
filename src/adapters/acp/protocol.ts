// ACP 协议层 —— 版本协商与 stdio 传输（ADR-133）
//
// 这一层只管「怎么跟 agent 子进程说话」：
//
//   1. **版本协商** —— `initialize` 的 protocolVersion 不匹配就**拒绝**
//      （ADR-133 已决：fail closed，不降级）；
//   2. **stdio 传输** —— 把子进程的 stdin/stdout 接成 ACP 的 NDJSON 流。
//
// **判定不在这里** —— 判定在 `src/hook/acp.ts`（ADR-083 §1）。
//
// C1: 状态只在文件里（会话状态由 session-store.ts 落盘）
// C2: 本文件在 `src/adapters/`，允许用第三方包；`core/` 不受影响

import { Readable, Writable } from 'node:stream';
import { PROTOCOL_VERSION, ndJsonStream, type Stream } from '@agentclientprotocol/sdk';

/** ACP 协议版本 —— SDK 里的稳定版常量。 */
export { PROTOCOL_VERSION };

/**
 * ACP 的协议版本是否被 zelto 支持。
 *
 * **不匹配就拒绝**（ADR-133 已决）。
 *
 * 为什么不能「降级」：降级的收益仅限于「某些 ACP agent 多几种通知」，
 * 代价是**把不确定是否支持的请求放过去** —— 与 C9 冲突。
 * 一个说不同版本方言的 agent，它的 `session/request_permission` 语义
 * 未必与我们的理解一致，而我们要靠这个语义拦越界写入。
 */
export function isSupportedProtocolVersion(version: number | undefined): boolean {
  if (typeof version !== 'number' || !Number.isFinite(version)) return false;
  return version === PROTOCOL_VERSION;
}

/** 版本不匹配时的错误信息（人看得懂）。 */
export function protocolVersionError(version: unknown): string {
  return (
    `ACP 协议版本不兼容：agent 报 ${JSON.stringify(version)}，` +
    `zelto 只支持 ${PROTOCOL_VERSION}。` +
    `按 ADR-133 的决定，版本不匹配一律拒绝（fail closed），不降级。`
  );
}

/**
 * 把子进程的 stdin/stdout 接成 ACP 的流。
 *
 * ACP v1 的传输是 **NDJSON**（每行一个 JSON-RPC 消息），不是 Content-Length 分帧。
 *
 * @param stdin 子进程的可写流（Node 的 `Writable`）
 * @param stdout 子进程的可读流（Node 的 `Readable`）
 */
export function createAcpStream(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
): Stream {
  // Node 的 stream → Web Stream 的桥。
  //
  // ACP SDK 的 `ndJsonStream` 吃的是 Web Streams（`ReadableStream<Uint8Array>`），
  // 而子进程给的是 Node 的 stream。Node 有 `Readable.toWeb` / `Writable.toWeb`。
  //
  // ── 为什么这里要 cast ──────────────────────────────────────────
  //
  // `@types/node` 的 `node:stream/web` 自带一份 `ReadableStream` 类型，
  // 而 SDK 引用的是**全局的**那一份（DOM lib）。两者**结构上不兼容**
  // （`getReader().read()` 的 BYOB 重载签名对不上），TS 报 TS2345。
  //
  // 但**运行时它们是同一个对象** —— Node 的 `toWeb()` 返回的就是全局
  // `ReadableStream` 实例。所以这个 cast 是类型层面的对齐，不是绕过检查。
  //
  // 不自己标注返回类型，让 TS 从 SDK 的签名**推断**参数类型 ——
  // 这样 SDK 换了 Web Stream 的定义时，这里会**立刻**报错，
  // 而不是一个被 cast 掩盖的静默不兼容。
  const writable = Writable.toWeb(stdin as unknown as Writable);
  const readable = Readable.toWeb(stdout as unknown as Readable);
  return ndJsonStream(
    writable,
    readable as unknown as Parameters<typeof ndJsonStream>[1],
  );
}

#!/usr/bin/env node
// Mock ACP agent —— 端到端测试用的假 agent（ADR-133 / ADR-140）
//
// 它按 ACP v1 的协议说话：
//   1. 答 `initialize`（版本由 argv 决定，可故意报错版本）
//   2. 答 `session/new` / `session/load` / `session/resume`
//   3. 答 `session/prompt` —— 中途向 client 发 `session/request_permission`
//   4. 收下 client 的答复，把结果写进输出文件
//
// 它**不实现任何工具** —— 它的唯一目的是触发 permission 回调，
// 让测试能验证「zelto 的判定真的在 ACP 通道上生效」。
//
// 用法：
//   node mock-acp-agent.mjs <输出文件> [协议版本] [工具类别] [路径]
//
// 环境变量：
//   MOCK_ACP_SKIP_PERMISSION=1 —— 不发 permission 请求（测「不请求就不判定」）
//   MOCK_ACP_CAPABILITIES=resume|load|new —— 声明会话续跑能力（ADR-140）
//        resume —— 声明 `sessionCapabilities.resume: {}`（支持 session/resume）
//        load   —— 声明 `agentCapabilities.loadSession: true`（支持 session/load）
//        new    —— 什么都不声明（默认：只支持 session/new）
//   MOCK_ACP_LOG=<文件> —— 把收到的方法名逐行写进去（测「发了哪个请求」）
//   MOCK_ACP_HANG_INITIALIZE=1 —— 不回 `initialize` 的包（测请求级超时）
//   MOCK_ACP_HANG_PERMISSION=1 —— 发 permission 请求后**不等待答复**就退出
//        （测终止时的结算，ADR-141）
//   MOCK_ACP_SLOW_START=1 —— 握手后延迟 N 毫秒才发第一条 session/update
//        （测启动阶段豁免空转超时，ADR-143）

import { appendFileSync, writeFileSync } from 'node:fs';

const [outputFile, protocolVersionArg, kindArg, pathArg] = process.argv.slice(2);
const protocolVersion = protocolVersionArg ? Number.parseInt(protocolVersionArg, 10) : 1;
const toolKind = kindArg ?? 'edit';
const toolPath = pathArg ?? '/tmp/whatever.txt';

const skipPermission = process.env.MOCK_ACP_SKIP_PERMISSION === '1';
const capabilityMode = process.env.MOCK_ACP_CAPABILITIES ?? 'new';
const logFile = process.env.MOCK_ACP_LOG ?? null;
const hangInitialize = process.env.MOCK_ACP_HANG_INITIALIZE === '1';
const hangPermission = process.env.MOCK_ACP_HANG_PERMISSION === '1';
const slowStartMs = Number.parseInt(process.env.MOCK_ACP_SLOW_START ?? '0', 10);

/** 往 stdout 发一条 JSON-RPC 消息（NDJSON）。 */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** 把收到的方法名记进日志文件（测「agent 到底收到了哪个请求」）。 */
function logMethod(method) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${method}\n`, 'utf-8');
  } catch {
    /* 日志失败不影响协议 */
  }
}

let nextId = 1;

const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

/** 按 `MOCK_ACP_CAPABILITIES` 拼出 `initialize` 回包里的能力声明。 */
function capabilities() {
  const agentCapabilities = { promptCapabilities: { image: false, audio: false } };
  const sessionCapabilities = {};

  if (capabilityMode === 'resume') {
    // `session/resume` 的能力位 —— 对象存在即支持（`{}` 也算）。
    sessionCapabilities.resume = {};
  } else if (capabilityMode === 'load') {
    // `session/load` 的能力位 —— 顶层布尔。
    agentCapabilities.loadSession = true;
  }

  return { agentCapabilities, sessionCapabilities };
}

async function handle(msg) {
  if (msg.id !== undefined && msg.method === undefined) {
    // 这是 client 答我们的请求（permission 的答复）
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }

  const { id, method, params } = msg;
  logMethod(method);

  switch (method) {
    case 'initialize':
      // 「不回 initialize 的包」—— 测请求级超时（ADR-143 决策五）。
      if (hangInitialize) return;
      {
        const { agentCapabilities, sessionCapabilities } = capabilities();
        reply(id, {
          protocolVersion,
          agentCapabilities,
          sessionCapabilities,
          agentInfo: { name: 'mock-acp-agent', version: '0.0.1' },
        });
      }
      return;

    case 'session/new':
      reply(id, { sessionId: 'mock-session-1' });
      return;

    // ADR-140：真续通道 —— agent 认这两个会话 id。
    case 'session/load':
      reply(id, {});
      return;

    case 'session/resume':
      reply(id, {});
      return;

    case 'session/prompt': {
      // 慢启动（ADR-143）：握手后延迟一段时间才发第一条通知 ——
      // 模拟 agent 在加载 MCP server / 读上下文文件。
      if (slowStartMs > 0) {
        await new Promise((r) => setTimeout(r, slowStartMs));
      }

      // 先报一段输出
      notify('session/update', {
        sessionId: 'mock-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '我要写一个文件。' },
        },
      });

      // 报一次工具调用（进展信号）
      notify('session/update', {
        sessionId: 'mock-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: '写文件',
          kind: toolKind,
          status: 'pending',
          rawInput: { path: toolPath },
          locations: [{ path: toolPath }],
        },
      });

      let outcome = 'skipped';
      if (!skipPermission) {
        try {
          const res = await request('session/request_permission', {
            sessionId: 'mock-session-1',
            toolCall: {
              toolCallId: 'tc-1',
              kind: toolKind,
              name: 'mock_write',
              status: 'pending',
              rawInput: { path: toolPath },
              locations: [{ path: toolPath }],
            },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          });
          outcome = JSON.stringify(res?.outcome ?? null);
        } catch (err) {
          outcome = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // ADR-141：发完 permission 请求就退出，**不等答复** ——
      // 逼 zelto 走终止路径的结算。
      if (hangPermission) {
        appendFileSync(outputFile, `permission-outcome: pending\n`, 'utf-8');
        process.exit(0);
      }

      appendFileSync(outputFile, `permission-outcome: ${outcome}\n`, 'utf-8');

      notify('session/update', {
        sessionId: 'mock-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n[mock] permission → ${outcome}` },
        },
      });

      reply(id, { stopReason: 'end_turn' });
      return;
    }

    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* 坏行忽略 */
    }
  }
});

process.stdin.on('end', () => {
  // 会话结束：把结果落盘
  if (!outputFile) return;
  try {
    writeFileSync(`${outputFile}.meta`, `${JSON.stringify({ protocolVersion })}\n`, 'utf-8');
  } catch {
    /* 忽略 */
  }
  process.exit(0);
});

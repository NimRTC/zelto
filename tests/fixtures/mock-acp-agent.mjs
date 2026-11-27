#!/usr/bin/env node
// Mock ACP agent —— 端到端测试用的假 agent（ADR-133）
//
// 它按 ACP v1 的协议说话：
//   1. 答 `initialize`（版本由 argv 决定，可故意报错版本）
//   2. 答 `session/new`
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

import { appendFileSync, writeFileSync } from 'node:fs';

const [outputFile, protocolVersionArg, kindArg, pathArg] = process.argv.slice(2);
const protocolVersion = protocolVersionArg ? Number.parseInt(protocolVersionArg, 10) : 1;
const toolKind = kindArg ?? 'edit';
const toolPath = pathArg ?? '/tmp/whatever.txt';

const skipPermission = process.env.MOCK_ACP_SKIP_PERMISSION === '1';

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

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
        agentInfo: { name: 'mock-acp-agent', version: '0.0.1' },
      });
      return;

    case 'session/new':
      reply(id, { sessionId: 'mock-session-1' });
      return;

    case 'session/prompt': {
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

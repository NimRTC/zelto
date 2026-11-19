// CursorAgentAdapter 单元测试（ADR-087）
//
// 这个文件钉住四件事：
//
//   1. **NDJSON 事件流解析** —— Cursor 的 stdout 是逐行事件，不是单个 JSON。
//      解析错了 = 拿不到会话 id（续跑不了）、拿不到 token、拿不到最终回答。
//   2. **会话 id 的来源** —— Cursor 的会话 id 是 agent 自己发的
//      （`system/init` 里的 `session_id`），zelto 不能预先指定；
//      拿不到就必须**报错**而不是静默开新会话（上下文清零 = 白干）。
//   3. **用量口径** —— Cursor 报 token，**不报美元**。
//      `getUsage()` 必须返回 null（= 没测到），不能返回 0：
//      0 的意思是「确实没花钱」，而 Cursor 是按额度订阅的，
//      返回 0 等于谎报零成本，预算闸门就成了一道假闸门。
//   4. **命令行旗标** —— 不许用 `-y` / `--yolo`：
//      那等于把 zelto 自己的闸门也一并关掉。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CursorAgentAdapter,
  DEFAULT_CURSOR_COMMAND,
  cursorFlags,
  parseCursorEvent,
  extractCursorText,
  extractCursorTokens,
} from '../src/adapters/cursor-agent/index.js';
import { resolveCursorGateway, mergeAgentEnv } from '../src/cli/commands/shared.js';

const TEST_DIR = join(tmpdir(), 'zelto-cursor-adapter-test');

describe('Cursor NDJSON 事件流解析', () => {
  it('解析一行合法事件', () => {
    const e = parseCursorEvent('{"type":"system","subtype":"init","session_id":"abc-123"}');
    assert.ok(e);
    assert.equal(e.type, 'system');
    assert.equal(e.subtype, 'init');
    assert.equal(e.session_id, 'abc-123');
  });

  it('噪声行返回 null（不炸）', () => {
    assert.equal(parseCursorEvent(''), null);
    assert.equal(parseCursorEvent('   '), null);
    assert.equal(parseCursorEvent('not json'), null);
    assert.equal(parseCursorEvent('[1,2,3]'), null);
    assert.equal(parseCursorEvent('null'), null);
  });

  it('取 assistant 的文本', () => {
    const e = parseCursorEvent(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"做完了"}]}}',
    );
    assert.ok(e);
    assert.equal(extractCursorText(e), '做完了');
  });

  it('assistant 没有 content 时返回空串（不是 undefined）', () => {
    const e = parseCursorEvent('{"type":"assistant"}');
    assert.ok(e);
    assert.equal(extractCursorText(e), '');
  });

  it('取 result 事件的 token 用量', () => {
    const e = parseCursorEvent(
      '{"type":"result","subtype":"success","usage":{"inputTokens":120,"outputTokens":34}}',
    );
    assert.ok(e);
    const tokens = extractCursorTokens(e);
    assert.deepEqual(tokens, { inputTokens: 120, outputTokens: 34 });
  });

  it('没有 usage 时返回 null（= 没测到，不是 0）', () => {
    const e = parseCursorEvent('{"type":"result","subtype":"success","result":"ok"}');
    assert.ok(e);
    assert.equal(extractCursorTokens(e), null);
  });
});

describe('Cursor 命令行旗标', () => {
  it('默认命令是 cursor-agent', () => {
    assert.equal(DEFAULT_CURSOR_COMMAND, 'cursor-agent');
  });

  it('带 stream-json 与 stream-partial-output', () => {
    const flags = cursorFlags();
    assert.ok(flags.includes('--output-format stream-json'));
    assert.ok(flags.includes('--stream-partial-output'));
    assert.ok(flags.includes('-p'));
  });

  it('**不许**带 -y / --yolo（那会把 zelto 的闸门也关掉）', () => {
    const flags = cursorFlags();
    assert.ok(!/(^|\s)-y(\s|$)/.test(flags), '不许用 -y');
    assert.ok(!flags.includes('--yolo'), '不许用 --yolo');
  });

  it('续跑时加 --resume', () => {
    const flags = cursorFlags(['--resume', 'chat-42']);
    assert.ok(flags.includes('--resume chat-42'));
  });
});

// ─── ADR-090：凭据透传 ──────────────────────────────────────────────────────

describe('Cursor 网关 / 凭证透传（ADR-090）', () => {
  it('什么都不传时，旗标与 ADR-087 完全一致（向后兼容）', () => {
    const legacy = [
      '-p',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--force',
      '--trust',
    ].join(' ');
    assert.equal(cursorFlags(), legacy);
    assert.equal(cursorFlags([], {}), legacy);
    assert.equal(cursorFlags([], { endpoint: '', apiKey: '' }), legacy);
  });

  it('endpoint 落成 --endpoint', () => {
    const flags = cursorFlags([], { endpoint: 'https://gw.example.com' });
    // 引号类型随平台（Windows cmd 双引号 / POSIX 单引号）——
    // 断言「被某种引号包裹且内容原样」，而不是写死某种引号（ADR-090 修复）。
    assert.match(flags, /--endpoint ["']https:\/\/gw\.example\.com["']/);
  });

  it('apiKey 落成 --api-key', () => {
    const flags = cursorFlags([], { apiKey: 'sk-test-123' });
    assert.match(flags, /--api-key ["']sk-test-123["']/);
  });

  it('端点里的 shell 元字符被引号挡住（配置是不可信输入）', () => {
    const flags = cursorFlags([], { endpoint: 'https://gw.example.com/a&b|c' });
    // 整个值被包在引号里 —— shell 不会把它拆成两条命令。
    // 引号类型随平台，断言「被引号包裹」即可。
    assert.match(flags, /["']https:\/\/gw\.example\.com\/a&b\|c["']/);
  });

  it('endpoint / apiKey 排在固定旗标之后、额外参数之前', () => {
    const flags = cursorFlags(['--resume', 'chat-1'], {
      endpoint: 'https://gw.example.com',
      apiKey: 'k',
    });
    const iTrust = flags.indexOf('--trust');
    const iEndpoint = flags.indexOf('--endpoint');
    const iResume = flags.indexOf('--resume');
    assert.ok(iTrust < iEndpoint, '--trust 在 --endpoint 之前');
    assert.ok(iEndpoint < iResume, '--endpoint 在 --resume 之前');
  });
});

describe('resolveCursorGateway / mergeAgentEnv（ADR-090）', () => {
  it('没配置就返回空对象 —— 完全交给 CLI 登录态', () => {
    assert.deepEqual(resolveCursorGateway(undefined, undefined, {}), {});
    assert.deepEqual(resolveCursorGateway({}, {}, {}), {});
  });

  it('endpoint 原样透传', () => {
    const gw = resolveCursorGateway({ endpoint: 'https://gw.example.com' }, undefined, {});
    assert.equal(gw.endpoint, 'https://gw.example.com');
    assert.equal(gw.apiKey, undefined);
  });

  it('apiKeyEnv 从环境变量取值 —— 配置里不存密钥', () => {
    const gw = resolveCursorGateway(
      { apiKeyEnv: 'MY_CURSOR_KEY' },
      undefined,
      { MY_CURSOR_KEY: 'sk-from-env' },
    );
    assert.equal(gw.apiKey, 'sk-from-env');
  });

  it('agent.env 里的值优先于 process.env', () => {
    const gw = resolveCursorGateway(
      { apiKeyEnv: 'MY_CURSOR_KEY' },
      { MY_CURSOR_KEY: 'sk-from-config-env' },
      { MY_CURSOR_KEY: 'sk-from-shell' },
    );
    assert.equal(gw.apiKey, 'sk-from-config-env');
  });

  it('apiKeyEnv 指向的变量不存在 → 不产出 apiKey（不是空串）', () => {
    const gw = resolveCursorGateway({ apiKeyEnv: 'MISSING_VAR' }, undefined, {});
    assert.equal(gw.apiKey, undefined);
  });

  it('apiKeyEnv 指向空值 → 不产出 apiKey', () => {
    const gw = resolveCursorGateway({ apiKeyEnv: 'EMPTY_VAR' }, undefined, { EMPTY_VAR: '   ' });
    assert.equal(gw.apiKey, undefined);
  });

  it('mergeAgentEnv 不改动传入的 base', () => {
    const base = { A: '1', B: '2' };
    const merged = mergeAgentEnv({ B: 'overridden' }, base);
    assert.equal(merged.A, '1');
    assert.equal(merged.B, 'overridden');
    assert.equal(base.B, '2', 'base 必须没被改');
  });

  it('mergeAgentEnv 没有 agent.env 时原样返回 base', () => {
    const base = { A: '1' };
    assert.equal(mergeAgentEnv(undefined, base), base);
    assert.equal(mergeAgentEnv({}, base), base);
  });
});

describe('CursorAgentAdapter', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('有正确的元数据', () => {
    const adapter = new CursorAgentAdapter();
    assert.equal(adapter.name, 'cursor-agent');
    assert.equal(adapter.metadata.capabilities.resume, true);
    assert.equal(adapter.metadata.capabilities.events, false);
  });

  it('getUsage() 返回 null —— Cursor 不报美元，不能谎报零成本', () => {
    const adapter = new CursorAgentAdapter();
    assert.equal(adapter.getUsage('whatever'), null);
  });

  it('跑一次假 agent：从 stdin 读到提示词，并吐出 NDJSON', async () => {
    // 造一个假的 cursor-agent：读 stdin，把提示词回显成 NDJSON 事件流。
    const fake = join(TEST_DIR, 'fake-cursor.js');
    await writeFile(
      fake,
      [
        "const chunks = [];",
        "process.stdin.on('data', (c) => chunks.push(c));",
        "process.stdin.on('end', () => {",
        "  const prompt = Buffer.concat(chunks).toString('utf-8');",
        "  process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fake-chat-1',model:'test-model'}) + '\\n');",
        "  process.stdout.write(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'收到:'+prompt.trim()}]}}) + '\\n');",
        "  process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'done',usage:{inputTokens:7,outputTokens:3}}) + '\\n');",
        "});",
      ].join('\n'),
      'utf-8',
    );

    const adapter = new CursorAgentAdapter({
      // 引号：Windows 上 node.exe 的路径带空格，
      // 不加引号 shell 会把 "C:\Program" 当成命令。
      agentCommand: `"${process.execPath}" "${fake}"`,
      cwd: TEST_DIR,
      timeoutMs: 30_000,
    });

    const { sessionId } = await adapter.start({
      sliceId: 'cursor-test',
      prompt: '请做这件事',
    });

    const exitCode = await adapter.waitForExit(sessionId);
    assert.equal(exitCode, 0);

    // 最终回答取自 result 事件
    assert.equal(adapter.getOutput(sessionId), 'done');

    // agent 自己发的会话 id 被记住了 —— 续跑靠它
    assert.equal(adapter.getAgentSessionId(sessionId), 'fake-chat-1');

    // token 用量单独可查
    const tokens = adapter.getTokenUsage(sessionId);
    assert.equal(tokens?.inputTokens, 7);
    assert.equal(tokens?.outputTokens, 3);
  });

  it('拿不到 agent 会话 id 时 resume() 报错（不静默开新会话）', async () => {
    // 一个什么都不输出的假 agent —— 永远不会有 system/init。
    const fake = join(TEST_DIR, 'silent-cursor.js');
    await writeFile(fake, "process.stdin.resume();\nsetTimeout(()=>process.exit(0), 100);\n", 'utf-8');

    const adapter = new CursorAgentAdapter({
      agentCommand: `"${process.execPath}" "${fake}"`,
      cwd: TEST_DIR,
      timeoutMs: 30_000,
    });

    const { sessionId } = await adapter.start({ sliceId: 'cursor-silent', prompt: 'x' });
    await adapter.waitForExit(sessionId);

    // 静默开新会话 = 上下文清零 = agent 已做掉的事全作废（ADR-013 §3.4）。
    await assert.rejects(
      () => adapter.resume(sessionId, '人回答了'),
      /no Cursor chat id/,
    );
  });
});

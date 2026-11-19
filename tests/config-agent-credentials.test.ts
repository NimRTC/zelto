// ADR-090：agent.env / agent.cursor 的配置解析。
//
// 关注点不是「能不能解析出来」，而是**解析不会污染相邻的结构** ——
// 手写状态机最容易出的是「env 底下的键把 agent 顶层的键吃掉」这类 bug，
// 那会让 timeout: 静默变成环境变量、或者 env 被误当成 section 而整段丢失。
//
// 注意：`parseConfigYaml` 只在存在 gate.commands / profiles / acceptance /
// llm / targetProject / web 时才返回对象，所以每个用例都带一段 gate。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigYaml } from '../src/cli/commands/shared.js';

/** 加一段最小的 gate，让 parseConfigYaml 返回配置对象。 */
function withGate(body: string[]): string {
  return ['gate:', '  - name: t', '    run: echo ok', ...body].join('\n');
}

describe('parseConfigYaml — agent.env（ADR-090）', () => {
  it('解析出多个环境变量', () => {
    const yaml = withGate([
      'agent:',
      '  adapter: cursor-agent',
      '  env:',
      '    CURSOR_API_KEY: sk-test',
      '    CURSOR_API_ENDPOINT: https://gw.example.com',
    ]);

    const cfg = parseConfigYaml(yaml);
    assert.ok(cfg);
    assert.deepEqual(cfg.agent.env, {
      CURSOR_API_KEY: 'sk-test',
      CURSOR_API_ENDPOINT: 'https://gw.example.com',
    });
  });

  it('带引号的值去掉引号', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  env:', '    K: "value with spaces"']));
    assert.equal(cfg?.agent.env?.K, 'value with spaces');
  });

  it('**不吞** agent 顶层的 timeout / maxRetries', () => {
    const yaml = withGate([
      'agent:',
      '  adapter: cursor-agent',
      '  env:',
      '    K: v',
      '  timeout: 60',
      '  maxRetries: 5',
    ]);

    const cfg = parseConfigYaml(yaml);
    const env: Record<string, string> = cfg?.agent.env ?? {};
    // 关键：timeout / maxRetries 不许被当成环境变量。
    assert.equal(env.timeout, undefined);
    assert.equal(env.maxRetries, undefined);
    assert.deepEqual(env, { K: 'v' });
    assert.equal(cfg?.agent.timeout, 60);
    assert.equal(cfg?.agent.maxRetries, 5);
  });

  it('空值不注入（不是注入空串）', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  env:', '    EMPTY:', '    K: v']));
    assert.deepEqual(cfg?.agent.env, { K: 'v' });
  });

  it('env 后面跟另一个段，不串味', () => {
    const yaml = withGate([
      'agent:',
      '  env:',
      '    K: v',
      'llm:',
      '  provider: deepseek',
      '  apiKey: abc',
    ]);

    const cfg = parseConfigYaml(yaml);
    assert.deepEqual(cfg?.agent.env, { K: 'v' });
    assert.equal(cfg?.llm?.provider, 'deepseek');
    assert.equal(cfg?.llm?.apiKey, 'abc');
  });

  it('没有 env 段时不产出 env 字段（不是空对象）', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  adapter: cursor-agent']));
    assert.equal(cfg?.agent.env, undefined);
  });
});

describe('parseConfigYaml — agent.cursor（ADR-090）', () => {
  it('解析 endpoint 与 apiKeyEnv', () => {
    const yaml = withGate([
      'agent:',
      '  adapter: cursor-agent',
      '  cursor:',
      '    endpoint: https://gw.example.com',
      '    apiKeyEnv: MY_CURSOR_KEY',
    ]);

    const cfg = parseConfigYaml(yaml);
    assert.equal(cfg?.agent.cursor?.endpoint, 'https://gw.example.com');
    assert.equal(cfg?.agent.cursor?.apiKeyEnv, 'MY_CURSOR_KEY');
  });

  it('只配 endpoint 时 apiKeyEnv 不存在', () => {
    const cfg = parseConfigYaml(
      withGate(['agent:', '  cursor:', '    endpoint: https://gw.example.com']),
    );
    assert.equal(cfg?.agent.cursor?.endpoint, 'https://gw.example.com');
    assert.equal(cfg?.agent.cursor?.apiKeyEnv, undefined);
  });

  it('cursor 与 env 同时存在，互不干扰', () => {
    const yaml = withGate([
      'agent:',
      '  env:',
      '    A: "1"',
      '  cursor:',
      '    endpoint: https://gw.example.com',
      '  timeout: 30',
    ]);

    const cfg = parseConfigYaml(yaml);
    assert.deepEqual(cfg?.agent.env, { A: '1' });
    assert.equal(cfg?.agent.cursor?.endpoint, 'https://gw.example.com');
    assert.equal(cfg?.agent.timeout, 30);
  });

  it('没有 cursor 段时不产出 cursor 字段', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  adapter: cursor-agent']));
    assert.equal(cfg?.agent.cursor, undefined);
  });

  it('apiKey 不能直接写进配置（只认 apiKeyEnv 变量名）', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  cursor:', '    apiKey: sk-leaked']));
    // 认不出的键不入库 —— 密钥不该躺在配置文件里。
    assert.equal(cfg?.agent.cursor?.endpoint, undefined);
    assert.equal(cfg?.agent.cursor?.apiKeyEnv, undefined);
  });
});

describe('parseConfigYaml — ADR-090 向后兼容', () => {
  it('没有 env / cursor 的老配置解析结果不变', () => {
    const yaml = withGate([
      'agent:',
      '  adapter: claude-agent',
      '  command: npx claude-code',
      '  timeout: 900',
    ]);

    const cfg = parseConfigYaml(yaml);
    assert.equal(cfg?.agent.adapter, 'claude-agent');
    assert.equal(cfg?.agent.command, 'npx claude-code');
    assert.equal(cfg?.agent.timeout, 900);
    assert.equal(cfg?.agent.env, undefined);
    assert.equal(cfg?.agent.cursor, undefined);
  });
});

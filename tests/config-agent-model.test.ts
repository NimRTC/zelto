// `agent.model` —— agent 执行用的模型，**与 `llm.model`（规格起草）是两回事**。
//
// 为什么必须分开（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
//   `claude-agent-sdk` 适配器原先拿 `llm.model` 当 agent 的模型 ——
//   而 `llm.model` 是**规格起草**用的模型（nimrtc 那边配的是
//   `deepseek-ai/DeepSeek-V3`，走自建网关）。
//
//   Claude Code 不认识那个模型名 → agent **秒退**（exit 0、无输出、零改动）。
//   症状极像「agent 干了活但没改文件」，而真正原因是「模型名不认，agent 根本没跑起来」。
//
//   代价是**整轮**（agent 跑 10 秒 → 门禁报「vendor 缺失」→
//   人以为是自己代码的问题）。这种错误必须当场显形。
//
// 所以：agent 的模型单独配，不与 `llm.model` 混用；不配 = 用 Claude Code 自己的默认。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigYaml } from '../src/cli/commands/shared.js';

/** 加一段最小的 gate，让 parseConfigYaml 返回配置对象。 */
function withGate(body: string[]): string {
  return ['gate:', '  - name: t', '    run: echo ok', ...body].join('\n');
}

describe('parseConfigYaml — agent.model（agent 模型 ≠ 规格起草模型）', () => {
  it('解析出 agent.model', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  model: claude-sonnet-4-5']));
    assert.equal(cfg?.agent.model, 'claude-sonnet-4-5');
  });

  it('带引号的值去掉引号', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  model: "claude-opus-4-1"']));
    assert.equal(cfg?.agent.model, 'claude-opus-4-1');
  });

  it('**不吞** agent 顶层的 timeout / maxRetries', () => {
    const cfg = parseConfigYaml(
      withGate(['agent:', '  model: claude-sonnet-4-5', '  timeout: 60', '  maxRetries: 5']),
    );
    assert.equal(cfg?.agent.model, 'claude-sonnet-4-5');
    assert.equal(cfg?.agent.timeout, 60);
    assert.equal(cfg?.agent.maxRetries, 5);
  });

  it('没有 model 时不产出 model 字段（不是空串）', () => {
    const cfg = parseConfigYaml(withGate(['agent:', '  adapter: claude-agent']));
    assert.equal(cfg?.agent.model, undefined);
  });

  it('agent.model 与 llm.model 互不干扰（各管各的）', () => {
    const cfg = parseConfigYaml(
      withGate([
        'agent:',
        '  model: claude-sonnet-4-5',
        'llm:',
        '  provider: deepseek',
        '  model: deepseek-ai/DeepSeek-V3',
        '  apiKey: abc',
      ]),
    );
    // agent 跑用 claude，规格起草用 deepseek —— 两者本就该分开。
    assert.equal(cfg?.agent.model, 'claude-sonnet-4-5');
    assert.equal(cfg?.llm?.model, 'deepseek-ai/DeepSeek-V3');
  });

  it('agent.model 不被 llm 段的存在与否影响（不隐式回落）', () => {
    // 不配 agent.model 时**不**隐式回落到 llm.model ——
    // 那正是「agent 秒退」这个坑的来源。
    const cfg = parseConfigYaml(
      withGate(['llm:', '  provider: deepseek', '  model: deepseek-ai/DeepSeek-V3', '  apiKey: abc']),
    );
    assert.equal(cfg?.agent.model, undefined);
  });
});

// D-27 的回归测试：`--agent` 拼错时，错误信息要指向**正确的那条命令**。
//
// 缺陷现象（第二轮演练，nimrtc-zelto）：
//
//   $ zelto run v1-engineimpl --agent claude-code
//   ❌ Agent command "claude-code" not found. Install it or update
//      .zelto/config.yaml agent.command.
//
// 而**配置里的命令是对的**（`npx @anthropic-ai/claude-code`），
// 错的只是命令行这一次的临时覆盖。
//
// 旧信息让人去改 `.zelto/config.yaml` —— 改一个本来没问题的文件，
// 改完还是错。**错误信息把人引向错误的方向。**
//
// 修好之后，错误信息必须：
//   1. 说清配置里那条命令是什么（那才是能用的）
//   2. 说清这次错在命令行覆盖，不在配置

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeMissingAgent } from '../src/adapters/claude-agent/index.js';

describe('D-27：agent 命令找不到时的错误信息', () => {
  it('配置里有别的命令 → 指出配置里那条', () => {
    const msg = describeMissingAgent('claude-code', 'npx @anthropic-ai/claude-code');
    assert.ok(
      msg.includes('npx @anthropic-ai/claude-code'),
      `错误信息必须给出配置里的命令，实际：${msg}`,
    );
  });

  it('配置里有别的命令 → 说清错在命令行覆盖，不在配置', () => {
    const msg = describeMissingAgent('claude-code', 'npx @anthropic-ai/claude-code');
    assert.ok(msg.includes('--agent'), `错误信息必须点明是命令行的 --agent，实际：${msg}`);
  });

  it('配置里有别的命令 → 不再让人去改 config.yaml', () => {
    // 关键断言：旧信息会把人引向「改 config.yaml」这个错误方向
    const msg = describeMissingAgent('claude-code', 'npx @anthropic-ai/claude-code');
    assert.ok(
      !msg.includes('update .zelto/config.yaml'),
      `命令行覆盖拼错时不该让人去改 config.yaml，实际：${msg}`,
    );
  });

  it('配置里的命令与这次相同 → 仍然让人去改 config.yaml / 装它', () => {
    // 配置本身就不对时，指向 config.yaml 是对的
    const msg = describeMissingAgent('npx @anthropic-ai/claude-code', 'npx @anthropic-ai/claude-code');
    assert.ok(
      msg.includes('update .zelto/config.yaml'),
      `配置本身就是那条错命令时，应指向 config.yaml，实际：${msg}`,
    );
  });

  it('没有配置里的命令可比 → 退回旧提示', () => {
    const msg = describeMissingAgent('claude-code');
    assert.ok(
      msg.includes('update .zelto/config.yaml'),
      `没有可比配置时应指向 config.yaml，实际：${msg}`,
    );
  });

  it('错误信息里包含找不到的那个命令本身', () => {
    const msg = describeMissingAgent('claude-code', 'npx @anthropic-ai/claude-code');
    assert.ok(
      msg.includes('"claude-code"'),
      `错误信息必须点名找不到的命令，实际：${msg}`,
    );
  });
});

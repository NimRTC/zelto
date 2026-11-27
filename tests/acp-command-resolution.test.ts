// ACP 的命令解析 —— 「adapter 决定跑的是谁」（ADR-133）
//
// 这个文件钉住一件事：**`--adapter acp` 时，zelto 起的是 ACP agent，
// 不是 Claude**。
//
// 病灶（实测 2026-11-27，ADR-133 落地时发现）：
// `resolveAgentCommand` 只认 `cursor-agent`，其它一律落回 `cfg.agent.command`
// （默认 `npx claude-code`）。于是 `zelto run --adapter acp` 会：
//
//   - 界面上显示 `Agent: npx claude-code`（错的）；
//   - 预检去查 `where npx`（查的不是真要跑的东西）；
//   - 而适配器实际起的是 `agent.acp.command` —— **三处不一致**。
//
// 这种「显示的、查的、跑的不是一个东西」的 bug 极难查：
// 界面看不出问题，跑起来才发现连的不是 ACP。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAcpCommand,
  resolveAgentCommand,
  validateAdapterName,
  writeGuardForAdapter,
  harnessForAdapter,
} from '../src/cli/commands/shared.js';

const CFG = {
  agent: {
    command: 'npx claude-code',
    acp: { command: 'cursor-agent acp' },
  },
};

describe('ACP 命令解析 —— adapter 决定跑的是谁', () => {
  it('resolveAgentCommand 认 acp → 用 agent.acp.command', () => {
    assert.equal(
      resolveAgentCommand('acp', undefined, CFG),
      'cursor-agent acp',
      'ACP 绝不能落回 cfg.agent.command（那是 Claude）',
    );
  });

  it('ACP 没配 agent.acp.command → 用默认值', () => {
    const cfg = { agent: { command: 'npx claude-code' } };
    const fallback = resolveAcpCommand({ agent: {} });
    assert.ok(fallback.length > 0);
    assert.equal(resolveAgentCommand('acp', undefined, cfg), fallback);
  });

  it('显式覆盖优先于配置（--agent 不能被静默忽略）', () => {
    assert.equal(
      resolveAgentCommand('acp', 'my-acp-agent', CFG),
      'my-acp-agent',
      '显式传的 --agent 必须生效',
    );
  });

  it('既有 adapter 的解析不受影响', () => {
    assert.equal(resolveAgentCommand('cursor-agent', undefined, CFG), 'cursor-agent');
    assert.equal(resolveAgentCommand('claude-agent', undefined, CFG), 'npx claude-code');
    assert.equal(resolveAgentCommand(undefined, undefined, CFG), 'npx claude-code');
  });
});

describe('C9 主判定点与 harness 的对照', () => {
  it('acp → permission', () => {
    assert.equal(writeGuardForAdapter('acp'), 'permission');
  });

  it('其它 adapter → hook（既有行为不变）', () => {
    assert.equal(writeGuardForAdapter('claude-agent'), 'hook');
    assert.equal(writeGuardForAdapter('claude-agent-sdk'), 'hook');
    assert.equal(writeGuardForAdapter('cursor-agent'), 'hook');
    assert.equal(writeGuardForAdapter(undefined), 'hook');
  });

  it('harness 仍是既有那三个（ACP 不装钩子，所以无所谓）', () => {
    assert.equal(harnessForAdapter('claude-agent'), 'claude-code');
    assert.equal(harnessForAdapter('cursor-agent'), 'cursor');
    assert.equal(harnessForAdapter('codex'), 'codex');
  });
});

describe('--adapter 的取值校验 —— 认不出的值当场报错', () => {
  it('没给 --adapter → 不报错', () => {
    assert.equal(validateAdapterName(undefined), null);
  });

  it('四个合法值都通过', () => {
    for (const name of ['claude-agent', 'claude-agent-sdk', 'cursor-agent', 'acp']) {
      assert.equal(validateAdapterName(name), null, `${name} 应合法`);
    }
  });

  it('打错字 → 报错，且**不**静默落回 claude-agent', () => {
    for (const typo of ['acpp', 'cursor', 'Cursor-Agent', 'claude', '']) {
      const err = validateAdapterName(typo);
      assert.notEqual(err, null, `"${typo}" 应被拒`);
      assert.match(String(err), /claude-agent \| claude-agent-sdk \| cursor-agent \| acp/);
    }
  });

  it('错误信息点名是哪个值错了', () => {
    assert.match(String(validateAdapterName('acpp')), /acpp/);
  });
});

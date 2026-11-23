// 未展开的 `${VAR}` 占位符必须**剔除**出 agent 的 spawn env。
//
// 实测 nimrtc-v14 v1-ice-recovery（2026-11-23）：
//   进程环境里残留了 `ANTHROPIC_API_KEY="${NIMRTC_LLM_API_KEY}"`（字面量，没展开）。
//
//   Claude Code 的取凭据顺序是 `ANTHROPIC_API_KEY` **优先于** `ANTHROPIC_AUTH_TOKEN`
//   （后者在 `~/.claude/settings.json` 的 `env` 块里，本来是好的）。
//   于是这个占位符**顶掉了**一个能用的 token → 上游 401 → agent 秒退
//   （exit 1、`api_error_status: 401`、零改动）。
//
//   症状极像「agent 干了活但没改文件」，真正原因却是「凭据没生效」。
//   代价是**整轮**：agent 跑 3 分钟 → 门禁报 vendor 缺失 → 人怀疑自己的代码。
//
// 所以：值是 `${VAR}` 形状就当它不存在，让 Claude Code 回落到
// `ANTHROPIC_AUTH_TOKEN` → `~/.claude/settings.json` → `~/.claude/.credentials.json`。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAgentEnv, stripUnexpandedEnvRefs } from '../src/cli/commands/shared.js';

describe('stripUnexpandedEnvRefs — 未展开的 ${VAR} 占位符', () => {
  it('剔除整串是 ${VAR} 的值', () => {
    const out = stripUnexpandedEnvRefs({
      ANTHROPIC_API_KEY: '${NIMRTC_LLM_API_KEY}',
      OTHER: 'keep',
    });
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.OTHER, 'keep');
  });

  it('引用目标**存在**时也剔除（值本该是展开后的真值）', () => {
    // 引用目标存在时，值仍没展开 = 没生效的占位符 → 一样剔。
    const out = stripUnexpandedEnvRefs({ K: '${SOME_VAR}' });
    assert.equal(out.K, undefined);
  });

  it('**不剔**部分引用（prefix-${VAR} 是刻意拼的字符串）', () => {
    const out = stripUnexpandedEnvRefs({ K: 'prefix-${VAR}' });
    assert.equal(out.K, 'prefix-${VAR}');
  });

  it('**不剔**含 ${} 但非纯引用的普通值', () => {
    const out = stripUnexpandedEnvRefs({ K: 'a${b}c', J: '$VAR', L: '${}' });
    assert.equal(out.K, 'a${b}c');
    assert.equal(out.J, '$VAR');
    assert.equal(out.L, '${}');
  });

  it('**带引号**的占位符也算（实测：set VAR="${OTHER}" 没展开）', () => {
    // 实测 nimrtc-v14（2026-11-23）：进程环境里残留的是
    //   ANTHROPIC_API_KEY = "${NIMRTC_LLM_API_KEY}"（连引号一起）。
    // 那是有人用 `set VAR="${OTHER}"` 赋值、而 OTHER 没展开留下的。
    const out = stripUnexpandedEnvRefs({
      ANTHROPIC_API_KEY: '"${NIMRTC_LLM_API_KEY}"',
      ANTHROPIC_AUTH_TOKEN: 'sk-real',
    });
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'sk-real');
  });

  it('**不剔**不成对的引号（那不是占位符）', () => {
    const out = stripUnexpandedEnvRefs({ K: '"${VAR}' });
    assert.equal(out.K, '"${VAR}');
  });

  it('保留非字符串值（undefined 之类）', () => {
    // ProcessEnv 里 undefined 是合法的（= 不设置该变量）——
    // 剔除只针对「${VAR} 形状的字符串」，不碰其它键。
    const out = stripUnexpandedEnvRefs({ A: undefined, B: 'ok' });
    assert.equal(out.A, undefined);
    assert.equal(out.B, 'ok');
  });
});

describe('mergeAgentEnv — 剔除占位符（ADR-090 + 实测修复）', () => {
  it('剔掉 process.env 里的未展开占位符', () => {
    const out = mergeAgentEnv(undefined, {
      ANTHROPIC_API_KEY: '${NIMRTC_LLM_API_KEY}',
      ANTHROPIC_AUTH_TOKEN: 'sk-real',
    } as NodeJS.ProcessEnv);
    // 占位符不许顶掉能用的 token。
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'sk-real');
  });

  it('agent.env 里的占位符也剔（agent.env 覆盖 process.env）', () => {
    const out = mergeAgentEnv(
      { ANTHROPIC_API_KEY: '${NIMRTC_LLM_API_KEY}' },
      { ANTHROPIC_AUTH_TOKEN: 'sk-real' } as NodeJS.ProcessEnv,
    );
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'sk-real');
  });

  it('正常值照常合并（不误伤）', () => {
    const out = mergeAgentEnv(
      { NIMRTC_TURN_URI: 'turns:127.0.0.1:5349' },
      { PATH: 'x' } as NodeJS.ProcessEnv,
    );
    assert.equal(out.NIMRTC_TURN_URI, 'turns:127.0.0.1:5349');
    assert.equal(out.PATH, 'x');
  });

  it('agent.env 的真实值**不被** process.env 的占位符顶掉', () => {
    // 优先级仍是 process.env < agent.env（ADR-090）——
    // 剔除只针对「占位符形状」，不改变覆盖方向。
    const out = mergeAgentEnv(
      { ANTHROPIC_API_KEY: 'sk-agent-env-real' },
      { ANTHROPIC_API_KEY: '${PLACEHOLDER}' } as NodeJS.ProcessEnv,
    );
    assert.equal(out.ANTHROPIC_API_KEY, 'sk-agent-env-real');
  });

  it('没有占位符时**原样返回** base（不无谓拷贝）', () => {
    // 既有契约（cursor-agent-adapter.test.ts 依赖它）：
    // 没有 agent.env 且没有占位符 → 返回的就是 base 本身。
    const base = { A: '1' } as NodeJS.ProcessEnv;
    assert.equal(mergeAgentEnv(undefined, base), base);
    assert.equal(mergeAgentEnv({}, base), base);
  });
});

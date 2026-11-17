// ADR-074：Claude Code 启动噪声（[claude-code:*]）的识别
//
// 背景（实测于 nimrtc-zelto）：接自定义网关时 ANTHROPIC_MODEL 不在
// Claude Code 内置模型表里，它每次启动都打一行
//   [claude-code:unrecognized_model] {"model":"deepseek-v4-flash-anthropic",...}
// 这一行**不导致失败**（退出码 0、结果完整），却会霸占会话文件的「最后一条输出」，
// 驾驶舱于是把噪声显示成「进度」。适配器按下面的判据把它压住，
// 失败时再补回（运行成功的事实由退出码与 run.finished 记录，不需要噪声陪葬）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isStartupNoise } from '../src/adapters/claude-agent/index.js';

describe('ADR-074 isStartupNoise', () => {
  it('单行的 [claude-code:*] 诊断是噪声', () => {
    assert.equal(
      isStartupNoise('[claude-code:unrecognized_model] {"model":"deepseek-v4-flash-anthropic","query_source":"sdk"}\n'),
      true,
    );
  });

  it('多行但全是 [claude-code:*] 也是噪声', () => {
    assert.equal(
      isStartupNoise('[claude-code:a] one\n[claude-code:b] two\n'),
      true,
    );
  });

  it('混有真实输出就不算噪声', () => {
    assert.equal(
      isStartupNoise('[claude-code:unrecognized_model] {...}\nError: build failed\n'),
      false,
    );
  });

  it('普通错误不是噪声 —— 不能被吞掉', () => {
    assert.equal(isStartupNoise('Error: ENOENT: no such file\n'), false);
  });

  it('空块不是噪声', () => {
    assert.equal(isStartupNoise('\n  \n'), false);
  });
});

// D-55 补：等待的截止时间也得是「空转」判据，不是绝对上限
//
// 病灶（实测 nimrtc-zelto v3-weaknet-verdict，2026-11-18）：
//
// agent 连续推进了 31 分钟 —— 事件流每几秒就多一条 hook 判定，
// 它一直在干活、一直在改文件。
//
// 但它在 `timeoutMs + 60_000`（= 30min + 1min）那一刻被砍了：
//
//   [18:18:24] agent 已退出，但会话文件里没有退出码 —— 结果不明，按失败处理
//   [18:18:24] stall.classified  class=environment_failure  autoRetry=true
//
// 根因：D-55 只改了**适配器**那一层的倒计时（`markProgress` →
// `resetIdleTimer`），监督进程**自己**的等待截止时间还是一刀切的绝对上限：
//
//   const deadline = Date.now() + args.timeoutMs + 60_000;
//
// **两层各有一个倒计时，只改一层 = 没改。**
//
// 这跟 D-56（看门狗路径漏了 progress）是同一个形态：
// 「每条路径都接上了」不等于「每条路径都测过了」。
// 两处都是在真实项目上跑一遍才看见的 —— 单测全绿，因为单测测的是
// 「这一层接上了吗」，而病是「另一层没接」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 断言源码层面：监督进程在**有进展时**把截止时间往后推。
 *
 * 为什么用源码断言而不是运行时断言：
 * 运行时断言要真的等 30 分钟 —— 不可接受。
 * 而这里的病恰恰是「代码没写」—— 源码断言抓得住。
 */
describe('D-55 补：监督进程的等待截止时间随进展推后', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'cli', 'commands', 'supervisor.ts'),
    'utf-8',
  );

  it('截止时间不是 const —— 必须能被推后', () => {
    assert.match(
      source,
      /let\s+deadline\s*=\s*Date\.now\(\)/,
      '截止时间必须是 let —— const 推不后，进展一来就还是被砍',
    );
  });

  it('有进展时同时推后「等待截止时间」和「适配器空转倒计时」', () => {
    // 两层倒计时必须一起推 —— 只改一层 = 没改（实测 v3-weaknet-verdict）
    const pollBlock = source.match(
      /if\s*\(\s*progress\.poll\(\)\s*\)\s*\{([\s\S]{0,600}?)\n\s{4}\}/,
    );
    assert.ok(pollBlock, '应当能找到进展探针的判定块');

    const body = pollBlock[1];
    assert.match(
      body,
      /markProgress/,
      '适配器那一层的空转倒计时要推后（D-55 原版）',
    );
    assert.match(
      body,
      /deadline\s*=\s*Date\.now\(\)/,
      '监督进程这一层的截止时间也要推后 —— 这是实测漏掉的那一半',
    );
  });

  it('推后用的还是同一个超时上限（不是无限延长）', () => {
    // 有进展就一直等是对的，但上限本身不能被改 ——
    // `args.timeoutMs` 来自配置，是人定的边界。
    assert.match(
      source,
      /deadline\s*=\s*Date\.now\(\)\s*\+\s*args\.timeoutMs/,
      '推后必须用同一个配置上限，不能换成别的数',
    );
  });
});

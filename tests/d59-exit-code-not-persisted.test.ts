// D-59：agent 明明跑完了，退出码却没落盘 → 被判成失败 → 白重试一轮
//
// 病灶（实测 nimrtc-zelto v3-weaknet-verdict，2026-11-18）：
//   agent 成功跑完了（活干完、总结也写了），监督进程却报：
//     ❌ agent 已退出，但会话文件里没有退出码 —— 结果不明，按失败处理
//   然后触发重试 → 又烧一轮 token → 而 agent 明明已经把活干完了。
//
// 根因：退出码记在 `close` 事件上。
//   `close` 要等 **stdio 全部关闭**（stdout/stderr 的 EOF）。
//   而 agent 在 worktree 里起了**后台进程**（ctest / cmake）——
//   那些进程**继承了 agent 的 stdout 管道** —— 它们不退出，管道就不 EOF，
//   `close` 永远不来，退出码永远不落盘。
//
// `exit` 事件只等**进程本身**退出，stdio 还没关时就到了 —— 那才是
// 「agent 跑完了」的正确信号。
//
// 这一组用例守的是：
//   1. 适配器把退出码记在 `exit` 上（不是只等 `close`）；
//   2. `exit` 与 `close` 都来时只处理一次（不重复收尾）；
//   3. 监督进程遇到「结果不明」→ **不重试**（重试是赌，赌错代价大）；
//   4. 但「结果不明」≠「成功」—— 收尾要如实说，别假装过了。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('D-59：退出码记在 exit 事件上（不是只等 close）', () => {
  it('适配器源码里 exit 与 close 都挂了 handleExit', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'adapters', 'claude-agent', 'index.ts'),
      'utf-8',
    );
    assert.match(
      src,
      /child\.on\('exit',\s*onExit\)/,
      '退出码必须挂在 exit 上 —— close 要等 stdio EOF，后台进程会拖住它',
    );
    assert.match(
      src,
      /child\.on\('close',\s*onExit\)/,
      'close 仍要挂上作为兜底',
    );
    assert.match(
      src,
      /let exitHandled = false/,
      '两个事件都来时只能处理一次',
    );
  });
});

describe('D-59：监督进程遇到「结果不明」不重试', () => {
  it('waitForAgentExit 返回结构里带 processAlive', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'cli', 'commands', 'supervisor.ts'), 'utf-8');
    assert.match(
      src,
      /Promise<\{ exitCode: number \| null; processAlive: boolean \}>/,
      '等待结果要同时给出「退出码」与「进程还在不在」',
    );
  });

  it('结果不明（exitCode 为 null 且进程已不在）→ break，不进重试', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'cli', 'commands', 'supervisor.ts'), 'utf-8');
    assert.match(
      src,
      /if \(exitCode === null && !processAlive\)[\s\S]{0,400}break;/,
      '结果不明 → 直接跳出重试回路（重试是赌，赌错白烧一轮 token）',
    );
  });

  it('结果不明不等于成功 —— 收尾要如实说', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'cli', 'commands', 'supervisor.ts'), 'utf-8');
    assert.match(
      src,
      /结果不明/,
      '「结果不明」必须出现在日志/收尾里 —— 人要知道现场是哪种情况',
    );
  });
});

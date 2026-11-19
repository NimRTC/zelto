// Cursor 的 hook 必须**显式** fail closed（ADR-083 §4）
//
// 为什么这个值得单独一个文件：
//
//   Cursor 的 hook **默认 fail open** —— hook 崩溃 / 超时 / 无输出时，
//   动作**照常执行**。
//
//   而 C9 要求「写集预约运行时强制……预约缺失时 fail closed（一律拒绝）」，
//   zelto 自己的文档也写着「判定不了就拒绝」。
//
//   **不写 `failClosed: true` 的话，zelto 在 Cursor 下就是默认放行。**
//   而且这种失效**看不见**：配置文件里有 zelto 的条目，状态显示「已安装」，
//   一切看起来正常 —— 直到某天 hook 崩了，越界写入就这么落盘了。
//
//   这跟 README 那句「已发布到 npm」（实际 404）是**同一个形状**：
//   **声称的强度与实际的强度不一致。**
//
// 所以这里钉住：
//   1. 安装 Cursor hook 时，配置里**必有** `failClosed: true`；
//   2. 状态查询能识别「装上了但没 failClosed」并**明确警告**；
//   3. 手工改坏配置（去掉 failClosed）后，状态会变成警告而不是「已安装」；
//   4. 卸载只动 zelto 自己那一条。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installCursorHook,
  removeCursorHook,
  cursorHookInstalled,
  cursorHookFailsClosed,
  CURSOR_HOOKS_RELATIVE,
} from '../../src/cli/commands/hook-install.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-cursor-hook-'));

describe('Cursor hook 必须显式 fail closed', () => {
  before(() => {
    mkdirSync(ROOT, { recursive: true });
  });

  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('安装后，配置里必有 failClosed: true', () => {
    const result = installCursorHook({ root: ROOT });
    assert.ok(result.installed, `安装应当成功：${result.message}`);

    const raw = JSON.parse(
      readFileSync(join(ROOT, CURSOR_HOOKS_RELATIVE), 'utf-8'),
    ) as {
      version?: number;
      hooks?: { preToolUse?: Array<{ command?: string; failClosed?: boolean }> };
    };

    const entries = raw.hooks?.preToolUse ?? [];
    const zelto = entries.find((e) => e.command?.includes('--zelto-pretool'));
    assert.ok(zelto, '配置里必须有 zelto 那一条');
    assert.equal(
      zelto.failClosed,
      true,
      '必须有 failClosed: true —— Cursor 默认 fail open，不写就等于默认放行',
    );
  });

  it('状态查询：装上了但没 failClosed 时，必须能被识别出来', () => {
    // 模拟「手工改坏」或「旧版本装过」的情形
    const path = join(ROOT, CURSOR_HOOKS_RELATIVE);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const hooks = raw['hooks'] as { preToolUse?: Array<{ failClosed?: boolean }> };
    for (const entry of hooks.preToolUse ?? []) delete entry.failClosed;
    writeFileSync(path, JSON.stringify(raw, null, 2), 'utf-8');

    assert.equal(cursorHookInstalled(ROOT), true, '条目还在，仍然算已安装');
    assert.equal(
      cursorHookFailsClosed(ROOT),
      false,
      '但 failClosed 没了 —— 状态查询必须能识别出来',
    );
  });

  it('重新安装会把 failClosed 补回来', () => {
    installCursorHook({ root: ROOT });
    assert.equal(cursorHookFailsClosed(ROOT), true, '重装必须恢复 failClosed');
  });

  it('卸载后不再有 zelto 的条目', () => {
    const result = removeCursorHook(ROOT);
    assert.equal(result.removed, true);
    assert.equal(cursorHookInstalled(ROOT), false);
    assert.equal(cursorHookFailsClosed(ROOT), false);
  });

  it('安装命令里带 --harness cursor（判定内核要知道是谁在问）', () => {
    installCursorHook({ root: ROOT });
    const raw = JSON.parse(
      readFileSync(join(ROOT, CURSOR_HOOKS_RELATIVE), 'utf-8'),
    ) as { hooks?: { preToolUse?: Array<{ command?: string }> } };

    const command = (raw.hooks?.preToolUse ?? []).find((e) =>
      e.command?.includes('--zelto-pretool'),
    )?.command;

    assert.ok(command, '必须有命令');
    assert.match(command, /--harness\s+cursor/, '命令里必须带 --harness cursor');
  });

  it('matcher 用的是 **Cursor CLI 的真实工具名**', () => {
    // 这是 ADR-087 §6 修的一处**看不见的失效**。
    //
    // matcher 的求值是 `new RegExp(matcher).test(tool_name)` ——
    // 名字写错一个都匹配不上 → hook 永远不被调用 →
    // **写集预约在 Cursor 下等于没有**，而配置文件看上去一切正常。
    //
    // 之前写的 `create_file|edit_file|terminal` 这些名字
    // 在 cursor-agent 里**根本不存在**。
    installCursorHook({ root: ROOT });
    const raw = JSON.parse(
      readFileSync(join(ROOT, CURSOR_HOOKS_RELATIVE), 'utf-8'),
    ) as { hooks?: { preToolUse?: Array<{ command?: string; matcher?: string }> } };

    const matcher = (raw.hooks?.preToolUse ?? []).find((e) =>
      e.command?.includes('--zelto-pretool'),
    )?.matcher;

    assert.ok(matcher, '必须有 matcher');

    // Cursor CLI 的真实写工具名（2026.09.18 实测）
    const realWriteTools = ['Write', 'Delete', 'Shell'];
    const re = new RegExp(matcher);
    for (const tool of realWriteTools) {
      assert.ok(
        re.test(tool),
        `matcher 必须匹配 Cursor 的真实工具名 "${tool}" —— 匹配不上 hook 就不会被调用`,
      );
    }

    // 反向：不该匹配一堆不存在的老名字
    for (const bogus of ['create_file', 'edit_file', 'terminal']) {
      assert.ok(
        !re.test(bogus),
        `matcher 不该匹配 Cursor 里不存在的工具名 "${bogus}"（那是假想的名字）`,
      );
    }
  });
});

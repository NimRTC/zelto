// ZD-024 回归测试 —— glob 写集下，**新建文件**的裸文件名被误报成「不在写集里」
//
// 病灶（nimrtc-v14 v2-ice，2026-11-21）：
//
//   写集 `src/modules/ice/**`，规格正文写
//   「`src/modules/ice/src/tcp_socket.hpp` + `tcp_socket.cpp`」——
//   第二项是裸文件名（同行的目录上下文对解析器不可见）。
//   而 `tcp_socket.cpp` 是**这一片要新建的**，此刻不存在
//   → ZD-020 的「同名文件已存在」查不到 → 报未覆盖 → 冻结被拦。
//
//   规格完全没问题：写集明确授权了整棵树，写的是兄弟文件名。
//   闸门误报**系统性地**挡住所有「新建文件」的切片 ——
//   也就是最需要写集授权的那一类。
//
// 修法在**规格解析层**（`parseMentionedPaths`）：裸文件名**带上它所在
// 目录的上下文**再进覆盖判据。
//
// 为什么不在写集判定层用「同扩展名兄弟」放行（试过，否决）：
//   裸文件名没有目录信息，「它是不是 glob 范围内某个文件的兄弟」只能靠猜，
//   而这个猜测必然漏报（`engine_media.cpp` 会被 `src/modules/ice/**` 放过）。
//   漏报比误报更糟。解析层有**确切证据**：同行的 `x.hpp` ↔ `x.cpp` 同目录。
//
// 这条测试独立成文件（而不是并进 ZD-019/020 那份）：
//   ZD-019/020 关心的是**判定层**，本条关心的是**解析层**。
//   两层的修法不同、回归判据不同，混在一起会让人搞不清哪条修的是哪条。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { evaluateWriteSetCoverage } from '../src/core/spec/write-set.js';
import { parseMentionedPaths } from '../src/core/spec/scope.js';

describe('ZD-024 裸文件名带上行内目录上下文', () => {
  const root = mkdtempSync(join(tmpdir(), 'zelto-zd024-'));
  mkdirSync(join(root, 'src/modules/ice/src'), { recursive: true });
  mkdirSync(join(root, 'src/engine/src'), { recursive: true });
  writeFileSync(join(root, 'src/modules/ice/src/ice.cpp'), '// ice\n');
  writeFileSync(join(root, 'src/engine/src/engine_media.cpp'), '// media\n');

  const WRITES = ['src/modules/ice/**'];

  it('裸文件名借同行的「头/实现」对补齐目录', () => {
    const spec = [
      '| 文件 | 职责 |',
      '|---|---|',
      '| `src/modules/ice/src/tcp_socket.hpp` + `tcp_socket.cpp` | 跨平台 TCP socket |',
    ].join('\n');
    const mentioned = parseMentionedPaths(spec);
    assert.ok(
      mentioned.includes('src/modules/ice/src/tcp_socket.cpp'),
      `裸文件名应补齐目录：${JSON.stringify(mentioned)}`,
    );
    assert.ok(
      !mentioned.includes('tcp_socket.cpp'),
      `补齐后的裸名不应再残留：${JSON.stringify(mentioned)}`,
    );
  });

  it('D-4 覆盖判据不再误报（新建文件）', () => {
    const spec = [
      '| `src/modules/ice/src/tcp_socket.hpp` + `tcp_socket.cpp` | 跨平台 TCP socket |',
    ].join('\n');
    const coverage = evaluateWriteSetCoverage(parseMentionedPaths(spec), WRITES, root);
    assert.deepEqual(
      coverage.uncovered,
      [],
      `误报未覆盖：${JSON.stringify(coverage.uncovered)}`,
    );
  });

  it('D-4 覆盖判据：跨行写法也不再误报（新建文件）', () => {
    const spec = [
      '| `src/modules/ice/src/tcp_socket.hpp` | 头 |',
      '| `tcp_socket.cpp` | 实现 |',
    ].join('\n');
    const coverage = evaluateWriteSetCoverage(parseMentionedPaths(spec), WRITES, root);
    assert.deepEqual(
      coverage.uncovered,
      [],
      `跨行误报未覆盖：${JSON.stringify(coverage.uncovered)}`,
    );
  });

  it('反向：不同名的裸文件名不借目录（那是另一个文件，规格没说它在哪）', () => {
    const spec = [
      '| `src/modules/ice/src/tcp_socket.hpp` + `other.cpp` | 别的文件 |',
    ].join('\n');
    const mentioned = parseMentionedPaths(spec);
    assert.ok(
      !mentioned.includes('src/modules/ice/src/other.cpp'),
      `不同名的裸文件名不得借目录：${JSON.stringify(mentioned)}`,
    );
  });

  it('跨行的裸文件名**借紧邻上一行**的目录（ZD-024 剩余问题 1）', () => {
    // 剩余问题 1：「补齐只认同一行。跨行写法（头文件在上一行、
    // 实现文件在下一行）仍然不补 —— 那是规格排版的问题，不补是安全的。」
    //
    // 修法：允许**紧邻的上一行**提供目录上下文。
    // 「紧邻」是硬约束 —— 中间隔别的行就不借（见下面的反向用例）。
    const spec = [
      '| `src/modules/ice/src/tcp_socket.hpp` | 头 |',
      '| `tcp_socket.cpp` | 实现 |',
    ].join('\n');
    const mentioned = parseMentionedPaths(spec);
    assert.ok(
      mentioned.includes('src/modules/ice/src/tcp_socket.cpp'),
      `跨行（紧邻）应补齐目录：${JSON.stringify(mentioned)}`,
    );
    assert.ok(
      !mentioned.includes('tcp_socket.cpp'),
      `补齐后的裸名不应再残留：${JSON.stringify(mentioned)}`,
    );
  });

  it('反向：中间隔了别的行 → 不借目录（离得远就没有确切证据）', () => {
    const spec = [
      '| `src/modules/ice/src/tcp_socket.hpp` | 头 |',
      '| —— | 别的内容 |',
      '| `tcp_socket.cpp` | 实现 |',
    ].join('\n');
    const mentioned = parseMentionedPaths(spec);
    assert.ok(
      !mentioned.includes('src/modules/ice/src/tcp_socket.cpp'),
      `隔行的不得借目录：${JSON.stringify(mentioned)}`,
    );
  });

  it('反向：glob 覆盖范围外的路径仍然报未覆盖', () => {
    const spec = [
      '| `src/engine/src/engine_media.hpp` + `engine_media.cpp` | 引擎 |',
    ].join('\n');
    const coverage = evaluateWriteSetCoverage(parseMentionedPaths(spec), WRITES, root);
    assert.ok(
      coverage.uncovered.length > 0,
      'glob 外的文件仍然必须报未覆盖（补齐不得越界）',
    );
  });

  it('反向：同一个裸名出现在两行、目录不同时，各自补到各自的目录', () => {
    const spec = [
      '| `src/modules/ice/src/tcp_socket.hpp` + `tcp_socket.cpp` | ICE |',
      '| `src/engine/src/other.hpp` + `other.cpp` | 引擎 |',
    ].join('\n');
    const mentioned = parseMentionedPaths(spec);
    assert.ok(
      mentioned.includes('src/modules/ice/src/tcp_socket.cpp'),
      `第一行应补到 ice 目录：${JSON.stringify(mentioned)}`,
    );
    assert.ok(
      mentioned.includes('src/engine/src/other.cpp'),
      `第二行应补到 engine 目录：${JSON.stringify(mentioned)}`,
    );
  });

  it('清理临时目录', () => {
    rmSync(root, { recursive: true, force: true });
  });
});

// 冻结准入的「规格提到 vs 写集覆盖」判定不再误报（ZD-006）
//
// 病灶（nimrtc v1.4 演练，2026-11-20）：
//
//   `zelto freeze v1-n5-turn-server` 被拦，报三条：
//     - 规格提到「node --test tests/acceptance/v1-n5-turn-server/acceptance.test.cjs」，
//       但它不在写集里 —— agent 改不了它
//     - 规格提到「acceptance.test.cjs」，但它不在写集里
//     - 规格提到「install」，但它不在写集里
//
//   三条**全是误报**，而规格完全没问题：
//     1. 反引号里是**一条命令**，不是路径
//     2. 规格只写了**文件名**，写集里是完整路径 → 精确比较判成没覆盖
//     3. `apt-get install coturn` 里的 `install` 是 shell 动词，不是文件
//
// 闸门误报比闸门漏报更糟：误报会把人引去改**正确的**规格。
//
// 这里覆盖三处的修法，外加一条「不许为了修误报而放松真判据」的反向测试。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMentionedPaths, parseScopePaths } from '../src/core/spec/scope.js';
import { evaluateWriteSetCoverage, isInWriteSet } from '../src/core/spec/write-set.js';
import { parseReferencedPaths } from '../src/core/spec/reference.js';

const WRITES = [
  'examples/turn-server/**',
  'tests/acceptance/v1-n5-turn-server/acceptance.test.cjs',
];

describe('ZD-006 反引号里的命令行不是路径', () => {
  it('`node --test tests/.../acceptance.test.cjs` 不算一个路径', () => {
    const mentioned = parseMentionedPaths(
      '1. 测试通过 URI 交互；验证方式：运行 `node --test tests/acceptance/v1-n5-turn-server/acceptance.test.cjs`。',
    );
    assert.ok(
      !mentioned.some((p) => p.includes('node --test')),
      `命令被当成了路径：${JSON.stringify(mentioned)}`,
    );
  });

  it('命令行里的路径仍被正确提取（裸路径通道）', () => {
    const mentioned = parseMentionedPaths(
      '运行 `node --test tests/acceptance/v1-n5-turn-server/acceptance.test.cjs`',
    );
    assert.ok(mentioned.includes('tests/acceptance/v1-n5-turn-server/acceptance.test.cjs'));
  });

  it('引用通道也不把命令行当路径', () => {
    const referenced = parseReferencedPaths(
      '参见 `node --test tests/acceptance/x/acceptance.test.cjs`',
    );
    assert.ok(!referenced.some((p) => p.includes('node --test')));
  });
});

describe('ZD-006 规格只写文件名时算覆盖', () => {
  it('basename 相同 → 算在写集里', () => {
    assert.equal(isInWriteSet('acceptance.test.cjs', WRITES), true);
  });

  it('完整路径 → 仍算在写集里', () => {
    assert.equal(
      isInWriteSet('tests/acceptance/v1-n5-turn-server/acceptance.test.cjs', WRITES),
      true,
    );
  });

  it('basename 不同 → 不算', () => {
    assert.equal(isInWriteSet('other.test.cjs', WRITES), false);
  });

  it('覆盖判定：规格只写文件名 → 不报 uncovered', () => {
    const mentioned = ['acceptance.test.cjs'];
    const result = evaluateWriteSetCoverage(mentioned, WRITES);
    assert.deepEqual(result.uncovered, []);
  });
});

describe('ZD-006 apt-get install 里的 install 不是文件', () => {
  it('`apt-get install coturn` 里的 install 不被当成路径', () => {
    const mentioned = parseMentionedPaths(
      '参考脚本里包含 `apt-get install coturn`；验证方式：检索到该命令。',
    );
    assert.ok(
      !mentioned.includes('install'),
      `install 被当成了文件：${JSON.stringify(mentioned)}`,
    );
  });

  it('真正的 install 脚本（带路径）仍被识别', () => {
    const mentioned = parseMentionedPaths('新建 `scripts/install.sh`');
    assert.ok(mentioned.includes('scripts/install.sh'));
  });
});

describe('ZD-006 修误报不许放松真判据', () => {
  it('规格提到、写集里真的没有的文件 → 仍然报 uncovered', () => {
    const mentioned = ['src/engine/src/rtcp_processor.cpp'];
    const result = evaluateWriteSetCoverage(mentioned, WRITES);
    assert.deepEqual(result.uncovered, ['src/engine/src/rtcp_processor.cpp']);
  });

  it('规格里的 glob 写集条目仍被识别', () => {
    const scope = parseScopePaths(
      '## 范围\n- examples/turn-server/**\n- tests/acceptance/x/acceptance.test.cjs',
    );
    assert.ok(scope.includes('examples/turn-server/**'));
  });
});

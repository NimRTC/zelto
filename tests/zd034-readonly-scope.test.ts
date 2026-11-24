// ZD-034：只读作用域 —— 「只读」前缀对**同一列表条目内**多个路径的绑定
//
// 病灶（ADR-098 决策一 + 实现要点，实测于 nimrtc-v14 v2-ice）：
//
//   规格里写「只读参考 `a.cpp` 与 `b.md`」—— 人写这句话时，
//   `a.cpp` 与 `b.md` **都是**只读参考。但原先的判据只认
//   「紧邻」：只读标记必须**贴着**路径才算，于是 `b.md` 没被豁免
//   → D-4 报「规格提到 b.md，但它不在写集里 —— agent 改不了它」
//   → 人回去改写集 → 一次几小时的往返（ADR-098 实测 23.93h 里的 97.8%）。
//
// 修法：只读标记在**同一个列表条目内**对后续路径持续生效，
// 直到遇到**边界**（句号 / 反转措辞 / 下一个列表项）为止。
//
// 关键约束（漏报比误报更糟 —— AGENTS.md）：
//   作用域**不能**跨句号、**不能**跨列表项、**不能**跨反转措辞
//   （「只读 `a.cpp`，但要改 `b.cpp`」—— `b.cpp` 是要改的）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMentionedPaths } from '../src/core/spec/scope.js';
import { parseReferencedPaths } from '../src/core/spec/reference.js';

/** 只读引用的路径 */
function refs(spec: string): string[] {
  return parseReferencedPaths(spec);
}

/** 「要改」集合 = 提到的路径 − 只读引用 */
function required(spec: string): string[] {
  const mentioned = parseMentionedPaths(spec);
  const referenced = new Set(parseReferencedPaths(spec));
  return mentioned.filter((p) => !referenced.has(p));
}

describe('ZD-034：只读作用域（条目级多路径绑定）', () => {
  describe('作用域在条目内延续', () => {
    it('「只读参考 A 与 B」—— 两个路径都豁免', () => {
      const spec = `# Slice: x

## 范围
- \`src/modules/ice/src/tcp_socket.cpp\`

## 需求
1. 只读参考 \`src/third_party/libjuice/src/src/ice.c\` 与 \`docs/adr/ADR-028.md\`。
`;
      const r = refs(spec);
      assert.ok(r.includes('src/third_party/libjuice/src/src/ice.c'), '第一个路径应豁免');
      assert.ok(r.includes('docs/adr/ADR-028.md'), '第二个路径也应豁免（作用域延续）');
    });

    it('「只读 A，B」跨逗号延续', () => {
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 需求
1. 只读 \`src/b.cpp\`，\`docs/c.md\`。
`;
      const r = refs(spec);
      assert.ok(r.includes('src/b.cpp'));
      assert.ok(r.includes('docs/c.md'), '逗号是并列连接符，不该终止作用域');
    });

    it('只读作用域对**源码**也生效（不限扩展名）', () => {
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 需求
1. 只读 \`src/b.cpp\` 与 \`src/c.cpp\`。
`;
      const r = refs(spec);
      assert.ok(r.includes('src/b.cpp'));
      assert.ok(r.includes('src/c.cpp'));
    });
  });

  describe('作用域的边界（防漏报）', () => {
    it('不跨句号：句号后面是新句子', () => {
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 需求
1. 只读 \`src/b.cpp\`。但要改 \`src/c.cpp\`。
`;
      assert.ok(refs(spec).includes('src/b.cpp'));
      assert.ok(!refs(spec).includes('src/c.cpp'), '句号后的路径不该被只读作用域覆盖');
    });

    it('不跨反转措辞：「只读 A，但要改 B」', () => {
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 需求
1. 只读 \`src/b.cpp\`，但要改 \`src/c.cpp\`。
`;
      const r = refs(spec);
      assert.ok(r.includes('src/b.cpp'));
      assert.ok(!r.includes('src/c.cpp'), '「但要改」反转了只读作用域');
    });

    it('不跨列表项：下一项不受上一项影响', () => {
      const spec = `# Slice: x

## 范围
- 只读 \`src/a.cpp\` —— 参考它的实现
- \`src/b.cpp\` —— 要改的
`;
      const r = refs(spec);
      assert.ok(r.includes('src/a.cpp'));
      assert.ok(!r.includes('src/b.cpp'), '列表项之间不传染只读作用域');
    });

    it('同一行内的两个列表项也不传染', () => {
      const spec = `# Slice: x

## 范围
- 只读 \`src/a.cpp\` —— 说明   - \`src/b.cpp\` —— 要改的
`;
      const r = refs(spec);
      assert.ok(r.includes('src/a.cpp'));
      assert.ok(!r.includes('src/b.cpp'));
    });

    it('反转之后重新出现的只读标记重新生效', () => {
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 需求
1. 只读 \`src/b.cpp\`，但要改 \`src/c.cpp\`，只读 \`src/d.cpp\`。
`;
      const r = refs(spec);
      assert.ok(r.includes('src/b.cpp'));
      assert.ok(!r.includes('src/c.cpp'));
      assert.ok(r.includes('src/d.cpp'), '反转之后的只读标记应重新生效');
    });
  });

  describe('与章节规则的优先级', () => {
    it('参考章节里的条目级「只读」优先于章节默认（源码也豁免）', () => {
      // 章节规则只豁免文档（源码豁免 = D-4 漏报），
      // 但**显式的只读标记**语义更强 —— 源码也该豁免。
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 参考
- 只读 \`src/b.cpp\`
`;
      assert.ok(refs(spec).includes('src/b.cpp'));
    });

    it('参考章节里没有只读标记的源码**不豁免**（防漏报）', () => {
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 参考
- \`src/b.cpp\`
`;
      assert.ok(!refs(spec).includes('src/b.cpp'));
    });
  });

  describe('与 D-4 覆盖判据合起来的效果', () => {
    it('只读参考不进「要改」集合 → 不触发 D-4', () => {
      const spec = `# Slice: v2-ice

## 范围
要改的：
- \`src/modules/ice/src/tcp_socket.cpp\`
- \`src/modules/ice/src/tcp_socket.hpp\`

只读参考（不得修改）：
- 只读 \`src/third_party/libjuice/src/src/ice.c\` —— libjuice 的 UDP-only 事实
- 只读 \`docs/adr/ADR-028-ice-over-tcp-nimrtc-side.md\` —— 本片的设计依据

新建文件：
- \`src/modules/ice/src/udp_socket.cpp\`
`;
      const req = required(spec);
      assert.ok(req.includes('src/modules/ice/src/tcp_socket.cpp'));
      assert.ok(req.includes('src/modules/ice/src/tcp_socket.hpp'));
      assert.ok(req.includes('src/modules/ice/src/udp_socket.cpp'));
      assert.ok(!req.includes('src/third_party/libjuice/src/src/ice.c'), '只读参考不该进「要改」集合');
      assert.ok(!req.includes('docs/adr/ADR-028-ice-over-tcp-nimrtc-side.md'));
    });

    it('裸文件名的只读豁免：同条目的完整路径也一并豁免', () => {
      const spec = `# Slice: x

## 范围
- \`src/modules/ice/src/tcp_socket.cpp\`

## 需求
1. 仿照只读 \`ice.c\` 的写法；实现见 \`src/third_party/libjuice/src/src/ice.c\`。
`;
      const req = required(spec);
      assert.ok(!req.includes('src/third_party/libjuice/src/src/ice.c'));
    });

    it('「见 X（只读）」不算只读标记（路径本身没被标只读）', () => {
      // 括号里的是修饰语，不是对路径的只读声明。
      // 认了 = 漏报；不认 = 报出来让人补一句「只读」（几分钟）。
      const spec = `# Slice: x

## 范围
- \`src/a.cpp\`

## 需求
1. 见 \`src/b.cpp\`（只读）。
`;
      assert.ok(!refs(spec).includes('src/b.cpp'));
    });
  });
});

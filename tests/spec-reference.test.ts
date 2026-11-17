// 规格「只读引用」的识别 —— D-4 规则的误报修复
//
// 病灶（实测于 nimrtc-zelto v2-input-binder）：
//
//   规格里写着「对应 `docs/plan/ai-game-demo-plan.md` §5.1」——
//   那份规划文档是**拿来读**的，不是**要改**的。
//   但 D-4 规则（规格提到的文件必须在写集里）看的是**全文**提到的路径，
//   于是它把那份规划文档也算成「规格说要改」→ 冻结被拦。
//
//   而那份文档恰恰是 agent **不该**动的 —— 它是需求与设计的出处，
//   改了追溯链就断了。所以「加进写集」这个建议本身就是错的。
//
//   闸门误报比闸门漏报更糟：漏报让人绕过一次检查，
//   误报让人以为「规格有问题」，于是去改正确的规格。
//
// 判据边界：**只豁免文档类路径**（.md/.txt/…）。
// 源码路径在规格里往往正是「要改这个文件」的意思
// （D-4 的原始案例：`src/engine/CMakeLists.txt` 如需登记新 `.cpp` 文件），
// 豁免范围放宽到源码 = 漏报，那比误报更糟。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseReferencedPaths } from '../src/core/spec/reference.js';

describe('规格里的只读引用识别', () => {
  describe('参考章节', () => {
    it('「## 参考」章节里的文档路径被识别为只读引用', () => {
      const spec = `# Slice: x

## 范围
- src/a.cpp

## 参考
- docs/plan/ai-game-demo-plan.md
- docs/其它.md
`;
      const refs = parseReferencedPaths(spec);
      assert.ok(refs.includes('docs/plan/ai-game-demo-plan.md'));
      assert.ok(refs.includes('docs/其它.md'));
    });

    it('「## References」英文标题同样被识别', () => {
      const spec = `# Slice: x

## References
- docs/plan/spec.md
`;
      assert.ok(parseReferencedPaths(spec).includes('docs/plan/spec.md'));
    });

    it('参考章节里的源码路径**不豁免**（源码出现在规格里通常是要改）', () => {
      const spec = `# Slice: x

## 参考
- src/core/engine.cpp
`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });
  });

  describe('正文里的指路措辞', () => {
    it('「对应 <文档>」被识别', () => {
      const spec = `# Slice: x

## 目的
对应 \`docs/plan/ai-game-demo-plan.md\` §5.1「输入事件绑定」。
`;
      assert.ok(parseReferencedPaths(spec).includes('docs/plan/ai-game-demo-plan.md'));
    });

    it('「详见 <文档>」被识别', () => {
      const spec = `详见 docs/design/spec.md 的说明。`;
      assert.ok(parseReferencedPaths(spec).includes('docs/design/spec.md'));
    });

    it('「see <文档>」被识别', () => {
      const spec = `See docs/design/spec.md for details.`;
      assert.ok(parseReferencedPaths(spec).includes('docs/design/spec.md'));
    });

    it('指路措辞后面跟的是源码 → 不豁免', () => {
      const spec = `对应 \`src/engine/src/engine.cpp\` 的实现。`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });

    it('指路措辞后面没有路径 → 不豁免任何东西', () => {
      const spec = `见下面的表格。`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });
  });

  describe('只读标记', () => {
    it('「不改动 X」豁免源码路径', () => {
      const spec = '1. **不改动** `examples/demo-agent-gateway/demo-agent-gateway.cpp` 的行为。';
      assert.ok(parseReferencedPaths(spec).includes('examples/demo-agent-gateway/demo-agent-gateway.cpp'));
    });

    it('「fork X 出 Y」豁免被复制的源文件', () => {
      const spec = 'fork `examples/demo-agent-gateway/demo-agent-gateway.cpp` 出新目录。';
      assert.ok(parseReferencedPaths(spec).includes('examples/demo-agent-gateway/demo-agent-gateway.cpp'));
    });

    it('只读标记不限扩展名（源码也可以是只读的）', () => {
      const spec = '只读：`src/core/engine.cpp`';
      assert.ok(parseReferencedPaths(spec).includes('src/core/engine.cpp'));
    });

    it('没有只读标记时源码不被豁免', () => {
      const spec = '修改 `src/core/engine.cpp` 的实现。';
      assert.deepEqual(parseReferencedPaths(spec), []);
    });
  });

  describe('不豁免的情形', () => {
    it('「范围」章节里的源码路径不被豁免', () => {
      const spec = `# Slice: x

## 范围
- src/modules/rd_input/src/ref_frame_binder.cpp
`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });

    it('URL 不被当成路径', () => {
      const spec = `参见 https://example.com/docs/guide.md`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });

    it('含 glob 通配的路径不被当成具体引用', () => {
      const spec = `参考 docs/**/*.md`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });

    it('普通正文里的文档路径（无指路措辞）不被豁免', () => {
      // 没有「对应/参见/详见」这类措辞 —— 不能凭路径像文档就放行
      const spec = `这个规格要改 docs/plan/ai-game-demo-plan.md。`;
      assert.deepEqual(parseReferencedPaths(spec), []);
    });
  });

  describe('与 D-4 规则合起来的效果', () => {
    it('指路的规划文档不触发 D-4，源码仍然触发', () => {
      const spec = `# Slice: x

## 目的
对应 \`docs/plan/plan.md\` §5.1。

## 需求
1. \`src/engine/CMakeLists.txt\` 如需登记新文件，只加一行。
`;
      const refs = new Set(parseReferencedPaths(spec));
      assert.ok(refs.has('docs/plan/plan.md'));
      assert.ok(!refs.has('src/engine/CMakeLists.txt'));
    });
  });
});

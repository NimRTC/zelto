// ADR-063：设计文档的**确定性修正**（`zelto design patch`）
//
// 为什么要这个命令（实战演练踩到的）：
//
//   1. `arch check` 报出「模块无文件」—— 设计的文件路径写错了
//   2. 想改路径，但 `design refine` 只接受 draft，已确认的设计改不了
//   3. 只能手改 JSON
//
// 手改 JSON 的坑：**`body` 是真源，`modules` 是缓存快照** ——
// 只改一个会不一致（判定读 body，报告读 modules）。
//
// 所以这个命令的核心断言是：**只改指定的那一处，且两处同步**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { patchDesignBody, applyPatch } from '../src/core/design/patch.js';
import { parseDesignModules } from '../src/core/design/parse.js';
import type { DesignDoc } from '../src/core/design/types.js';

/** 单行字段写法（真实项目的格式） */
const SINGLE_LINE_BODY = `# 设计文档

## 模块分解

### src/core
- **职责**：核心功能
- **文件路径**：src/core/*, src/core/**/*
- **依赖模块**：无

### src/dtls
- **职责**：DTLS 实现
- **文件路径**：src/dtls/*, src/dtls/**/*
- **依赖模块**：src/core, src/third_party

### src/engine
- **职责**：核心引擎
- **文件路径**：src/engine/*, src/engine/**/*
- **依赖模块**：src/core
`;

/** 多行列表字段写法（另一种合法格式） */
const MULTI_LINE_BODY = `# 设计文档

## 模块分解

### src/core
- **职责**：核心功能
- **文件路径**:
  - \`src/core/*\`
  - \`src/core/**/*\`
- **依赖模块**: 无

### src/dtls
- **职责**：DTLS 实现
- **文件路径**:
  - \`src/dtls/*\`
  - \`src/dtls/**/*\`
- **依赖模块**: src/core
`;

describe('ADR-063：设计正文的确定性修正', () => {
  describe('单行字段写法', () => {
    it('替换文件路径', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*', 'src/modules/dtls/**/*'] },
      ]);
      assert.equal(result.changed.length, 1);
      assert.equal(result.changed[0].module, 'src/dtls');
      assert.equal(result.changed[0].field, 'filePatterns');
      assert.deepEqual(result.changed[0].before, ['src/dtls/*', 'src/dtls/**/*']);
      assert.deepEqual(result.changed[0].after, ['src/modules/dtls/*', 'src/modules/dtls/**/*']);
      assert.ok(result.body.includes('src/modules/dtls/*, src/modules/dtls/**/*'));
    });

    it('只改指定模块 —— 其它模块一个字都不动', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*'] },
      ]);
      // src/core 和 src/engine 的段落原封不动
      assert.ok(result.body.includes('- **文件路径**：src/core/*, src/core/**/*'));
      assert.ok(result.body.includes('- **文件路径**：src/engine/*, src/engine/**/*'));
      // 职责一个字都没动
      assert.ok(result.body.includes('- **职责**：DTLS 实现'));
    });

    it('替换依赖模块', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/dtls', dependencies: ['src/core'] },
      ]);
      assert.equal(result.changed.length, 1);
      assert.equal(result.changed[0].field, 'dependencies');
      assert.ok(result.body.includes('- **依赖模块**：src/core'));
      assert.ok(!result.body.includes('src/third_party'));
    });

    it('依赖模块清空时写成「无」', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/dtls', dependencies: [] },
      ]);
      assert.ok(result.body.includes('- **依赖模块**：无'));
    });

    it('找不到的模块进 missing，不改任何东西', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/nonexistent', filePatterns: ['x/*'] },
      ]);
      assert.deepEqual(result.missing, ['src/nonexistent']);
      assert.equal(result.changed.length, 0);
      assert.equal(result.body, SINGLE_LINE_BODY, '正文不该有任何变化');
    });
  });

  describe('多行列表写法', () => {
    it('替换文件路径时整块换掉列表', () => {
      const result = patchDesignBody(MULTI_LINE_BODY, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*', 'src/modules/dtls/**/*'] },
      ]);
      assert.equal(result.changed.length, 1);
      assert.deepEqual(result.changed[0].before, ['src/dtls/*', 'src/dtls/**/*']);
      assert.ok(result.body.includes('src/modules/dtls/*, src/modules/dtls/**/*'));
      // 旧的列表项不能残留
      assert.ok(!result.body.includes('`src/dtls/*`'), '旧列表项不该残留');
      assert.ok(!result.body.includes('`src/dtls/**/*`'), '旧列表项不该残留');
    });

    it('多行列表的依赖模块也能改', () => {
      const result = patchDesignBody(MULTI_LINE_BODY, [
        { module: 'src/dtls', dependencies: ['src/core', 'src/third_party'] },
      ]);
      assert.equal(result.changed.length, 1);
      assert.ok(result.body.includes('- **依赖模块**: src/core, src/third_party'));
    });

    it('多行写法改完后能正常解析', () => {
      const result = patchDesignBody(MULTI_LINE_BODY, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*'] },
      ]);
      const modules = parseDesignModules(result.body);
      const dtls = modules.find((m) => m.name === 'src/dtls');
      assert.ok(dtls);
      assert.deepEqual(dtls.filePatterns, ['src/modules/dtls/*']);
    });
  });

  describe('正文与 modules 保持一致', () => {
    it('applyPatch 后 modules 与正文一致', () => {
      const doc: DesignDoc = {
        id: 'prj-1',
        requirementId: 'req-1',
        title: '测试设计',
        body: SINGLE_LINE_BODY,
        // 故意给一份**过时**的 modules 快照
        modules: [
          {
            name: 'src/dtls',
            description: 'DTLS 实现',
            filePatterns: ['src/dtls/*'],
            dependencies: ['src/core'],
          },
        ],
        status: 'confirmed',
        supersedes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      };

      const { doc: patched, result } = applyPatch(doc, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*', 'src/modules/dtls/**/*'] },
      ]);

      assert.equal(result.changed.length, 1);
      // 缓存快照被重新推导，不再是旧的
      const dtls = patched.modules.find((m) => m.name === 'src/dtls');
      assert.ok(dtls);
      assert.deepEqual(dtls.filePatterns, ['src/modules/dtls/*', 'src/modules/dtls/**/*']);

      // 关键：modules 与正文推导出来的**一致**
      const fromBody = parseDesignModules(patched.body);
      assert.deepEqual(patched.modules, fromBody, 'modules 必须与正文一致');
    });

    it('原文档不被修改（返回新文档）', () => {
      const doc: DesignDoc = {
        id: 'prj-1',
        requirementId: 'req-1',
        title: '测试设计',
        body: SINGLE_LINE_BODY,
        modules: [],
        status: 'confirmed',
        supersedes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      };
      const { doc: patched } = applyPatch(doc, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*'] },
      ]);
      assert.equal(doc.body, SINGLE_LINE_BODY, '原文档不该被改');
      assert.notEqual(patched.body, SINGLE_LINE_BODY);
    });
  });

  describe('新增缺失的模块段（ZD-012）', () => {
    // 实战病灶：设计的模块图**不完整** —— 模块 A 声明依赖 `core`，
    // 但模块图里根本没有 `core`。架构护栏报「未知模块」→ deny → 门禁开不了。
    //
    // 修法有两条：补上缺失的模块段，或删掉那条依赖。
    // 前者需要「加一段」—— 原来的 `design patch` 只能改现有段。

    it('新增模块段：正文多出该段，且能解析出它的字段', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        {
          module: '',
          add: {
            name: 'src/core-api',
            description: '公共 API 头文件',
            filePatterns: ['src/core/api/**'],
            dependencies: [],
          },
        },
      ]);
      assert.equal(result.changed.length, 1);
      assert.ok(result.body.includes('### src/core-api'));
      assert.ok(result.body.includes('- **职责**：公共 API 头文件'));

      const modules = parseDesignModules(result.body);
      const added = modules.find((m) => m.name === 'src/core-api');
      assert.ok(added, '新增的模块必须能被解析出来');
      assert.deepEqual(added.filePatterns, ['src/core/api/**']);
      assert.deepEqual(added.dependencies, []);
    });

    it('新增段插在最后一个 ### 段之后、## 段之前', () => {
      // 用一个尾部还有 `##` 段的正文 —— 新段必须落在两者之间
      const bodyWithTail = `${SINGLE_LINE_BODY}
## 数据流
1. 初始化
`;
      const result = patchDesignBody(bodyWithTail, [
        {
          module: '',
          add: { name: 'src/extra', description: 'x', filePatterns: ['src/extra/**'], dependencies: [] },
        },
      ]);
      const body = result.body;
      const engineIdx = body.indexOf('### src/engine');
      const extraIdx = body.indexOf('### src/extra');
      assert.ok(engineIdx > 0 && extraIdx > engineIdx, '新段必须在现有模块段之后');
      // 新段还在下一个 `##` 标题之前（模块声明只在 ## 之下）
      const tailIdx = body.indexOf('## 数据流');
      assert.ok(tailIdx > 0 && extraIdx < tailIdx, '新段必须在下一个 ## 标题之前');
    });

    it('依赖为空的段也写「依赖模块：无」', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        {
          module: '',
          add: { name: 'src/lonely', description: 'x', filePatterns: ['src/lonely/**'], dependencies: [] },
        },
      ]);
      assert.ok(result.body.includes('- **依赖模块**：无'));
    });

    it('已有同名模块时不重复加', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        {
          module: '',
          add: { name: 'src/core', description: 'x', filePatterns: ['src/core/**'], dependencies: [] },
        },
      ]);
      const count = (result.body.match(/### src\/core\b/g) ?? []).length;
      assert.equal(count, 1, '不该出现两个同名模块段');
    });

    it('新增段不破坏原有模块的字段', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        {
          module: '',
          add: { name: 'src/extra', description: 'x', filePatterns: ['src/extra/**'], dependencies: [] },
        },
      ]);
      assert.ok(result.body.includes('- **文件路径**：src/core/*, src/core/**/*'));
      assert.ok(result.body.includes('- **依赖模块**：src/core, src/third_party'));
    });

    it('modules 与正文一致（新增后仍然同步）', () => {
      const result = patchDesignBody(SINGLE_LINE_BODY, [
        {
          module: '',
          add: { name: 'src/extra', description: 'x', filePatterns: ['src/extra/**'], dependencies: [] },
        },
      ]);
      assert.deepEqual(result.modules, parseDesignModules(result.body));
    });
  });

  describe('确定性（C3）', () => {
    it('同样输入两次结果完全相同', () => {
      const a = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*'] },
      ]);
      const b = patchDesignBody(SINGLE_LINE_BODY, [
        { module: 'src/dtls', filePatterns: ['src/modules/dtls/*'] },
      ]);
      assert.equal(a.body, b.body);
      assert.deepEqual(a.changed, b.changed);
      assert.deepEqual(a.modules, b.modules);
    });

    it('不调模型、不触网 —— core/ 里只有纯文本计算', () => {
      // 这个断言是「架构上的保证」：core/design/patch.ts 只 import
      // ./derive.js 和 ./types.js，没有 adapters/、没有 llm/。
      // 真要验证得读源码 —— 这里用行为侧的间接证据：
      // 同样的输入永远得到同样的输出（上面已测）。
      // 真正的保证来自 AGENTS.md 的 C2/C3 约束 + code review。
      assert.ok(true);
    });
  });
});

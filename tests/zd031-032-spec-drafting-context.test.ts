// 规格起草提速三件套（ZD-031 / ZD-032 / ZD-033）
//
// ── 背景（ADR-098 实测，nimrtc v1.4，2026-11-21 ~ 11-22）──
//
// 五片的**规格阶段**墙钟共 **23.93h**。其中：
//
//   - LLM 调用（10 次 spec 草稿）只占 **1908s ≈ 32 分钟**（2.2%）
//   - 其余 **97.8%（22.23h）** 是**人在改规格与改写集**
//
// 而 97% 的闸门失败是同一句：「规格提到「X」，但它不在写集里」。
//
// 所以提速的杠杆**不在模型**（模型只占 2.2%），而在**给模型的信息量**
// 与**报错给不给出路**。本文件覆盖这三处修法：
//
//   1. **ZD-031**：一条需求在文档里散落多行（主体 / 验收口径 / 测试形态 /
//      子条目），旧口径只装下**一行** —— 丢的恰恰是规格最该照抄的部分。
//   2. **ZD-032**：规格起草这条路**没读设计文档** —— 明明模块路径就在
//      `.zelto/design/dsg-*.json` 里，却让模型凭空猜。
//   3. **ZD-033**：「不在写集里」只说「你有问题」，**不给修法** ——
//      而两条修法方向完全相反（加写集 vs 标只读），人猜错就再等几小时。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractCriteria,
  renderCriteriaSection,
} from '../src/core/requirements/criteria.js';
import {
  renderRequirementDetails,
  buildDeterministicSliceSpec,
} from '../src/llm/generators/slice-spec.js';
import { SLICE_SPEC_PROMPT } from '../src/llm/prompts/slice-spec.js';
import {
  buildDesignContext,
  renderDesignContext,
} from '../src/llm/design-context.js';

// ── ZD-031：需求条目的全部侧面 ──────────────────────────────────────────

describe('ZD-031 需求条目的全部侧面', () => {
  it('一条需求的多个侧面全部收集（不再只留一行）', () => {
    // 这段需求文档形状取自 nimrtc v1.4 的真实需求（N2）。
    const criteria = extractCriteria(
      '',
      [
        'N2：IceTransport 收集带 active / passive tcptype 的 host TCP 候选（RFC 6544 §4.5）。',
        'N2 验收：两个只能通过 TCP 互通的 peer 选出 TCP 候选对，被选中对的 protocol 读作 "tcp"。',
        'N2 测试形态：环回测试里让 UDP socket 绑到互相不可路由的地址，TCP 是唯一通路。',
      ],
      ['N2'],
    );
    assert.equal(criteria.length, 1);
    assert.ok(criteria[0].aspects, '应有 aspects');
    assert.equal(criteria[0].aspects!.length, 3, '三个侧面都要留');
    assert.match(criteria[0].aspects!.join('\n'), /验收/);
    assert.match(criteria[0].aspects!.join('\n'), /测试形态/);
  });

  it('同一句话的排版差异被去重（不重复给）', () => {
    const criteria = extractCriteria(
      '',
      [
        '- [ ] N5：在 examples/turn-server/ 下提供参考 TURN 部署。',
        'N5：在 examples/turn-server/ 下提供参考 TURN 部署。',
      ],
      ['N5'],
    );
    assert.equal(criteria[0].aspects?.length ?? 1, 1, '同句只留一次');
  });

  it('markdown 强调标记的差异被去重', () => {
    const criteria = extractCriteria(
      '',
      ['N2-1：**TCP 在 UDP 失败之后才尝试**，不是和 UDP 赛跑。', 'N2-1：TCP 在 UDP 失败之后才尝试，不是和 UDP 赛跑。'],
      ['N2'],
    );
    const aspects = criteria[0].aspects ?? [];
    assert.equal(aspects.length, 1, '强调标记不算差异');
  });

  it('子条目（N2-1）并入父需求 N2', () => {
    const criteria = extractCriteria(
      '',
      [
        'N2：IceTransport 收集 host TCP 候选。',
        'N2-1：**TCP 在 UDP 失败之后才尝试**，不是和 UDP 赛跑。',
      ],
      ['N2'],
    );
    const aspects = criteria[0].aspects ?? [];
    assert.ok(aspects.length >= 2, '子条目要并进来');
    assert.match(aspects.join('\n'), /UDP 失败之后才尝试/);
  });

  it('只有一个侧面时不给 aspects（不制造噪音）', () => {
    const criteria = extractCriteria('', ['N2：就一句话。'], ['N2']);
    assert.equal(criteria[0].aspects, undefined);
    assert.equal(criteria[0].text, '就一句话。');
  });

  it('渲染：多个侧面逐条列出', () => {
    const text = renderCriteriaSection([
      { id: 'N2', text: '主体', aspects: ['主体', '验收：口径', '测试形态：环回'] },
    ]);
    assert.match(text, /- N2：主体/);
    assert.match(text, /验收：口径/);
    assert.match(text, /测试形态：环回/);
  });

  it('渲染到 prompt：多个侧面都在', () => {
    const text = renderRequirementDetails({
      sliceId: 's',
      title: 't',
      module: 'm',
      writes: [],
      version: 'v1',
      requirements: ['N2'],
      requirementDetails: [{ id: 'N2', text: '主体' }],
      requirementAspects: [{ id: 'N2', aspects: ['主体', '验收：口径'] }],
    });
    assert.match(text, /验收：口径/);
  });

  it('确定性降级规格：每个侧面一条验收标准', () => {
    const spec = buildDeterministicSliceSpec({
      sliceId: 's',
      title: 't',
      module: 'm',
      writes: [],
      version: 'v1',
      requirements: ['N2'],
      requirementDetails: [{ id: 'N2', text: '主体' }],
      requirementAspects: [{ id: 'N2', aspects: ['主体', '验收：口径', '测试形态：环回'] }],
    });
    // 三条编号验收标准（而不是一条「满足需求 N2」）
    assert.match(spec, /1\. 主体/);
    assert.match(spec, /2\. 验收：口径/);
    assert.match(spec, /3\. 测试形态：环回/);
  });
});

// ── ZD-032：设计上下文进 prompt ──────────────────────────────────────────

/** 造一个带已确认设计的临时项目 */
function makeProjectWithDesign(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-design-ctx-'));
  const designDir = join(root, '.zelto', 'design');
  mkdirSync(designDir, { recursive: true });
  writeFileSync(
    join(designDir, 'dsg-1.json'),
    JSON.stringify({
      id: 'dsg-1',
      requirementId: 'req-1',
      title: '测试设计',
      // 正文是模块声明的真源
      body: [
        '### 网络适配层 (ice)',
        '**职责**：实现 ICE-over-TCP 穿透',
        '**文件路径**:',
        '  - `src/modules/ice/**`',
        '**依赖模块**: [core]',
        '',
        '### 核心基础层 (core)',
        '**职责**：公共 API 头文件',
        '**文件路径**:',
        '  - `src/core/**`',
        '**依赖模块**: [无]',
      ].join('\n'),
      modules: [],
      status: 'confirmed',
      supersedes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf-8',
  );
  return root;
}

describe('ZD-032 设计上下文进规格 prompt', () => {
  it('从已确认设计里取出本片所属模块的路径事实', async () => {
    const root = makeProjectWithDesign();
    const ctx = await buildDesignContext(join(root, '.zelto'), {
      sliceModule: '网络适配层 (ice)',
      writes: ['src/modules/ice/**'],
      requirementIds: ['N2'],
    });
    assert.ok(ctx, '应有设计上下文');
    assert.equal(ctx!.designId, 'dsg-1');
    const own = ctx!.modules.find((m) => m.isSliceModule);
    assert.ok(own, '应有本片所属模块');
    assert.deepEqual(own!.filePatterns, ['src/modules/ice/**']);
    assert.equal(own!.role, 'write');
  });

  it('依赖模块被标成「只读参考」角色', async () => {
    const root = makeProjectWithDesign();
    const ctx = await buildDesignContext(join(root, '.zelto'), {
      sliceModule: '网络适配层 (ice)',
      writes: ['src/modules/ice/**'],
      requirementIds: ['N2'],
    });
    // core 是 ice 的依赖模块 → 应被列为只读参考
    const readonly = ctx!.modules.filter((m) => m.role === 'readonly');
    assert.ok(readonly.length >= 1, '应有只读参考模块');
  });

  it('没有已确认设计 → 返回 null（降级不阻断）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-no-design-'));
    const ctx = await buildDesignContext(join(root, '.zelto'), {
      sliceModule: 'm',
      writes: [],
      requirementIds: [],
    });
    assert.equal(ctx, null);
  });

  it('渲染：分「要改的」与「只读参考」两段', async () => {
    const root = makeProjectWithDesign();
    const ctx = await buildDesignContext(join(root, '.zelto'), {
      sliceModule: '网络适配层 (ice)',
      writes: ['src/modules/ice/**'],
      requirementIds: ['N2'],
    });
    const text = renderDesignContext(ctx);
    assert.match(text, /本片要改的模块/);
    assert.match(text, /不该改/);
    assert.match(text, /src\/modules\/ice/);
  });

  it('渲染：没有上下文时如实说没有', () => {
    assert.match(renderDesignContext(null), /没有找到/);
  });

  it('prompt 模板带 {{DESIGN_CONTEXT}} 占位符', () => {
    assert.match(SLICE_SPEC_PROMPT, /\{\{DESIGN_CONTEXT\}\}/);
  });
});

// ── ZD-033：只读语义在 prompt 里说清楚 ──────────────────────────────────

describe('ZD-033 规格 prompt 的「只读」语义', () => {
  it('prompt 要求「要改的」与「只读参考的」分开写', () => {
    assert.match(SLICE_SPEC_PROMPT, /只读参考/);
    assert.match(SLICE_SPEC_PROMPT, /不得修改/);
  });

  it('prompt 要求验收标准照抄需求里的验收口径', () => {
    assert.match(SLICE_SPEC_PROMPT, /验收口径/);
  });

  it('prompt 说明需求有多个侧面时要全落进验收标准', () => {
    assert.match(SLICE_SPEC_PROMPT, /多个侧面/);
  });
});

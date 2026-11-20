// 切片规格拿得到需求条目的正文（ZD-005）
//
// 病灶（nimrtc v1.4 演练，2026-11-20）：
//
//   `zelto spec draft` 给模型的输入里，需求部分只有一个 id 列表
//   （`["N5", "N9"]`）。模型拿到 "N5" 只能写通用套话 ——
//   实战里它把「**部署** coturn 参考实现，带 --require-tls 拒绝明文 TCP」
//   写成了「**实现**一个基本的 TURN 服务器，支持 RFC 5766 核心功能」。
//   方向都反了。
//
// 追溯链的断口：需求条目的正文在已确认的需求文档里，但从没被连到切片上。
//
// 这里覆盖：
//   1. 条目正文能从需求文档里按 id 取出来
//   2. 取不到时**如实说取不到**，不编造
//   3. prompt 里真的带上了正文
//   4. 提示词明确「需求说部署就别写成实现」

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractCriteria, renderCriteriaSection, extractCriterionIds, collectCriterionIds } from '../src/core/requirements/criteria.js';
import { renderRequirementDetails } from '../src/llm/generators/slice-spec.js';
import { SLICE_SPEC_PROMPT } from '../src/llm/prompts/slice-spec.js';

describe('需求条目正文提取', () => {
  it('按 id 从验收标准里取到正文', () => {
    const criteria = extractCriteria(
      '## 功能列表\n- [ ] N2 ICE-over-TCP：实现RFC 6544标准的TCP穿透支持\n',
      ['N2 ICE-over-TCP：实现RFC 6544标准的TCP穿透支持'],
      ['N2'],
    );
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0].id, 'N2');
    assert.match(criteria[0].text, /RFC 6544/);
  });

  it('同一条目多处出现 → 保留最长的那份（信息量最大的描述）', () => {
    const criteria = extractCriteria(
      '',
      ['N5 参考 TURN 部署：提供标准化TURN服务器配置模板', 'N5 参考 TURN 部署：提供标准化TURN服务器配置模板，一个命令拉起'],
      ['N5'],
    );
    assert.match(criteria[0].text, /一个命令拉起/);
  });

  it('取不到的条目 → 空正文（不编造）', () => {
    const criteria = extractCriteria('这里没有 D7', ['这里没有 D7'], ['D7']);
    assert.equal(criteria.length, 1);
    assert.equal(criteria[0].text, '');
  });

  it('ids 为空 → 不返回任何条目', () => {
    assert.deepEqual(extractCriteria('x', ['x'], []), []);
  });

  it('渲染：找不到正文的条目如实标注「找不到」', () => {
    const text = renderCriteriaSection([
      { id: 'N5', text: '部署 coturn' },
      { id: 'D7', text: '' },
    ]);
    assert.match(text, /- N5：部署 coturn/);
    assert.match(text, /D7.*找不到该条目的正文/);
  });

  it('渲染：空列表 → 明确说没有关联需求', () => {
    assert.match(renderCriteriaSection([]), /没有关联的需求条目/);
  });
});

describe('规格 prompt 带上了需求正文', () => {
  it('renderRequirementDetails 输出条目正文', () => {
    const text = renderRequirementDetails({
      sliceId: 's',
      title: 't',
      module: 'm',
      writes: [],
      version: 'v1',
      requirements: ['N5'],
      requirementDetails: [{ id: 'N5', text: '部署 coturn 参考实现，带 --require-tls' }],
    });
    assert.match(text, /N5：部署 coturn 参考实现，带 --require-tls/);
  });

  it('没有 requirementDetails → 明确说没有关联需求', () => {
    const text = renderRequirementDetails({
      sliceId: 's',
      title: 't',
      module: 'm',
      writes: [],
      version: 'v1',
      requirements: [],
    });
    assert.match(text, /没有关联的需求条目/);
  });

  it('prompt 模板带 {{REQUIREMENT_DETAILS}} 占位符', () => {
    assert.match(SLICE_SPEC_PROMPT, /\{\{REQUIREMENT_DETAILS\}\}/);
  });

  it('prompt 明确「需求说部署就别写成实现」', () => {
    assert.match(SLICE_SPEC_PROMPT, /需求说的是\*\*部署 \/ 配置 \/ 接入\*\*时，就不要写成「实现一个 X 服务器 \/ 库」/);
  });
});

describe('需求条目 id 的自动推导（ZD-005 遗留）', () => {
  it('从切片标题里提取 N5 / D3 / N2-1 这类 id', () => {
    assert.deepEqual(extractCriterionIds('N5：examples/turn-server/ 参考 TURN 部署'), ['N5']);
    assert.deepEqual(extractCriterionIds('D3+D4：默认设备策略与摄像头热插拔'), ['D3', 'D4']);
    assert.deepEqual(extractCriterionIds('N2-1：TCP 在 UDP 失败后才尝试'), ['N2-1']);
  });

  it('标题里没有条目 id → 空列表', () => {
    assert.deepEqual(extractCriterionIds('TCP穿透基础实现'), []);
  });

  it('collectCriterionIds 收集需求文档里真实存在的 id', () => {
    const ids = collectCriterionIds(
      '## 功能列表\n- [ ] N5 参考 TURN 部署：提供配置模板\n- [ ] D3 默认设备策略\n',
      ['N5 验收：一个命令拉起 TURN 服务器'],
    );
    assert.ok(ids.has('N5'));
    assert.ok(ids.has('D3'));
  });

  it('推导出的 id 必须能在需求文档里核实（不存在的不填）', () => {
    const real = collectCriterionIds('- N5：参考 TURN 部署', []);
    const candidates = extractCriterionIds('N5：参考 TURN 部署 / X9：不存在');
    const hit = candidates.filter((c) => real.has(c));
    assert.deepEqual(hit, ['N5']);
    assert.ok(!hit.includes('X9'));
  });
});

// ZD-002：LLM 装不下 prompt 时的降级重试
//
// 病灶（nimrtc v1.4，2026-11-20）：
//   第一次加完项目结构摘要后，摘要 1.1MB（`src/third_party` 一个目录就
//   14k 个文件，全被 `scanProject` 逐条喂）。DeepSeek 直接 400：
//
//     number of input tokens (373385) has exceeded max_seq_len (163840)
//
//   摘要**已经有**字符预算（`MAX_SUMMARY_CHARS`），但那个预算**猜不出**
//   模型端的 token 上限 —— 12k 字符在 DeepSeek 上安全，在上下文更小的
//   模型上未必。
//
// 修法：抓「装不下」→ 缩注入段 → 重试一次。
//
// C3：纯计算（只调注入进来的 LLM 适配器，不触网判定）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chatWithOverflowFallback, isTokenOverflowError, shrinkToBudget } from '../src/llm/overflow-fallback.js';
import { generateDesign } from '../src/llm/generators/design.js';
import type { LlmAdapter, LlmRequest, LlmResponse } from '../src/core/ports/llm.js';

function okResponse(content = '# 设计标题\n\n正文'): LlmResponse {
  return {
    content,
    model: 'test-model',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  };
}

/** 造一个「第一次报装不下、第二次成功」的适配器 */
function flakyAdapter(before: string, after: string): { adapter: LlmAdapter; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  const adapter: LlmAdapter = {
    async chat(request: LlmRequest): Promise<LlmResponse> {
      const user = request.messages.find((m) => m.role === 'user');
      prompts.push(user?.content ?? '');
      call++;
      if (call === 1) throw new Error(before);
      return okResponse(after);
    },
  };
  return { adapter, prompts };
}

describe('isTokenOverflowError —— 认得出「装不下」', () => {
  it('认得 DeepSeek 的那条', () => {
    assert.ok(
      isTokenOverflowError(
        new Error('number of input tokens (373385) has exceeded max_seq_len (163840)'),
      ),
    );
  });

  it('认得 OpenAI 的 context_length_exceeded', () => {
    assert.ok(isTokenOverflowError(new Error('context_length_exceeded')));
  });

  it('认得 Anthropic 的 prompt is too long', () => {
    assert.ok(isTokenOverflowError(new Error('prompt is too long: 250000 tokens > 200000 maximum')));
  });

  it('**不**把别的错误当成装不下', () => {
    assert.equal(isTokenOverflowError(new Error('401 Unauthorized')), false);
    assert.equal(isTokenOverflowError(new Error('ECONNREFUSED')), false);
    assert.equal(isTokenOverflowError(new Error('model not found')), false);
    assert.equal(isTokenOverflowError(null), false);
  });
});

describe('shrinkToBudget —— 缩注入段', () => {
  it('够短就原样返回', () => {
    assert.equal(shrinkToBudget('abc', 100), 'abc');
  });

  it('超了就砍到行边界（不留半行）', () => {
    const text = 'line1\nline2\nline3\nline4';
    const out = shrinkToBudget(text, 14);
    assert.ok(!out.includes('line3'), `不该留下第三行：${JSON.stringify(out)}`);
    assert.ok(out.startsWith('line1'));
  });

  it('截断后明说「被截断了」—— 模型不能不知道自己看到的是节选', () => {
    const out = shrinkToBudget('a'.repeat(500), 100);
    assert.match(out, /被截断/);
  });
});

describe('chatWithOverflowFallback —— 降级重试', () => {
  it('装不下 → 缩一半重试 → 成功', async () => {
    const { adapter, prompts } = flakyAdapter(
      'number of input tokens has exceeded max_seq_len',
      '# 标题\n\n成功',
    );

    const res = await chatWithOverflowFallback(
      adapter,
      (injectable) => `摘要：${injectable}\n需求：${'x'.repeat(1000)}`,
      'y'.repeat(1000),
      { maxRetries: 1, request: { messages: [{ role: 'system', content: 's' }] } },
    );

    assert.match(res.content, /成功/);
    assert.equal(prompts.length, 2, '应调了两次');
    // 第二次的注入段更短
    assert.ok(prompts[1].length < prompts[0].length, '重试时注入段应被缩短');
  });

  it('**只缩可缩的注入段** —— 需求正文原样保留', async () => {
    const { adapter, prompts } = flakyAdapter('prompt is too long', 'ok');
    const req = '需求正文'.repeat(100);

    await chatWithOverflowFallback(
      adapter,
      (injectable) => `摘要：${injectable}\n${req}`,
      'y'.repeat(1000),
      { maxRetries: 1, request: { messages: [{ role: 'system', content: 's' }] } },
    );

    assert.ok(prompts[1].includes(req), '需求正文不许被缩');
  });

  it('**别的错误不重试**（直接抛）', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async chat(): Promise<LlmResponse> {
        calls++;
        throw new Error('401 Unauthorized');
      },
    };

    await assert.rejects(
      chatWithOverflowFallback(adapter, (i) => i, 'x', { maxRetries: 3, request: { messages: [] } }),
      /401/,
    );
    assert.equal(calls, 1, '别的错误只该调一次');
  });

  it('重试用尽仍装不下 → 抛**原始**错误（不静默降级）', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      async chat(): Promise<LlmResponse> {
        calls++;
        throw new Error('number of input tokens has exceeded max_seq_len');
      },
    };

    await assert.rejects(
      chatWithOverflowFallback(adapter, (i) => i, 'x'.repeat(1000), {
        maxRetries: 2,
        request: { messages: [] },
      }),
      /exceeded max_seq_len/,
    );
    assert.equal(calls, 3, '原样 1 次 + 重试 2 次');
  });
});

describe('generateDesign —— 走降级重试', () => {
  it('第一次装不下 → 缩摘要重试 → 拿到设计', async () => {
    const { adapter, prompts } = flakyAdapter(
      'number of input tokens (373385) has exceeded max_seq_len (163840)',
      '# 真实标题\n\n## 目的\n\nx',
    );

    const design = await generateDesign(adapter, '需求正文', 'req-1', '摘要内容'.repeat(500));

    assert.equal(design.title, '真实标题');
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].length < prompts[0].length, '重试时应缩了摘要');
  });

  it('没有扫描结果时也能正常生成（不受降级逻辑影响）', async () => {
    const adapter: LlmAdapter = { async chat(): Promise<LlmResponse> { return okResponse('# ICE 传输层设计\n\n正文'); } };
    const design = await generateDesign(adapter, '需求正文', 'req-1');
    assert.equal(design.title, 'ICE 传输层设计');
  });
});

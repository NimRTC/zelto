// 事件类型的三方对账：契约 ↔ 代码 ↔ 审计摘要
//
// 事件类型是**契约**：`contracts/schemas/event-envelope.json` 的 enum 是真源。
// 代码里的 `EVENT_TYPES` 与审计摘要表都必须与它一致 ——
// 三者任一漂移，追溯链就会出现「代码能发、契约不认」或「有事件、审计读不懂」。
//
// 这个不变式以前靠人记着。ADR-036 加的 4 个事件类型（contract.* 与
// version.regression_*）就从未进过 schema enum —— 代码能发、契约不认，
// 一直到这次补齐才暴露出来。
//
// 现在它由三层强制：
// 1. `EVENT_TYPES` 是运行时数组（可枚举）；
// 2. 审计摘要表的键类型是 `Record<EventType, ...>` —— 少一种摘要**编译不过**；
// 3. 本文件在测试期把三方对账，漏一处就红。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EVENT_TYPES, EventStream, type EventType } from '../src/core/events/stream.js';
import { AuditTrail } from '../src/core/audit/trail.js';

const TEST_DIR = join(tmpdir(), `zelto-event-parity-${Date.now()}`);
const SCHEMA_PATH = join(process.cwd(), 'contracts', 'schemas', 'event-envelope.json');

interface EventEnvelopeSchema {
  properties?: {
    type?: {
      enum?: string[];
    };
  };
}

async function readSchemaEnum(): Promise<string[]> {
  const raw = await readFile(SCHEMA_PATH, 'utf-8');
  const schema = JSON.parse(raw) as EventEnvelopeSchema;
  const values = schema.properties?.type?.enum;
  assert.ok(Array.isArray(values), 'event-envelope.json 的 properties.type.enum 必须是数组');
  return values;
}

/**
 * 文档里「事件类型总数」的表述口径。
 *
 * 每个模式捕获一个数字，这些数字必须都等于代码里的事件类型数量。
 * 刻意逐条列出而不是用一个宽泛的正则 —— 文档里还有别的「N 种」
 * （状态机的 9 种事件、10 种事件，6 种状态），那些不是事件类型清单的总数，
 * 宽泛匹配会把它们误判成漂移。
 */
const DOC_COUNT_PATTERNS: RegExp[] = [
  /(\d+)\s*种事件类型/g,
  /(\d+)\s*种事件的 append-only/g,
  /(\d+)\s*种事件摘要/g,
  /(\d+)\s*种事件 ·/g,
  /(\d+)\s*种 append-only 事件/g,
  /(\d+)\s*种事件）/g,
  /(\d+)\s*种事件各定义摘要/g,
  /(\d+)\s*种之一/g,
  /事件类型（(\d+)\s*种）/g,
];

describe('事件类型契约一致性', () => {
  it('schema 的 enum 是事件类型的真源 —— 代码不得超出它', async () => {
    const schemaEnum = await readSchemaEnum();
    const extra = EVENT_TYPES.filter((t) => !schemaEnum.includes(t));
    assert.deepEqual(
      extra,
      [],
      `代码里有 ${extra.length} 个事件类型不在契约 enum 里：${extra.join(', ')} —— 契约才是真源，先改契约`,
    );
  });

  it('契约里的每个事件类型都必须在代码里存在', async () => {
    const schemaEnum = await readSchemaEnum();
    const missing = schemaEnum.filter((t) => !(EVENT_TYPES as readonly string[]).includes(t));
    assert.deepEqual(
      missing,
      [],
      `契约声明了 ${missing.length} 个代码里没有的事件类型：${missing.join(', ')} —— 代码漏实现了`,
    );
  });

  it('事件类型集合没有重复', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of EVENT_TYPES) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
    assert.deepEqual(dupes, [], `事件类型重复：${dupes.join(', ')}`);
  });

  it('文档声明的事件类型数量与代码一致', async () => {
    const docs = [
      'docs/zelto-场景功能地图.md',
      'docs/zelto-技术架构.md',
      'docs/zelto-项目目标.md',
      'README.zh-CN.md',
    ];
    for (const doc of docs) {
      const raw = await readFile(join(process.cwd(), doc), 'utf-8');
      for (const pattern of DOC_COUNT_PATTERNS) {
        // matchAll 会推进正则的 lastIndex —— 复用同一个正则对象前必须重置，
        // 否则第二个文档会从上一个文档的结束位置继续扫，漏检。
        pattern.lastIndex = 0;
        for (const m of raw.matchAll(pattern)) {
          assert.equal(
            Number(m[1]),
            EVENT_TYPES.length,
            `${doc} 里的「${m[0]}」与代码里的 ${EVENT_TYPES.length} 种事件类型对不上`,
          );
        }
      }
    }
  });
});

describe('每种事件类型都有专属审计摘要', () => {
  let events: EventStream;
  let audit: AuditTrail;

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    events = new EventStream(join(TEST_DIR, 'events'));
    audit = new AuditTrail(events);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('不落进兜底文本 `Event: <type>`', async () => {
    // 摘要表的键类型是 `Record<EventType, ...>`，少一种就编译不过；
    // 这里从**运行时**再验一遍：走真实事件流，确认审计真的产出了人话摘要。
    const payload: Record<string, unknown> = {
      module: 'src/core',
      fileCount: 3,
      reason: '样例',
      from: 'draft',
      to: 'confirmed',
      decision: 'allow',
      path: 'src/a.ts',
      requestedBy: 'zelto',
      revokedBy: 'human',
      feedback: '样例反馈',
      version: 'v1',
      phase: 1,
      stage: 'running',
      strategy: 'sequential',
      files: ['a.ts'],
      slices: ['s1'],
      versions: ['v1'],
      cycle: ['a', 'b'],
      blockedBy: ['s0'],
      commandCount: 1,
      passed: true,
      totalDurationMs: 1,
      count: 1,
      class: 'environment',
      summary: '样例',
      text: '样例',
      answer: '样例',
      type: 'question',
      question: '样例',
      model: 'm',
      tokens: 1,
      amount: 1,
      elapsed: 1,
      note: '样例',
      attempt: 1,
      command: 'npm test',
      sliceId: 's1',
      dependsOn: ['s0'],
      sliceIds: ['s1'],
      contracts: ['a.json'],
      breaking: 0,
      tests: 1,
      regressed: 0,
      degraded: 0,
      missing: 0,
      tampered: [],
      violations: [],
      error: '',
    };

    for (const type of EVENT_TYPES) {
      const sliceId = `probe-${type}`;
      await events.append(sliceId, type as EventType, 'zelto', payload);

      const report = await audit.forSlice(sliceId);
      const entry = report.entries[0];
      assert.ok(entry, `事件类型 "${type}" 应该产生审计条目`);
      assert.notEqual(
        entry.summary,
        `Event: ${type}`,
        `事件类型 "${type}" 缺少专属摘要，退化成了兜底文本`,
      );
    }
  });
});

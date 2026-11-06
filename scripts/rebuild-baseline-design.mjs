// 重建项目基线设计（as-built 基线）
//
// 做什么：
//   1. 读某个方案的基线设计，在其正文上做**确定性的最小改写**（逐条带断言的替换）
//   2. 用 zelto 自己的判定路径（parse → derive → scan → report）验一遍
//   3. 写成新设计文档（supersedes 旧基线），旧基线标 superseded
//   4. 追加 append-only 事件（draft.created / draft.confirmed）
//
// 为什么做成「多方案」：
//   每次基线重建都是一次**人拍板的决策**，对应一份 ADR。
//   方案写在这里，脚本保持可重跑、可审计——事后能回答
//   「当时那份基线是怎么从上一份改出来的」。
//
// 方案：
//   adr-030  基线 prj-1793947716547 → 5 个 core 子模块 + 修两条真偏离（已落地）
//   adr-031  基线 prj-1793964817452 → SliceType 归位 core/slice 后，core 内不再有 gate 入边
//
// 依据：docs/adr-030-baseline-rebuild-and-arch-policy.md
//       docs/adr-031-slice-type-ownership.md
//
// 用法：node scripts/rebuild-baseline-design.mjs --plan <adr-030|adr-031> [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDesignModules } from '../dist/core/design/parse.js';
import { deriveModules } from '../dist/core/design/derive.js';
import { scanArchitecture } from '../dist/core/arch/scan.js';
import { buildArchitectureReport } from '../dist/core/arch/report.js';
import { EventStream } from '../dist/core/events/stream.js';

const ROOT = join(import.meta.dirname, '..');
const DESIGN_DIR = join(ROOT, '.zelto', 'design');
const EVENTS_DIR = join(ROOT, '.zelto', 'events');
const REQUIREMENT_ID = '__project__';
const DRY_RUN = process.argv.includes('--dry-run');

/** 5 个子模块：文件范围写「子目录名 + 两星通配」，依赖声明与实际 import 边逐条对齐 */
const SUBS = [
  {
    name: 'src/core/gate',
    desc: '门禁执行与签字：门控判定、签字请求与审批、结果落事件流。',
    deps: ['src/core/events', 'src/core/slice'],
  },
  {
    name: 'src/core/policy',
    desc: '策略引擎：规则匹配、保护域判定、策略哈希锚点校验。',
    deps: [],
  },
  {
    name: 'src/core/sched',
    desc: '调度引擎：切片准入、依赖阻塞、并行续跑。',
    deps: ['src/core/events', 'src/core/policy', 'src/core/slice'],
  },
  {
    name: 'src/core/slice',
    desc: '切片状态机：切片数据、状态迁移，以及切片类型（code / docs / config / refactor）的定义。',
    deps: [],
  },
  {
    name: 'src/core/events',
    desc: '事件流：append-only 事件信封、写入与读取。',
    deps: [],
  },
];

/** ADR-030 用的 5 个子模块声明（slice 当时还依赖 gate） */
const SUBS_ADR030 = SUBS.map((s) =>
  s.name === 'src/core/slice' ? { ...s, deps: ['src/core/gate'] } : s,
);

/** 依赖关系图的行：模块 → 依赖模块 */
function graphLines(subs) {
  return [
    'bin → [无]',
    'contracts/schemas → [无]',
    'docs → [无]',
    'misc/vim → [无]',
    'policy → [无]',
    'scripts → [无]',
    'specs/slices → [无]',
    'syntax → [无]',
    '',
    'src/adapters → src/core/ports, src/core/events',
    'src/cli → src/core, src/llm, src/adapters',
    `src/core → ${subs.map((s) => s.name).join(', ')}`,
    ...subs.map((s) => `${s.name} → ${s.deps.length ? s.deps.join(', ') : '[无]'}`),
    'src/hook → [无]',
    'src/llm → src/core',
    'tests → src/core, src/cli, src/hook, src/adapters, src/llm',
  ];
}

/** 重建方案 */
const PLANS = {
  'adr-030': {
    base: 'prj-1793947716547',
    basis: 'ADR-030 §3（Q1 子目录模块 + Q3 两条真偏离修正）',
    subs: SUBS_ADR030,
    edits: [
      {
        section: 'src/core',
        from: '- **依赖模块**：[无]（作为核心层，被其他模块依赖）',
        to: `- **依赖模块**：${SUBS_ADR030.map((s) => `\`${s.name}\``).join(', ')}`,
      },
      { section: 'src/hook', from: '- **依赖模块**：`src/core`', to: '- **依赖模块**：[无]' },
      {
        section: 'tests',
        from: '- **依赖模块**：`src/core`, `src/cli`, `src/hook`, `src/adapters`',
        to: '- **依赖模块**：`src/core`, `src/cli`, `src/hook`, `src/adapters`, `src/llm`',
      },
    ],
    // 紧跟 src/core 段落之后插入 5 个子模块段落
    inserts: [
      {
        after: 'src/core',
        text: SUBS_ADR030.map(
          (s) =>
            `\n### ${s.name}\n- **职责**：${s.desc}\n- **文件路径**：\`${s.name}/**/*.ts\`\n- **依赖模块**：${
              s.deps.length ? s.deps.map((d) => `\`${d}\``).join(', ') : '[无]'
            }`,
        ).join('\n\n'),
      },
    ],
  },

  'adr-031': {
    base: 'prj-1793964817452',
    basis: 'ADR-031 §3（SliceType 归位 core/slice 后，core 内部不再有指向 gate 的 import 边）',
    subs: SUBS,
    edits: [
      {
        section: 'src/core',
        from: '- **依赖模块**：`src/core/gate`, `src/core/policy`, `src/core/sched`, `src/core/slice`, `src/core/events`',
        to: '- **依赖模块**：`src/core/policy`, `src/core/sched`, `src/core/slice`, `src/core/events`',
      },
      { section: 'src/core/slice', from: '- **依赖模块**：`src/core/gate`', to: '- **依赖模块**：[无]' },
    ],
    inserts: [],
  },
};

/** 在某个 `### <name>` 段落里做替换；找不到或命中多次都算失败 */
function replaceInSection(body, section, oldStr, newStr) {
  const re = new RegExp(`(### ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?)(?=\\n### |\\n## |$)`);
  const m = re.exec(body);
  if (!m) throw new Error(`找不到段落：${section}`);
  const block = m[1];
  const hits = block.split(oldStr).length - 1;
  if (hits !== 1) throw new Error(`段落 ${section} 里 "${oldStr}" 命中 ${hits} 次（应为 1 次）`);
  return body.replace(m[1], block.replace(oldStr, newStr));
}

/** 在某个 `### <name>` 段落之后插入一段文本 */
function insertAfterSection(body, section, text) {
  const re = new RegExp(`(### ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?)(?=\\n### |\\n## |$)`);
  const m = re.exec(body);
  if (!m) throw new Error(`找不到段落：${section}`);
  return body.replace(m[1], m[1] + text);
}

function buildBody(baseBody, plan) {
  let body = baseBody;

  for (const edit of plan.edits) {
    body = replaceInSection(body, edit.section, edit.from, edit.to);
  }

  for (const insert of plan.inserts) {
    body = insertAfterSection(body, insert.after, insert.text);
  }

  // 依赖关系图同步更新
  const graphOld = new RegExp('## 模块依赖关系图\\n```\\n[\\s\\S]*?\\n```');
  if (!graphOld.test(body)) throw new Error('找不到模块依赖关系图');
  const graphNew = ['## 模块依赖关系图', '```', ...graphLines(plan.subs), '```'].join('\n');
  body = body.replace(graphOld, graphNew);

  return body;
}

// ─── 跑起来 ──────────────────────────────────────────────────────────────────

const planIdx = process.argv.findIndex((a) => a === '--plan' || a.startsWith('--plan='));
const planName =
  planIdx === -1
    ? null
    : process.argv[planIdx].includes('=')
      ? process.argv[planIdx].split('=')[1]
      : process.argv[planIdx + 1];
if (!planName || !PLANS[planName]) {
  console.error(`必须指定 --plan <${Object.keys(PLANS).join('|')}>`);
  process.exit(2);
}
const plan = PLANS[planName];

const baseDoc = JSON.parse(readFileSync(join(DESIGN_DIR, `${plan.base}.json`), 'utf-8'));
const newBody = buildBody(baseDoc.body, plan);

const modules = deriveModules({ body: newBody, modules: [] });
console.log(`方案：${planName}   基线：${plan.base}`);
console.log(`模块数：${modules.length}`);
for (const m of modules) {
  console.log(`  - ${m.name}  deps=[${m.dependencies.join(', ')}]`);
}

const specs = modules.map((m) => ({
  name: m.name,
  description: m.description,
  filePatterns: m.filePatterns,
  dependencies: m.dependencies,
}));
const scan = scanArchitecture(ROOT, specs);
const report = buildArchitectureReport(specs, scan);
const counts = {};
for (const d of report.deviations) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
console.log(`偏离总数：${report.deviations.length}  构成：${JSON.stringify(counts)}`);
for (const d of report.deviations) {
  console.log(`  [${d.kind}] ${d.from} → ${d.to}  ${d.detail}`);
}

if (DRY_RUN) {
  console.log('\n--dry-run：未写盘。');
  process.exit(0);
}

const newId = `prj-${Date.now()}`;
const now = new Date().toISOString();
const doc = {
  id: newId,
  requirementId: REQUIREMENT_ID,
  title: baseDoc.title,
  body: newBody,
  modules,
  status: 'confirmed',
  supersedes: plan.base,
  createdAt: now,
  confirmedAt: now,
};
writeFileSync(join(DESIGN_DIR, `${newId}.json`), JSON.stringify(doc, null, 2), 'utf-8');

// 旧基线顶替：标 superseded（与 `zelto project design` 同一套语义）
const baseDocUpdated = { ...baseDoc, status: 'superseded' };
writeFileSync(join(DESIGN_DIR, `${plan.base}.json`), JSON.stringify(baseDocUpdated, null, 2), 'utf-8');

// 事件（C4）：这次基线重建改了什么、谁批准的
const events = new EventStream(EVENTS_DIR);
const key = `draft-design-${newId}`;
await events.append(key, 'draft.created', 'zelto', {
  kind: 'design',
  id: newId,
  title: doc.title,
  requirementId: REQUIREMENT_ID,
  supersedes: plan.base,
  moduleCount: modules.length,
  basis: plan.basis,
});
await events.append(key, 'draft.confirmed', 'human', {
  kind: 'design',
  id: newId,
  title: doc.title,
  basis: plan.basis,
});

console.log(`\n新基线设计：${newId}（supersedes ${plan.base}）`);
console.log(`事件已追加：.zelto/events/${key}/events.jsonl`);

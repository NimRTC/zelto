// 草稿评审视图 —— 规划确认体验（G-5）
//
// 「require / design / plan 每次吐一大坨 markdown，人要通读才能 confirm」
// 是 G-5。这里给出另一条路：
//
//   zelto require show <id>          摘要 + 决策点
//   zelto require show <id> --diff   再加上与上一版的差异
//   zelto require show <id> --full   再加上正文全文
//
// 决策点 = 需要人拍板的地方（验收标准 / 模块 / 依赖 / 版本 / 切片）。
// 差异 = refine 之后到底改了哪几行。

import { getDefaultFormatter, OutputFormat } from '../output-formatter.js';
import { colors } from '../color.js';
import { RequirementStore } from '../../core/requirements/store.js';
import { DesignStore } from '../../core/design/store.js';
import { VersionStore } from '../../core/version/store.js';
import {
  RevisionStore,
  buildDraftReview,
  diffOps,
  renderFacts,
  renderUnifiedDiff,
  type DecisionPoint,
  type DraftFacts,
  type DraftKind,
  type DraftReview,
} from '../../core/review/index.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import type { DesignDoc } from '../../core/design/types.js';
import type { VersionPlan } from '../../core/version/types.js';
import { ZELTO_DIR } from './shared.js';

// ─── 事实适配 ────────────────────────────────────────────────────────────────

export function requirementFacts(doc: RequirementDoc): DraftFacts {
  return {
    title: doc.title,
    userInput: doc.userInput,
    spec: doc.spec,
    acceptanceCriteria: doc.acceptanceCriteria,
  };
}

export function designFacts(doc: DesignDoc): DraftFacts {
  return {
    title: doc.title,
    body: doc.body,
    modules: doc.modules.map((m) => ({
      name: m.name,
      description: m.description,
      filePatterns: m.filePatterns,
      dependencies: m.dependencies,
    })),
  };
}

export function planFacts(plan: VersionPlan): DraftFacts {
  return {
    title: plan.title,
    versions: plan.versions.map((v) => ({
      version: v.version,
      description: v.description,
      dependsOn: v.dependsOn,
      slices: v.slices.map((s) => ({
        id: s.id,
        title: s.title,
        module: s.module,
        writes: s.writes,
      })),
    })),
  };
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<DraftKind, string> = {
  requirement: '需求',
  design: '设计',
  plan: '版本计划',
};

const POINT_KIND_LABEL: Record<string, string> = {
  acceptance: '验收标准',
  section: '规格章节',
  module: '模块',
  dependency: '模块依赖',
  version: '版本',
  slice: '切片',
};

const STATUS_MARK: Record<string, string> = {
  added: '+',
  removed: '-',
  changed: '~',
  unchanged: '·',
};

function statusColor(status: string): (s: string) => string {
  if (status === 'added') return colors.green;
  if (status === 'removed') return colors.red;
  if (status === 'changed') return colors.yellow;
  return colors.dim;
}

/**
 * 渲染评审内容。
 *
 * @param review 评审结论
 * @param facts 当前稿事实
 * @param previousFacts 上一稿事实（给了才渲染差异）
 * @param fullText 正文全文（--full 时打印）
 */
export function renderReview(
  review: DraftReview,
  facts: DraftFacts,
  previousFacts: DraftFacts | null,
  fullText: string | null,
): string {
  const out: string[] = [];

  out.push('');
  out.push(`  ${colors.bold(colors.cyan(KIND_LABEL[review.kind]))} ${review.id} · ${review.status}`);
  out.push(`  ${colors.dim('─'.repeat(56))}`);

  out.push('');
  out.push(`  ${colors.bold('摘要')}`);
  for (const line of review.summary) {
    out.push(`    ${colors.dim('·')} ${line}`);
  }

  out.push('');
  out.push(`  ${colors.bold('决策点')} ${colors.dim('（只看这些就能拍板）')}`);
  const grouped = groupPoints(review.decisionPoints);
  if (grouped.size === 0) {
    out.push(`    ${colors.dim('（无）')}`);
  } else {
    for (const [kind, points] of grouped) {
      out.push(`    ${colors.bold(POINT_KIND_LABEL[kind] ?? kind)}`);
      for (const point of points) {
        const mark = statusColor(point.status)(STATUS_MARK[point.status] ?? '·');
        out.push(`      ${mark} ${point.label}`);
        if (point.detail) {
          out.push(`        ${colors.dim(point.detail)}`);
        }
      }
    }
  }

  if (previousFacts && review.diff) {
    out.push('');
    out.push(`  ${colors.bold('差异')} ${colors.dim('（相对上一版）')}`);
    const ops = diffOps(renderFacts(review.kind, previousFacts), renderFacts(review.kind, facts));
    const unified = renderUnifiedDiff(ops);
    if (unified) {
      for (const line of unified.split('\n')) {
        const prefix = line.startsWith('+')
          ? colors.green(line)
          : line.startsWith('-')
            ? colors.red(line)
            : colors.dim(line);
        out.push(`    ${prefix}`);
      }
    } else {
      out.push(`    ${colors.dim('（无差异）')}`);
    }
  }

  if (fullText) {
    out.push('');
    out.push(`  ${colors.bold('正文全文')}`);
    for (const line of fullText.split('\n')) {
      out.push(`    ${line}`);
    }
  }

  out.push('');
  return out.join('\n');
}

function groupPoints(points: DecisionPoint[]): Map<string, DecisionPoint[]> {
  const grouped = new Map<string, DecisionPoint[]>();
  for (const point of points) {
    const list = grouped.get(point.kind) ?? [];
    list.push(point);
    grouped.set(point.kind, list);
  }
  return grouped;
}

// ─── 命令入口 ────────────────────────────────────────────────────────────────

export interface ShowOptions {
  diff?: boolean;
  full?: boolean;
}

/**
 * `zelto require show <id>` / `zelto design show <id>` / `zelto plan show <id>`
 */
export async function showDraft(
  kind: DraftKind,
  id: string,
  opts: ShowOptions = {},
): Promise<number> {
  const f = getDefaultFormatter();
  const revisions = new RevisionStore(ZELTO_DIR);

  let status: string;
  let facts: DraftFacts;
  let fullText: string;

  try {
    if (kind === 'requirement') {
      const store = new RequirementStore(ZELTO_DIR);
      if (!(await store.exists(id))) {
        f.error('NOT_FOUND', `Requirement "${id}" not found.`);
        return 1;
      }
      const doc = await store.read(id);
      status = doc.status;
      facts = requirementFacts(doc);
      fullText = doc.spec;
    } else if (kind === 'design') {
      const store = new DesignStore(ZELTO_DIR);
      if (!(await store.exists(id))) {
        f.error('NOT_FOUND', `Design "${id}" not found.`);
        return 1;
      }
      const doc = await store.read(id);
      status = doc.status;
      facts = designFacts(doc);
      fullText = doc.body;
    } else {
      const store = new VersionStore(ZELTO_DIR);
      if (!(await store.exists(id))) {
        f.error('NOT_FOUND', `Plan "${id}" not found.`);
        return 1;
      }
      const plan = await store.read(id);
      status = plan.status;
      facts = planFacts(plan);
      fullText = '';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('READ_FAILED', `Cannot read ${kind} "${id}": ${msg}`);
    return 1;
  }

  const revisionMetas = await revisions.list(kind, id);
  const previousPayload = await revisions.latestPayload(kind, id);
  const previousFacts = previousPayload ? (previousPayload as DraftFacts) : null;

  const review = buildDraftReview(
    kind,
    id,
    status,
    facts,
    previousFacts,
    revisionMetas.length,
  );

  // JSON / YAML 模式：给机器看的完整评审
  if (f.getFormat() !== OutputFormat.Terminal) {
    f.data({
      kind: review.kind,
      id: review.id,
      title: review.title,
      status: review.status,
      summary: review.summary,
      decisionPoints: review.decisionPoints,
      changedCount: review.changedCount,
      revisionCount: review.revisionCount,
      diff: review.diff,
    });
    return 0;
  }

  const showDiff = opts.diff ?? true;
  const text = renderReview(
    review,
    facts,
    showDiff ? previousFacts : null,
    opts.full ? fullText : null,
  );
  process.stdout.write(text + '\n');

  return 0;
}

// 人的意见 —— 从事件流读出来，喂给下一轮 agent（ADR-094 §5）
//
// 病灶：zelto 的签字门本来只有「通过 / 否决」两个动作。人审出毛病时，
// 说「方向对，但 3 号那个 null 处理不对」——zelto 没有对应的动作。
// 选 `--reject` 整片作废；选 `--revoke` 意见被丢掉。
//
// 结果是：**人给的意见是这条追溯链上唯一不由工具生成的判断，
// 而它从来没进过 agent 的上下文。** 重跑的 agent 只能从头再摸一遍，
// 甚至可能把已经对的东西改错。
//
// 这个模块解决的就是这件事：**把人的意见（原文，不加工）交给下一轮 agent**。
//
// 读的是**事件流**（C4：追溯的唯一证据载体），不是切片状态文件 ——
// 意见是「发生过的事」，不是「切片的当前属性」（ADR-094 D2）。
// 同一个切片可以被退回三次，三条意见都要在。
//
// 与 `core/gate/feedback.ts`（ZD-013）是同一条路的第二个来源：
// 那一个送「机器验失败」的证据，这一个送「人提意见」的原文。
//
// C3: 纯读取 + 纯文本加工，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import type { EventEnvelope, EventStream } from '../events/stream.js';

/** 一次退回的语义分类 */
export type HumanFeedbackKind =
  /** `sign.revised` —— 退回重跑：实现方向对，细节要改 */
  | 'revise'
  /** `sign.returned` —— 退回上游：方向不对，要改规格 */
  | 'return';

/** 一条人的意见 */
export interface HumanFeedback {
  /** 这次退回的语义分类 */
  kind: HumanFeedbackKind;
  /** 人的意见原文 */
  comment: string;
  /** 谁提的 */
  decidedBy: string;
  /** 什么时候提的（ISO 8601） */
  at: string;
  /** 对应的签字请求 id */
  signId: string | null;
}

/** 反馈里最多带多少字符的意见 —— 上下文有限，全塞进去会挤掉规格 */
const MAX_COMMENT_CHARS = 4000;

/**
 * 从事件流里读出「人提的意见」。
 *
 * **只看最近一次退回** —— 与 ZD-013 的门禁反馈同理：
 * 更早的意见要么已被后续修复，要么已被更新的意见取代。
 * 全带过去会让 agent 去追一个已经不存在的问题。
 *
 * 取「最近一次」的判据：事件流是 append-only 的，末尾的事件最新。
 * 但**不是**「最后一条 `sign.revised`」—— `sign.returned` 也算意见，
 * 且两者可能交替（退回上游 → 改了规格 → 又退回重跑）。
 * 所以取**所有意见类事件里最靠后的那一条**。
 */
export async function readHumanFeedback(
  events: EventStream,
  sliceId: string,
): Promise<HumanFeedback[]> {
  const all = await events.read(sliceId);

  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    const kind = feedbackKindOf(e);
    if (!kind) continue;

    const comment = extractComment(e);
    // 意见为空 —— 不算意见。
    //
    // `sign --revise` 要求 `--comment` 非空，所以正常路径不会走到这。
    // 但事件流是**文件** —— 人工编辑过的、别的工具写的、老版本写的，
    // 都可能有空的 comment。空意见喂给 agent 是纯噪声（占位置、没内容），
    // 不如没有。
    if (!comment) continue;

    return [
      {
        kind,
        comment: comment.slice(0, MAX_COMMENT_CHARS),
        decidedBy: typeof e.actor === 'string' && e.actor ? e.actor : 'human',
        at: e.ts,
        signId: readSignId(e),
      },
    ];
  }

  return [];
}

/** 事件类型 → 意见分类。非意见类事件返回 null。 */
function feedbackKindOf(e: EventEnvelope): HumanFeedbackKind | null {
  if (e.type === 'sign.revised') return 'revise';
  if (e.type === 'sign.returned') return 'return';
  return null;
}

/**
 * 从事件 payload 里取意见原文。
 *
 * 字段名是 `comment` —— 与 `sign.requested` / `sign.approved` /
 * `sign.rejected` / `sign.revoked` 一致（既有签字事件的既有约定）。
 */
function extractComment(e: EventEnvelope): string | null {
  const raw = e.payload?.comment;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 取签字请求 id —— 追溯块与 PR body 要引用它。 */
function readSignId(e: EventEnvelope): string | null {
  const raw = e.payload?.signId;
  return typeof raw === 'string' && raw ? raw : null;
}

/**
 * 把人的意见渲染成给 agent 看的一段话。
 *
 * **原文，不加工** —— 与 ZD-013 的门禁反馈同一条原则：
 * 人转述会把关键细节转掉。人写「parseInput 的 null 处理不对，注意边界」，
 * 工具转成「请修复输入解析」就丢掉了「null」和「边界」这两个锚点。
 *
 * 「不要猜」那句是必须的 —— 否则 agent 会把「注意边界」自行解释成
 * 「加几个 if」。
 */
export function renderHumanFeedback(feedback: HumanFeedback[]): string[] {
  if (feedback.length === 0) return [];
  const lines: string[] = [
    '## Human feedback — the reviewer asked for changes',
    '',
    'The previous review of this slice was sent back with the notes below.',
    'Address every point; do not guess what the reviewer meant.',
    '',
  ];
  for (const f of feedback) {
    const label = f.kind === 'revise' ? '退回重跑（sign.revised）' : '退回上游（sign.returned）';
    lines.push(`### ${label} — ${f.at}，by ${f.decidedBy}`);
    lines.push('');
    lines.push('```');
    lines.push(f.comment);
    lines.push('```');
    lines.push('');
  }
  return lines;
}

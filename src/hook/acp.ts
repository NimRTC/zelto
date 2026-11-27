// zelto hook —— ACP 协议适配层（ADR-133）
//
// 作用：把 ACP 的 `session/request_permission` 载荷翻译成**统一载荷**，
// 再把**统一判决**翻译回 ACP 的 `RequestPermissionOutcome`。
//
// 与 `harness.ts`（Claude Code / Cursor / Codex）**完全同构** ——
// 那三个是「hook 的 stdin/stdout 形状」，这一个是「ACP 的 JSON-RPC 形状」：
//
//   ACP request_permission ──▶ normalizeAcpToolCall() ──▶ 统一载荷 {tool_name, tool_input}
//                                                          │
//                                                          ▼
//                                           judgeWriteTargets()  ← 不变量在这（一行不改）
//                                                          │
//                                                          ▼
//   ACP response ◀── renderAcpPermission(判决) ◀────────── 统一判决
//
// **这一层只做翻译，不做任何判定**（ADR-083 §1）。
//
// ── 为什么判定不放在 adapter 里 ─────────────────────────────────────
//
// 判定从 `src/hook/` 漂到 `src/adapters/`，下一次审计会发现「同一个结论
// 两处产出」。所以 adapter 只负责把 ACP 的东西搬进搬出，判定的形状与位置
// 一律由 `src/hook/` 决定。
//
// ── 两条硬规则（ADR-133 决策四）────────────────────────────────────────
//
// 1. **永不发 `allow_always`** —— 写集预约是**逐写**判定的，
//    「以后都允许」与它直接冲突。
// 2. **找不到路径/命令就拒绝** —— 不认识 ≠ 放行（ADR-083 §2 同原则）。

import type { NormalizedPayload } from './harness.js';
import {
  extractWriteTargets,
  judgeWriteTargets,
  type PreToolContext,
  type PreToolVerdict,
} from './pretool.js';

/**
 * ACP 的 `ToolCallKind`（规范 v1）。
 *
 * 取值来自 ACP 的 `ToolKind` 封闭集合。这里只列**本模块认识的**；
 * 规范里还有 `switch_mode` 与 `other`，它们落在 `other` 分支。
 */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/**
 * ACP `request_permission` 里的一次工具调用。
 *
 * 只取本模块需要的字段；其余字段（content / status …）
 * 属于**展示元数据**，不参与判定。
 *
 * 规范明说：「`name` 与 `kind` 是展示元数据，不授予任何权限」——
 * 所以判定**不能**依赖 `name`，只能依赖 `kind` + `rawInput` 里的实际内容。
 *
 * **但 `title` 是个例外**（落地补充，2026-11-27）：实测 `cursor-agent`
 * 把**写入路径放在 `title` 里**（形如 ``Edit `src/foo.ts` ``），
 * `rawInput` 与 `locations` 都是空的。所以 `title` 参与**路径提取**
 * —— 不是参与「判定」，只是「找路径」这条兜底链上的一环。
 */
export interface AcpToolCall {
  /** ACP 的工具类别 */
  kind?: string;
  /** 工具名（不可信：规范说它不授予权限） */
  name?: string;
  /** 工具的原始输入 —— 路径/命令的真正来源 */
  rawInput?: unknown;
  /** 工具涉及的位置（规范里的 `locations`） */
  locations?: Array<{ path?: string; line?: number | null }>;
  /**
   * 展示用的一句话标题。
   *
   * **实测有些 agent 把写入路径放在这里**（cursor-agent 的
   * `` Edit `path` `` / `Write path`）。所以它参与路径提取。
   */
  title?: string | null;
  /**
   * 工具调用的内容块（规范里的 `content`）。
   *
   * **实测 cursor-agent 的写入信息在这**：`content: [{ type: "diff",
   * path: "<路径>", oldText, newText }]` —— 这是**结构化**的路径，
   * 比 `title` 可靠得多。
   */
  content?: unknown;
}

/**
 * ACP 的一个权限选项（agent 提供的候选）。
 *
 * 规范里的 `kind` 只有四种：`allow_once` / `allow_always` /
 * `reject_once` / `reject_always`。
 */
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/**
 * 归一化 ACP 工具类别 → 统一工具名。
 *
 * - `edit` / `delete` / `move` → `Write`
 *   （三者都是「往文件里写/挪东西」，写目标提取对它们是同一条分支）
 * - `execute` → `Bash`（命令里的写目标靠静态分析）
 * - `read` / `search` / `fetch` / `think` / `switch_mode` / `other` → `read_only`
 *
 * **为什么不认 `name`**：ACP 规范明确说 `name` 与 `kind` 是展示元数据，
 * 「不授予任何权限」。拿 `name` 做判定 = 拿 agent 自报的字符串做判定 ——
 * 那等于让 agent 自己决定要不要被拦。
 */
function normalizeKind(kind: string | undefined): { tool: string; readOnly: boolean } {
  switch (kind) {
    case 'edit':
    case 'delete':
    case 'move':
      return { tool: 'Write', readOnly: false };
    case 'execute':
      return { tool: 'Bash', readOnly: false };
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
    case 'switch_mode':
      return { tool: 'Read', readOnly: true };
    default:
      // `other` 与**任何不认识的 kind** —— 保守处理：
      // 不标只读（否则读工具的豁免会把未知写工具也放过），
      // 交给下面的「找路径字段」兜底；找不到就拒绝。
      return { tool: 'Write', readOnly: false };
  }
}

/**
 * 从 ACP 的 `rawInput` 里挑出路径字段。
 *
 * **字段名不认死**：ACP 规范不约束 `rawInput` 的形状（「任何 JSON 值都被接受」），
 * 所以各家 agent 的字段名可能不同。这里按**候选列表**逐个找。
 *
 * 候选来自 ACP 生态的实际用法（`path` / `file_path` / `filePath` /
 * `target_file` / `absolute_path` / `relative_workspace_path`），
 * 与 `harness.ts` 的 `pickPath()` 同一套口径。
 */
function pickPath(input: Record<string, unknown>): string | undefined {
  for (const key of [
    'path',
    'file_path',
    'filePath',
    'target_file',
    'absolute_path',
    'relative_workspace_path',
    'filename',
  ]) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;
  }
  // 有些 agent 把路径放在嵌套对象里（`{ file: { path } }` / `{ edit: { path } }`）
  for (const nested of ['file', 'edit', 'target', 'location']) {
    const v = input[nested];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = pickPath(v as Record<string, unknown>);
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * 从 ACP 的 `rawInput` 里挑出命令字段。
 *
 * 与 `harness.ts` 的 `pickCommand()` 同一口径：`command` / `cmd` / `script`，
 * 数组形态也认（有些 agent 把命令拆成参数数组）。
 */
function pickCommand(input: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script', 'argv']) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v)) {
      const joined = v.filter((x): x is string => typeof x === 'string').join(' ');
      if (joined) return joined;
    }
  }
  return undefined;
}

/**
 * 从 ACP 的 `toolCall.title` 里解析出写入路径。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 *
 * 实测（2026-11-27，`cursor-agent 2026.09.18-9a7762b` 的
 * `5072.index.js` 里 `requestApproval` / `formatOperation`）：
 *
 *   case Write: { const o = e.details.path;
 *     return { title: e.details.isNewFile ? `Write ${o}` : `Edit \`${o}\``,
 *              kind: "edit", ... } }
 *
 * 也就是说 —— **cursor-agent 把写入路径放在 `title` 里**，
 * `rawInput` 与 `locations` 都是空的。zelto 只认那两个的话，
 * 撞上 cursor-agent 时会把**每一次写都拒掉**（安全，但功能不可用）。
 *
 * ── 边界 ────────────────────────────────────────────────────────────
 *
 * `title` 是**给人看的一句话**，不是结构化字段。解析它必须：
 *
 *   1. **只对写类 kind 解析** —— 只读工具的 title 是自然语言描述，
 *      解析它只会引入误判（只读豁免按类别判，不看路径）；
 *   2. **必须先命中白名单动词** —— 否则「Update the configuration file
 *      `config.yaml`」这种标题里的反引号内容会被当成路径。
 *      反引号**不是**路径的充分证据，只是「取值范围」的界定；
 *   3. **解析不出就返回 undefined** —— 交回原来的兜底链，
 *      最后由判定层拒绝。**绝不猜**。
 *
 * 这一层**不做判定**，只做「找路径」（与 `pickPath` 同一职责）。
 */
function pickPathFromTitle(
  title: string | undefined | null,
  kind: string | undefined,
): string | undefined {
  // 只有写类 kind 才解析 —— 只读 title 是描述，解析它没意义。
  if (kind !== 'edit' && kind !== 'delete' && kind !== 'move') return undefined;
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  if (!trimmed) return undefined;

  // ── 先过动词闸门 ────────────────────────────────────────────────
  //
  // 动词是**唯一**的「这标题说的是一次文件操作」的证据。
  // 没有它就返回 undefined —— 后面的反引号取值只是「从哪取」，
  // 不是「该不该取」。
  const verb = /^(edit|write|delete|remove|move|rename)\b\s*(.*)$/i.exec(trimmed);
  const rest = verb?.[2]?.trim();
  if (!verb || !rest) return undefined;
  //
  // cursor-agent 的 `Edit \`path\`` / `Write path` 都落在这。
  const backtick = /`([^`]+)`/.exec(rest);
  if (backtick?.[1]) {
    const p = backtick[1].trim();
    if (p) return p;
  }

  // 形态二：动词后直接跟路径（无反引号）—— `Write src/new-file.ts`。
  const p = rest.trim();
  if (p) return p;

  return undefined;
}

/**
 * 从 ACP 的 `toolCall.content` 里挑出路径。
 *
 * **实测 cursor-agent 把写入路径放在这儿**（`5072.index.js` 的
 * `formatOperation`）：
 *
 *   case Write: return { title: ..., kind: "edit",
 *     content: [{ type: "diff", path: o, oldText, newText }] }
 *
 * 这是**结构化**字段 —— 比 `title` 可靠得多，所以它是第一档兜底。
 *
 * `content` 的形状在 ACP 规范里是封闭的内容块数组，但块内的 `path`
 * 属于各家 agent 的扩展（规范不约束）。所以按候选字段名找。
 */
function pickPathFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const direct = pickPath(block as Record<string, unknown>);
    if (direct) return direct;
  }
  return undefined;
}

/**
 * 从 ACP 的 `toolCall.title` 里解析出**命令**。
 *
 * ── 为什么单独一个函数 ──────────────────────────────────────────────
 *
 * cursor-agent 的 Shell 操作（实测，`formatOperation` 的 `case Shell`）：
 *
 *   return { title: `\`${e.details.command.replaceAll("`","\\`")}\``,
 *            kind: "execute", ... }
 *
 * 注意两点：
 *
 *   1. **没有动词** —— title 就是**整个反引号包裹的命令**；
 *   2. 命令里的反引号被转义成 `` \` ``。
 *
 * 所以命令的解析**不能**套用路径那套「动词闸门」——
 * 那会把命令整个丢掉，导致判不出写目标 → 拒绝一切 Shell 操作。
 *
 * 形态：整个 title 就是一个反引号包裹的字符串 → 解出来就是命令。
 */
function pickCommandFromTitle(
  title: string | undefined | null,
  kind: string | undefined,
): string | undefined {
  if (kind !== 'execute') return undefined;
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  if (!trimmed) return undefined;

  // 形态：`` `cmd` `` —— 整个 title 是一个反引号包裹的字符串。
  //
  // 必须**整串**都是反引号包裹的（否则「`cmd` 后面还有话」会误取）。
  const whole = /^`([\s\S]+)`$/.exec(trimmed);
  if (whole?.[1]) {
    // 反解义：agent 转义了命令里的反引号。
    const cmd = whole[1].replace(/\\`/g, '`').trim();
    if (cmd) return cmd;
  }

  return undefined;
}

/**
 * 把 ACP 的一次工具调用归一化成统一载荷。
 *
 * **兜底原则与 `harness.ts` 一致**：工具类别不认识时**不是**「不判定」，
 * 而是「去找路径字段」；找不到就交由判定层拒绝。
 *
 * 路径的查找顺序（先可靠后模糊）：
 *
 *   1. `rawInput` 的候选字段名（结构化，最可靠）
 *   2. `content` 里的 `diff.path`（**实测 cursor-agent 在这儿**）
 *   3. `locations`（规范定义的字段）
 *   4. `title`（**实测 cursor-agent 也在这儿**，最模糊，认死形态）
 *
 * @param toolCall — ACP 的 `toolCall`（`RequestPermissionRequest.toolCall`）
 */
export function normalizeAcpToolCall(toolCall: AcpToolCall | undefined): NormalizedPayload {
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : undefined;
  const { tool, readOnly } = normalizeKind(kind);

  const raw = toolCall?.rawInput;
  const input: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const toolInput: NormalizedPayload['tool_input'] = {};

  if (!readOnly) {
    const path = pickPath(input);
    if (path) toolInput.file_path = path;
    const command = pickCommand(input);
    if (command) toolInput.command = command;
  } else {
    // 只读工具**也要**把路径带上：ACP 的 `locations` 常常是唯一的信息源，
    // 而只读豁免是按**工具类别**判的，不按路径，所以带上路径无害。
    const path = pickPath(input);
    if (path) toolInput.file_path = path;
  }

  // `content` 里的 `diff.path` —— 实测 cursor-agent 把写入路径放在这儿
  // （`content: [{ type: "diff", path, oldText, newText }]`），
  // 而它的 `rawInput` **整个字段都没有**。
  //
  // 结构化，排在 `locations` 前面。
  if (!toolInput.file_path) {
    const fromContent = pickPathFromContent(toolCall?.content);
    if (fromContent) toolInput.file_path = fromContent;
  }

  // ACP 的 `locations` 是**规范定义的**位置列表 —— 它比 `rawInput` 里的
  // 字段名更可靠（规范保证有 `path`）。作为兜底补进路径。
  if (!toolInput.file_path && Array.isArray(toolCall?.locations)) {
    for (const loc of toolCall.locations) {
      if (loc && typeof loc.path === 'string' && loc.path) {
        toolInput.file_path = loc.path;
        break;
      }
    }
  }

  // `title` 是**最后一档**兜底 —— 实测 cursor-agent 也把写入路径放在这儿
  // （`` Edit `src/foo.ts` ``）。
  //
  // 放最后：结构化字段优先，title 最模糊。
  if (!toolInput.file_path) {
    const fromTitle = pickPathFromTitle(toolCall?.title, kind);
    if (fromTitle) toolInput.file_path = fromTitle;
  }

  // 命令的兜底 —— 实测 cursor-agent 的 Shell 操作把命令放在 title 里
  // （`` `rm -rf out` ``，**没有动词**），`rawInput` 整个字段都没有。
  //
  // 判不出命令 → 判不出写目标 → 拒绝一切 Shell 操作（不可用）。
  if (!toolInput.command && tool === 'Bash') {
    const cmd = pickCommandFromTitle(toolCall?.title, kind);
    if (cmd) toolInput.command = cmd;
  }

  const out: NormalizedPayload = {
    tool_name: tool,
    tool_input: toolInput,
    raw_tool_name: typeof toolCall?.name === 'string' ? toolCall.name : undefined,
  };
  if (readOnly) out.read_only = true;
  return out;
}

/**
 * 在 ACP 给出的选项里挑出「本次允许」的那个。
 *
 * **只挑 `allow_once`** —— 绝不挑 `allow_always`（ADR-133 决策四）。
 *
 * @returns 选中的 `optionId`；没有可用选项时返回 null（→ 拒绝）
 */
export function selectAllowOnceOption(options: AcpPermissionOption[] | undefined): string | null {
  if (!Array.isArray(options)) return null;
  for (const opt of options) {
    if (opt && typeof opt.optionId === 'string' && opt.kind === 'allow_once') {
      return opt.optionId;
    }
  }
  return null;
}

/**
 * 在 ACP 给出的选项里挑出「本次拒绝」的那个。
 *
 * 优先级：`reject_once` > `reject_always`。
 *
 * **为什么允许 `reject_always`**：拒绝是**收紧**，不是放宽 ——
 * 记住「拒绝」只会让后续同类操作也被拒，不会造成越界。
 * 而 `allow_always` 会**永久**绕开写集判定，那才是禁区。
 */
export function selectRejectOption(options: AcpPermissionOption[] | undefined): string | null {
  if (!Array.isArray(options)) return null;
  for (const kind of ['reject_once', 'reject_always']) {
    for (const opt of options) {
      if (opt && typeof opt.optionId === 'string' && opt.kind === kind) {
        return opt.optionId;
      }
    }
  }
  return null;
}

/**
 * ACP 的权限应答（`RequestPermissionResponse`）。
 *
 * 形状：`{ outcome: { outcome: 'selected', optionId } }`。
 */
export interface AcpPermissionOutcome {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

/**
 * 把统一判决渲染成 ACP 的权限应答。
 *
 * **放行**：只在 agent 提供了 `allow_once` 选项时才放行；
 * 没有 → 退回拒绝（fail closed）。
 *
 * **拒绝**：挑 `reject_once`；agent 一个拒绝选项都没给 → 回 `cancelled`
 * （规范里 `cancelled` 表示「这一轮被取消」，语义上最接近「不批准」，
 * 且不会让 agent 误以为是被明确拒绝后可重试）。
 *
 * **永不就返回 `allow_always`** —— 见文件头的硬规则 1。
 */
export function renderAcpPermission(
  verdict: PreToolVerdict,
  options: AcpPermissionOption[] | undefined,
): AcpPermissionOutcome {
  if (verdict.decision === 'allow') {
    const allowOnce = selectAllowOnceOption(options);
    if (allowOnce) {
      return { outcome: { outcome: 'selected', optionId: allowOnce } };
    }
    // 没有「只允许这一次」的选项 → 不能放行（fail closed）
    const reject = selectRejectOption(options);
    if (reject) return { outcome: { outcome: 'selected', optionId: reject } };
    return { outcome: { outcome: 'cancelled' } };
  }

  const reject = selectRejectOption(options);
  if (reject) return { outcome: { outcome: 'selected', optionId: reject } };
  return { outcome: { outcome: 'cancelled' } };
}

// ── 判定入口 ────────────────────────────────────────────────────────────────

/**
 * 判定一次 ACP 的 permission 请求。
 *
 * 这是本模块**唯一**调用判定内核的地方 —— adapter 只调它，不自己判。
 *
 * ── 为什么多一道「未知工具」的检查 ────────────────────────────────────
 *
 * `judgeWriteTargets()` 对「空目标」返回 **allow**
 * （`basis: 'hook:no-target'`）—— 那在 hook 路线下是对的：
 * 没有写入目标 = 这次调用不改文件 = 不必拦。
 *
 * 但 ACP 路线下有一条 hook 路线没有的路径：**agent 报了一个我们不认识的
 * 工具类别**。这时归一化出来的载荷既不是只读工具、也找不到路径，
 * 于是写目标为空 → 判定内核会放行。
 *
 * **那正是「不认识 ≠ 放行」的漏洞**（ADR-083 §2 的同一条原则）。
 * 所以这里显式区分两种「空」：
 *
 * - **只读工具**（`kind` ∈ read/search/fetch/think/switch_mode）→ 空目标 → 放行
 * - **未知类别**（`other` 或规范外的值）→ 空目标 → **拒绝**
 *
 * @param toolCall — ACP 的 `toolCall`
 * @param ctx — 判定上下文（写集预约、保护域、策略、worktree 根）
 */
export function judgeAcpPermission(
  toolCall: AcpToolCall | undefined,
  ctx: PreToolContext,
): PreToolVerdict {
  const payload = normalizeAcpToolCall(toolCall);
  const targets = extractWriteTargets(payload);

  if (targets.length === 0) {
    if (payload.read_only === true) {
      // 只读工具：没有写入目标 = 不必拦。
      return {
        decision: 'allow',
        reason: '只读工具，没有写入目标。',
        basis: 'acp:read-only',
        ruleId: null,
        path: null,
        targets: [],
      };
    }

    // 未知类别 + 找不到路径/命令 → **拒绝**（fail closed）。
    //
    // 这是 ACP 路线独有的一道闸门：hook 路线下「不认识的工具名」
    // 会走「找路径字段」的兜底，找到就判、找不到就放行（空目标）；
    // 而 ACP 的 `kind` 是规范定义的封闭集合 —— 落到 `other` 或规范外的值，
    // 意味着这次调用**可能**在写东西，而我们看不出它写什么。
    return {
      decision: 'deny',
      reason:
        `工具类别 "${toolCall?.kind ?? '(未提供)'}" 无法判定写入目标，` +
        `默认拒绝。如需放行，请由人批准该操作的写集范围。`,
      basis: 'acp:unknown-tool',
      ruleId: 'acp:unknown-tool',
      path: null,
      targets: [],
    };
  }

  return judgeWriteTargets(targets, ctx);
}

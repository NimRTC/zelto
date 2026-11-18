// zelto hook —— 多 harness 协议适配层（ADR-083）
//
// 作用：把各 agent harness 的 hook 输入/输出翻译成统一载荷与统一判决。
//
// **为什么要有这一层**：
//   判定（约束，C3/C5/C9）必须与 harness 无关 ——
//   否则同一个越界写入，在 Claude Code 下被拦、在 Cursor 下被放行，
//   「判定结果」就变成了「取决于用什么 agent」的函数。
//
//   所以这里的分工是：
//     harness 输入 ──▶ normalize(harness) ──▶ 统一载荷
//                                            │
//                                            ▼
//                                  judgeWriteTargets()  ← 不变量在这
//                                            │
//                                            ▼
//     harness 输出 ◀── render(harness, 判决) ◀── 统一判决
//
//   这一层只做**翻译**，不做任何判定。
//
// 三种 harness 的形状：
//
//   Claude Code  stdin: {tool_name, tool_input:{file_path|command}, cwd, session_id}
//               stdout: {hookSpecificOutput:{hookEventName:"PreToolUse",
//                       permissionDecision:"allow|deny", permissionDecisionReason}}
//               exit 0 = 已判定；exit 2 = 阻断
//
//   Cursor      stdin: {hook_event_name, tool_name, tool_input:{path|command}, cwd}
//               stdout: {permission:"allow|deny", userMessage, agentMessage}
//               exit 0 = 已判定；exit 2 = 阻断
//               **默认 fail open** —— 必须显式设 failClosed:true
//
//   Codex       stdin: {event, tool_name, tool_input:{...}}
//               stdout: {hookSpecificOutput:{hookEventName, permissionDecision}}
//               exit 0 = 已判定；exit 2 = 阻断

// ── 统一载荷 ────────────────────────────────────────────────────────────────

/** 归一化后的工具调用载荷 —— 与 harness 无关。 */
export interface NormalizedPayload {
  /** 归一化后的工具名（用于写目标提取） */
  tool_name: string;
  /** 归一化后的工具输入 */
  tool_input: {
    file_path?: string;
    notebook_path?: string;
    path?: string;
    command?: string;
    edits?: unknown[];
  };
  /** 原始工具名 —— 写进事件流，供事后查「agent 当时调了什么」 */
  raw_tool_name?: string;
}

/** 统一判决 —— 与 harness 无关。 */
export interface NormalizedDecision {
  decision: 'allow' | 'deny';
  reason: string;
}

// ── harness 名 ──────────────────────────────────────────────────────────────

export type HarnessName = 'claude-code' | 'cursor' | 'codex';

export const HARNESS_NAMES: HarnessName[] = ['claude-code', 'cursor', 'codex'];

/**
 * harness 名 ↔ 命令行旗标的映射。
 *
 * 旗标用 `claude`（不是 `claude-code`）—— 与已有的 `--claude` 保持一致，
 * 别让用户记两套名字。
 */
const HARNESS_FLAG: Record<HarnessName, string> = {
  'claude-code': 'claude',
  cursor: 'cursor',
  codex: 'codex',
};

export function harnessFromFlag(flag: string): HarnessName | null {
  for (const name of HARNESS_NAMES) {
    if (HARNESS_FLAG[name] === flag) return name;
  }
  return null;
}

export function flagOfHarness(name: HarnessName): string {
  return HARNESS_FLAG[name];
}

// ── 载荷归一化 ──────────────────────────────────────────────────────────────

/**
 * 各 harness 的「写文件工具」名 → 统一后的名字。
 *
 * 语义相同、名字不同 —— 归一化的核心工作就是把它们映射到统一的名字。
 *
 * **为什么全部归成 `Write`**：写目标提取对 `Write` / `Edit` / `MultiEdit`
 * 走的是**同一条分支**（都读 `tool_input.file_path`），
 * 它们之间没有差别。统一成一个名字后，
 * 「这个工具会不会写文件」就只有一个判据 —— 不会因为 harness 换了工具名
 * 而让抽目标这条逻辑分叉。
 */
const WRITE_TOOL_ALIASES: Record<string, string> = {
  // Claude Code
  write: 'Write',
  edit: 'Write',
  multiedit: 'Write',
  notebookedit: 'NotebookEdit',
  bash: 'Bash',
  bashoutput: 'Bash',

  // Cursor
  create_file: 'Write',
  edit_file: 'Write',
  write_file: 'Write',
  replace: 'Write',
  search_replace: 'Write',
  terminal: 'Bash',
  run_terminal_cmd: 'Bash',

  // Codex
  apply_patch: 'Write',
  shell: 'Bash',
  exec: 'Bash',
};

/** Cursor / Codex 的命令字段名（Claude Code 用 `command`）。 */
function pickCommand(input: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const v = input[key];
    if (typeof v === 'string') return v;
  }
  // Cursor 的 terminal 有时把命令放在数组里
  const arr = input['command'];
  if (Array.isArray(arr)) {
    const joined = arr.filter((x): x is string => typeof x === 'string').join(' ');
    if (joined) return joined;
  }
  return undefined;
}

/** 各 harness 的路径字段名。 */
function pickPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'absolute_path']) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * 把某个 harness 的 hook 输入归一化成统一载荷。
 *
 * **关键设计**：工具名不认识时，**退回「找路径字段」**，
 * 而不是「不判定」。
 *
 * 为什么不认识就不判：那等于给每个新 harness 开一个绕过闸门的后门 ——
 * harness 改个工具名，闸门就静默失效。
 * 退回找路径字段是保守的：可能多拦（agent 重试一次），
 * 不会漏拦（越界写入落盘）。
 */
export function normalizePayload(harness: HarnessName, raw: unknown): NormalizedPayload {
  const empty: NormalizedPayload = { tool_name: '', tool_input: {} };
  if (!raw || typeof raw !== 'object') return empty;

  const obj = raw as Record<string, unknown>;

  // Codex 的事件名是 `event`，其它是 `tool_name`；工具名位置也有差异。
  const rawToolName =
    (typeof obj['tool_name'] === 'string' && obj['tool_name']) ||
    (typeof obj['toolName'] === 'string' && obj['toolName']) ||
    (typeof obj['tool'] === 'string' && obj['tool']) ||
    '';

  const rawInput = (obj['tool_input'] ?? obj['toolInput'] ?? obj['input'] ?? obj['parameters']);
  const input: Record<string, unknown> =
    rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};

  // 归一化工具名
  const key = rawToolName.toLowerCase();
  const aliased = WRITE_TOOL_ALIASES[key];
  const toolName = aliased ?? rawToolName;

  const filePath = pickPath(input);
  const command = pickCommand(input);

  const toolInput: NormalizedPayload['tool_input'] = {};
  if (filePath) toolInput.file_path = filePath;
  if (command) toolInput.command = command;
  // notebook 路径单独留一份（NotebookEdit 语义）
  const nb = input['notebook_path'] ?? input['notebookPath'];
  if (typeof nb === 'string' && nb) toolInput.notebook_path = nb;

  return {
    tool_name: toolName,
    tool_input: toolInput,
    raw_tool_name: rawToolName || undefined,
  };
}

// ── 输出渲染 ────────────────────────────────────────────────────────────────

/**
 * 把统一判决渲染成某个 harness 的输出契约。
 *
 * **判决内容在三种 harness 里必须一致** —— 差别只在信封的形状。
 */
export function renderDecision(harness: HarnessName, decision: NormalizedDecision): unknown {
  switch (harness) {
    case 'cursor':
      // Cursor 的 permission hook：permission 字段 + 给用户/给模型的消息
      return {
        permission: decision.decision,
        userMessage: decision.reason,
        agentMessage: decision.reason,
      };
    case 'codex':
    case 'claude-code':
    default:
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.reason,
        },
      };
  }
}

/**
 * 某个 harness 的「阻断」方式是不是「exit 2」。
 *
 * 三种都是 exit 2 —— 但 Cursor 的 hook **默认 fail open**，
 * 所以「进程崩了」在 Cursor 上不等于「阻断」。
 * 这就是为什么 Cursor 的配置必须显式带 `failClosed: true`
 * （见 `hook-install.ts`）—— 那是配置层的事，这里只如实描述现状。
 */
export function harnessFailsClosedByDefault(harness: HarnessName): boolean {
  // Claude Code 与 Codex：hook 自身崩了 → 不阻断（但 zelto 的进程
  // 在所有异常路径上都主动返回「拒绝」，所以实际上仍然 fail closed）。
  // Cursor：配置层默认 fail open —— 必须靠 failClosed:true 补上。
  return harness !== 'cursor';
}

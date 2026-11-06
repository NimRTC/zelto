// zelto pretool hook — Claude Code PreToolUse 运行时策略判定
//
// 作用：agent 每次写文件的那一刻就过一遍策略判定，而不是等到提交时（ADR-014）。
// 判定不触网、不调模型（C3）；每次判定写一条 append-only 事件（C4）。
//
// 协议（Claude Code hooks）：
//   stdin  ← {"tool_name":"Write","tool_input":{"file_path":"..."},...}
//   stdout → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//              "permissionDecision":"allow|deny|ask",
//              "permissionDecisionReason":"..."}}
//   exit 0 = 已判定；exit 2 = 阻断错误（stderr 回灌给模型）
//
// 失败一律 fail closed：判定不了就拒绝写。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

// ── 判定所需的数据结构 ──────────────────────────────────────────────────────

export type Verdict = 'allow' | 'deny';

export interface PreToolContext {
  /** 主仓库根：policy / reservation / 事件流都在这里 */
  projectRoot: string;
  /** agent 实际工作目录（worktree）；相对路径以此为基准 */
  worktreeRoot: string;
  /** 切片 id；null 表示「无切片」的策略模式 */
  sliceId: string | null;
  /** 该切片的写集预约；null 表示没有预约 */
  writes: string[] | null;
  /** policy.yaml 解析出的规则；null 表示策略文件缺失 */
  rules: Array<{
    id: string;
    match: { path?: string; operation?: string };
    action: 'allow' | 'deny' | 'ask';
    basis: string;
    guidance?: string;
    priority?: number;
  }> | null;
  /** 策略文件哈希 */
  policyVersion: string;
}

export interface PreToolVerdict {
  decision: Verdict;
  reason: string;
  basis: string;
  ruleId: string | null;
  /** 相对 worktree 的路径 */
  path: string | null;
  /** 被判定为写入目标（相对路径） */
  targets: string[];
}

export interface PreToolPayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    path?: string;
    command?: string;
    edits?: unknown[];
  };
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
}

// ── 路径处理 ────────────────────────────────────────────────────────────────

import { isProtectedPath, matchPath, toPosix } from './protected.js';

export { isProtectedPath, matchPath } from './protected.js';

/**
 * 把一次写入目标解析成「相对 worktree 的路径」。
 *
 * 返回 null 表示路径逃出了 worktree（越界到别处）。
 */
export function relativizeTarget(target: string, worktreeRoot: string): string | null {
  const abs = isAbsolute(target) ? resolve(target) : resolve(worktreeRoot, target);
  const rel = toPosix(relative(resolve(worktreeRoot), abs));
  if (rel === '') return null;
  if (rel.startsWith('../') || rel === '..') return null;
  return rel;
}

// ── 写目标提取 ──────────────────────────────────────────────────────────────

/** 直接作用于路径的命令：第一个非选项参数就是写入目标。 */
const PATH_TARGET_COMMANDS = new Set([
  'touch', 'rm', 'rmdir', 'mkdir', 'truncate', 'shred', 'tee', 'install',
  'chmod', 'chown', 'chgrp', 'ln', 'dd',
]);

/** 目标 + 来源都是写入目标的命令（mv 会把源搬走）。 */
const MOVE_COMMANDS = new Set(['mv']);
/** 源只读、目标才是写入点的命令。 */
const COPY_COMMANDS = new Set(['cp']);

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 按 shell 分隔符把命令切成若干段（&& || ; | 换行）。 */
function splitSegments(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function nonFlagArgs(tokens: string[]): string[] {
  return tokens.filter((t) => !t.startsWith('-'));
}

/**
 * 从一条 shell 命令里抽出「可能被写」的路径。
 *
 * 这是保守的静态分析，不是 shell 解析器：
 * - 重定向目标（`> file`、`>> file`、`2> file`）
 * - 已知写文件命令的参数（touch/rm/mv/cp/mkdir/tee/sed -i …）
 *
 * 抽不出目标就返回空数组 —— 此时不拦截。任意解释器
 * （`node -e "fs.writeFileSync(...)"`）里的写目标无法静态得出，
 * 由运行后审计兜底（ADR-014 §5）。
 */
export function extractBashWriteTargets(command: string): string[] {
  const targets: string[] = [];

  // 1. 重定向
  const redirect = /(?:^|[^0-9&]|\d)>{1,2}\s*(?:"([^"]*)"|'([^']*)'|([^\s"';&|<>]+))/g;
  const redirectErr = /&>\s*(?:"([^"]*)"|'([^']*)'|([^\s"';&|<>]+))/g;
  for (const re of [redirect, redirectErr]) {
    let m = re.exec(command);
    while (m !== null) {
      const value = m[1] ?? m[2] ?? m[3];
      if (value && value !== '&1' && value !== '&2') targets.push(value);
      m = re.exec(command);
    }
  }

  // 2. 写文件命令
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const cmd = basename(tokens[0]).toLowerCase();
    const args = tokens.slice(1);

    if (PATH_TARGET_COMMANDS.has(cmd)) {
      if (cmd === 'tee') {
        targets.push(...nonFlagArgs(args));
      } else if (cmd === 'dd') {
        const of = args.find((a) => a.startsWith('of='));
        if (of) targets.push(of.slice(3));
      } else if (cmd === 'ln') {
        targets.push(...nonFlagArgs(args).slice(0, 2));
      } else {
        const first = nonFlagArgs(args)[0];
        if (first) targets.push(first);
      }
      continue;
    }

    if (MOVE_COMMANDS.has(cmd)) {
      targets.push(...nonFlagArgs(args).slice(0, 2));
      continue;
    }

    if (COPY_COMMANDS.has(cmd)) {
      const dest = nonFlagArgs(args)[1];
      if (dest) targets.push(dest);
      continue;
    }

    if (cmd === 'sed' || cmd === 'perl') {
      const inPlace = args.some((a) => a.startsWith('-') && a.includes('i') && !a.startsWith('--'));
      if (inPlace) {
        const files = nonFlagArgs(args).slice(1);
        targets.push(...files);
      }
      continue;
    }

    if (cmd === 'git') {
      const sub = args[0];
      if (sub === 'apply') {
        targets.push(...nonFlagArgs(args.slice(1)));
      } else if (sub === 'restore' || sub === 'checkout') {
        const dashDash = args.indexOf('--');
        if (dashDash >= 0) targets.push(...args.slice(dashDash + 1));
      }
      continue;
    }
  }

  return targets.filter((t) => t && t !== '-' && t !== '/dev/null');
}

/**
 * 从一次工具调用里抽出全部写入目标。
 *
 * Write / Edit / MultiEdit → tool_input.file_path
 * NotebookEdit            → tool_input.notebook_path
 * Bash                    → 静态分析命令里的写目标
 */
export function extractWriteTargets(payload: PreToolPayload): string[] {
  const tool = payload.tool_name ?? '';
  const input = payload.tool_input ?? {};

  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    return input.file_path ? [input.file_path] : [];
  }
  if (tool === 'NotebookEdit') {
    return input.notebook_path ? [input.notebook_path] : [];
  }
  if (tool === 'Bash' || tool === 'BashOutput') {
    return input.command ? extractBashWriteTargets(input.command) : [];
  }
  // 兜底：任何带路径的工具
  const fallback = input.file_path ?? input.notebook_path ?? input.path;
  return fallback ? [fallback] : [];
}

// ── 策略判定 ────────────────────────────────────────────────────────────────

/**
 * 按 zelto 的策略语义评估一条规则集合。
 *
 * 与 core/policy/engine.ts 的 evaluatePolicy 保持同一套规则：
 * 保护域 → 路径逃逸 → deny 优先 → 首个 allow/ask → 默认 deny。
 */
export function evaluateRules(
  rules: NonNullable<PreToolContext['rules']>,
  path: string,
  operation: string,
): { action: 'allow' | 'deny' | 'ask'; ruleId: string | null; basis: string; guidance: string | null } {
  const sorted = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  let finalAction: 'allow' | 'deny' | 'ask' | null = null;
  let matched: (typeof sorted)[number] | null = null;

  for (const rule of sorted) {
    if (rule.match.path && !matchPath(rule.match.path, path)) continue;
    if (rule.match.operation && rule.match.operation !== operation) continue;

    if (rule.action === 'deny') {
      return { action: 'deny', ruleId: rule.id, basis: rule.basis, guidance: rule.guidance ?? null };
    }
    if (finalAction === null) {
      finalAction = rule.action;
      matched = rule;
    }
  }

  if (finalAction && matched) {
    return { action: finalAction, ruleId: matched.id, basis: matched.basis, guidance: matched.guidance ?? null };
  }

  return { action: 'deny', ruleId: 'default', basis: 'policy.yaml#default', guidance: null };
}

/**
 * 判定一次工具调用是否可以写。
 *
 * 判定顺序（约束优先）：
 * 1. 路径逃逸（写到 worktree 之外）
 * 2. 保护域（策略规则改不动）
 * 3. 写集预约（切片只能写自己 writes 内的路径）
 * 4. policy.yaml 规则
 */
export function judgeWriteTargets(
  targets: string[],
  ctx: PreToolContext,
): PreToolVerdict {
  const empty: PreToolVerdict = {
    decision: 'allow',
    reason: '没有可判定的写入目标',
    basis: 'hook:no-target',
    ruleId: null,
    path: null,
    targets: [],
  };

  if (targets.length === 0) return empty;

  const relativeTargets: string[] = [];

  for (const target of targets) {
    // 1. 路径逃逸
    const rel = relativizeTarget(target, ctx.worktreeRoot);
    if (rel === null) {
      return {
        decision: 'deny',
        reason: `写入目标 "${target}" 在隔离目录之外，越界。`,
        basis: 'AGENTS.md#禁区',
        ruleId: 'protected:0a',
        path: null,
        targets: [...relativeTargets, target],
      };
    }
    relativeTargets.push(rel);

    // 2. 保护域
    if (isProtectedPath(rel)) {
      return {
        decision: 'deny',
        reason: `写入目标 "${rel}" 位于保护域，不允许修改。`,
        basis: 'AGENTS.md#禁区',
        ruleId: 'protected:0b',
        path: rel,
        targets: [...relativeTargets],
      };
    }

    // 3. 写集预约
    if (ctx.sliceId !== null) {
      if (ctx.writes === null) {
        return {
          decision: 'deny',
          reason: `切片 "${ctx.sliceId}" 没有生效中的写集预约，无法确认写入是否越界，默认拒绝。`,
          basis: 'reservation:missing',
          ruleId: 'reservation:missing',
          path: rel,
          targets: [...relativeTargets],
        };
      }
      if (!pathInWriteSet(rel, ctx.writes)) {
        return {
          decision: 'deny',
          reason:
            `写入目标 "${rel}" 不在切片 "${ctx.sliceId}" 的写集内` +
            `（允许：${ctx.writes.join(', ') || '(空)'}）。` +
            `如需修改，请先由人批准扩大写集。`,
          basis: `slice:${ctx.sliceId}#writes`,
          ruleId: `writes:${ctx.sliceId}`,
          path: rel,
          targets: [...relativeTargets],
        };
      }
    }
  }

  // 4. policy.yaml 规则
  if (ctx.rules === null) {
    // 没有策略文件：有写集预约就以写集为准；否则无从判定，fail closed
    if (ctx.sliceId !== null) {
      return {
        decision: 'allow',
        reason: '没有 policy/policy.yaml，以写集预约为准。',
        basis: 'reservation:only',
        ruleId: null,
        path: relativeTargets[0] ?? null,
        targets: relativeTargets,
      };
    }
    return {
      decision: 'deny',
      reason: '缺少 policy/policy.yaml，无法判定，默认拒绝写入。',
      basis: 'policy:missing',
      ruleId: 'policy:missing',
      path: relativeTargets[0] ?? null,
      targets: relativeTargets,
    };
  }

  for (const rel of relativeTargets) {
    const result = evaluateRules(ctx.rules, rel, 'write');
    if (result.action === 'deny') {
      return {
        decision: 'deny',
        reason: result.guidance ?? `策略拒绝写入 "${rel}"（规则 ${result.ruleId}）。`,
        basis: result.basis,
        ruleId: result.ruleId,
        path: rel,
        targets: relativeTargets,
      };
    }
    if (result.action === 'ask') {
      // zelto 的运行是非交互的，ask 无法真正落到人身上 → fail closed
      return {
        decision: 'deny',
        reason:
          `策略规则 "${result.ruleId}" 要求人工确认后才能写入 "${rel}"，` +
          `但当前是非交互运行，无法取得确认，默认拒绝。`,
        basis: result.basis,
        ruleId: result.ruleId,
        path: rel,
        targets: relativeTargets,
      };
    }
  }

  return {
    decision: 'allow',
    reason: '在写集与策略允许范围内。',
    basis: 'policy:allow',
    ruleId: null,
    path: relativeTargets[0] ?? null,
    targets: relativeTargets,
  };
}

// ── 写集匹配 ────────────────────────────────────────────────────────────────

/**
 * 某个路径是否落在写集内。
 *
 * 与 core/sched/paths.ts 的 pathInWriteSet 同规则；这里独立一份是因为
 * hook 必须能被单独编译分发（不依赖 core 的其余部分）。
 */
export function pathInWriteSet(filePath: string, writes: string[]): boolean {
  const normalized = toPosix(filePath);
  for (const raw of writes) {
    const pattern = toPosix(raw);
    if (!pattern) continue;
    if (pattern.includes('*') && matchPath(pattern, normalized)) return true;
    const dir = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (!dir.includes('*') && (normalized === dir || normalized.startsWith(`${dir}/`))) {
      return true;
    }
  }
  return false;
}

// ── 事件写盘（C4） ───────────────────────────────────────────────────────────

interface EventEnvelope {
  ts: string;
  runSeq: number;
  slice: string;
  run: string | null;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
}

function nextRunSeq(eventFile: string): number {
  try {
    const content = readFileSync(eventFile, 'utf-8').trimEnd();
    if (!content) return 1;
    const lastNewline = content.lastIndexOf('\n');
    const lastLine = lastNewline >= 0 ? content.slice(lastNewline + 1) : content;
    const parsed = JSON.parse(lastLine) as { runSeq?: number };
    if (typeof parsed.runSeq === 'number' && parsed.runSeq > 0) return parsed.runSeq + 1;
  } catch {
    // 读不到就从头开始
  }
  return 1;
}

/**
 * 追加一条事件。写盘失败不影响判定结果 —— 判定已经做完了。
 */
export function appendDecisionEvent(
  projectRoot: string,
  sliceId: string,
  payload: Record<string, unknown>,
): void {
  try {
    const dir = join(projectRoot, '.zelto', 'events', sliceId);
    mkdirSync(dir, { recursive: true });
    const eventFile = join(dir, 'events.jsonl');
    const envelope: EventEnvelope = {
      ts: new Date().toISOString(),
      runSeq: nextRunSeq(eventFile),
      slice: sliceId,
      run: null,
      type: 'policy.decision',
      actor: 'hook',
      payload,
    };
    appendFileSync(eventFile, `${JSON.stringify(envelope)}\n`, 'utf-8');
  } catch {
    // 事件写盘失败不阻断判定
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/** 无切片模式下事件落到这个「切片」名下。 */
export const POLICY_ONLY_SLICE = '_hook';

interface HookArgs {
  projectRoot: string;
  worktreeRoot: string;
  sliceId: string | null;
}

export function parseArgs(argv: string[]): HookArgs {
  let projectRoot = process.env.ZELTO_PROJECT_ROOT ?? process.cwd();
  let worktreeRoot = '';
  let sliceId: string | null = process.env.ZELTO_SLICE_ID ?? null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-root' && argv[i + 1]) projectRoot = argv[++i];
    else if (arg === '--worktree' && argv[i + 1]) worktreeRoot = argv[++i];
    else if (arg === '--slice' && argv[i + 1]) sliceId = argv[++i];
  }

  const root = resolve(projectRoot);
  return {
    projectRoot: root,
    worktreeRoot: worktreeRoot ? resolve(worktreeRoot) : root,
    sliceId,
  };
}

function loadRules(projectRoot: string): { rules: PreToolContext['rules']; version: string } {
  const policyPath = join(projectRoot, 'policy', 'policy.yaml');
  if (!existsSync(policyPath)) {
    return { rules: null, version: 'unknown' };
  }
  const content = readFileSync(policyPath, 'utf-8');
  const version = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const rules = parsePolicyRules(content);
  return { rules, version };
}

/** 去掉包裹整个字符串的成对引号（单引号与双引号等价）——ADR-028。 */
function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** 解析行内 `match: { ... }` —— 按键值对解析，键序无关、引号风格无关（ADR-028）。 */
function parseInlineMatch(body: string): { path?: string; operation?: string } | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return {};

  const result: { path?: string; operation?: string } = {};
  for (const part of inner.split(',')) {
    const segment = part.trim();
    if (segment === '') continue;

    const sep = segment.indexOf(':');
    if (sep < 0) continue;

    const key = stripSurroundingQuotes(segment.slice(0, sep).trim());
    const value = stripSurroundingQuotes(segment.slice(sep + 1).trim());
    if (key === 'path') result.path = value;
    else if (key === 'operation') result.operation = value;
  }
  return result;
}

/** 解析 policy.yaml 的 rules 段（与 core/policy/yaml.ts 同一套行内语法）。
 * `arch:` 段直接忽略 —— 逐写判定只看写规则（ADR-027 §2.3），
 * 不跳过的话里面的 `action:` 会贴到最后一条 rule 上造成污染。 */
export function parsePolicyRules(content: string): NonNullable<PreToolContext['rules']> {
  const rules: NonNullable<PreToolContext['rules']> = [];
  let current: Record<string, unknown> | null = null;
  let inArch = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'arch:') {
      if (current?.id) {
        rules.push(current as never);
        current = null;
      }
      inArch = true;
      continue;
    }
    if (trimmed === 'rules:') {
      inArch = false;
      continue;
    }
    if (inArch) continue;

    if (trimmed.startsWith('- id:')) {
      if (current?.id) rules.push(current as never);
      current = { id: trimmed.slice(5).trim(), match: {} };
      continue;
    }
    if (!current) continue;

    const inline = parseInlineMatch(trimmed.slice(6));
    if (inline) {
      current.match = { ...(current.match as object), ...inline };
      continue;
    }
    if (trimmed.startsWith('path:')) {
      current.match = { ...(current.match as object), path: stripSurroundingQuotes(trimmed.slice(5).trim()) };
      continue;
    }
    if (trimmed.startsWith('operation:')) {
      current.match = { ...(current.match as object), operation: stripSurroundingQuotes(trimmed.slice(10).trim()) };
      continue;
    }
    if (trimmed.startsWith('action:')) {
      current.action = trimmed.slice(7).trim();
      continue;
    }
    if (trimmed.startsWith('basis:')) {
      current.basis = stripSurroundingQuotes(trimmed.slice(6).trim());
      continue;
    }
    if (trimmed.startsWith('guidance:')) {
      current.guidance = stripSurroundingQuotes(trimmed.slice(9).trim());
      continue;
    }
    if (trimmed.startsWith('priority:')) {
      current.priority = Number.parseInt(trimmed.slice(9).trim(), 10);
    }
  }
  if (current?.id) rules.push(current as never);

  return rules;
}

function loadWrites(projectRoot: string, sliceId: string | null): string[] | null {
  if (!sliceId) return null;
  const file = join(projectRoot, '.zelto', 'locks', `${sliceId}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      writes?: unknown;
      releasedAt?: string | null;
    };
    if (parsed.releasedAt) return null;
    if (!Array.isArray(parsed.writes)) return null;
    return parsed.writes.filter((w): w is string => typeof w === 'string');
  } catch {
    return null;
  }
}

export function buildContext(args: HookArgs): PreToolContext {
  const { rules, version } = loadRules(args.projectRoot);
  return {
    projectRoot: args.projectRoot,
    worktreeRoot: args.worktreeRoot,
    sliceId: args.sliceId,
    writes: loadWrites(args.projectRoot, args.sliceId),
    rules,
    policyVersion: version,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    }, 5000);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}

export interface HookResponse {
  decision: Verdict;
  reason: string;
  basis: string;
  ruleId: string | null;
  path: string | null;
}

export async function runPreTool(argv: string[]): Promise<HookResponse> {
  const args = parseArgs(argv);
  const raw = await readStdin();

  let payload: PreToolPayload;
  try {
    payload = JSON.parse(raw) as PreToolPayload;
  } catch {
    return {
      decision: 'deny',
      reason: '无法解析 hook 输入，默认拒绝。',
      basis: 'hook:bad-input',
      ruleId: 'hook:bad-input',
      path: null,
    };
  }

  const ctx = buildContext(args);
  const targets = extractWriteTargets(payload);
  const verdict = judgeWriteTargets(targets, ctx);

  const eventSlice = ctx.sliceId ?? POLICY_ONLY_SLICE;
  appendDecisionEvent(ctx.projectRoot, eventSlice, {
    decision: verdict.decision,
    ruleId: verdict.ruleId,
    basis: verdict.basis,
    reason: verdict.reason,
    path: verdict.path,
    targets: verdict.targets,
    tool: payload.tool_name ?? 'unknown',
    policyVersion: ctx.policyVersion,
    harness: 'claude-code',
    sliceId: ctx.sliceId,
  });

  return {
    decision: verdict.decision,
    reason: verdict.reason,
    basis: verdict.basis,
    ruleId: verdict.ruleId,
    path: verdict.path,
  };
}

/** CLI 入口：读 stdin，输出 Claude Code 契约 JSON。 */
export async function main(argv: string[]): Promise<number> {
  let response: HookResponse;
  try {
    response = await runPreTool(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 判定本身出错 → 阻断（fail closed）
    process.stderr.write(`zelto pretool hook error: ${message}\n`);
    return 2;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: response.decision,
      permissionDecisionReason: response.reason,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

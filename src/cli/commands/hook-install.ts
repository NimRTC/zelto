// hook 安装 — git hooks + Claude Code PreToolUse 运行时钩子
//
// 两套钩子各管一段：
// - git pre-commit / pre-push：提交那一刻判定「这一批改动能不能进版本库」
// - Claude Code PreToolUse：agent 写下每一个文件的那一刻判定（ADR-014）
//
// C4: 安装/卸载都写事件（由调用方负责，这里只做纯文件操作）。

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPolicyConfig, parseConfigYaml } from './shared.js';

// ─── 常量 ───────────────────────────────────────────────────────────────────

/** Claude Code 项目级本地设置文件（不进版本库） */
export const CLAUDE_SETTINGS_RELATIVE = join('.claude', 'settings.local.json');

/** 触发判定的工具：写文件的工具 + 能写文件的 shell */
export const PRETOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

/** 用来识别「这条 hook 是 zelto 装的」 */
const HOOK_MARKER_ARG = '--zelto-pretool';

const GIT_HOOK_MARKER = '# zelto-hook — DO NOT EDIT';

// ─── hook 入口路径 ───────────────────────────────────────────────────────────

/**
 * zelto-hook 可执行入口的绝对路径。
 *
 * 从当前模块位置推导：dist/cli/commands → dist/hook/index.js。
 * 找不到就退回 <cwd>/dist/hook/index.js。
 */
export function hookEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'hook', 'index.js'),
    resolve(process.cwd(), 'dist', 'hook', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

// ─── Claude Code PreToolUse 钩子 ────────────────────────────────────────────

export interface ClaudeHookOptions {
  /** 写 .claude/settings.local.json 的目录 —— agent 实际工作的目录（worktree） */
  root: string;
  /**
   * 主仓库根 —— policy.yaml 与 .zelto/locks 都在这里。
   * 不给就退回 `root`（没有 worktree 时两者相同）。
   */
  projectRoot?: string | null;
  /** 切片 id；给了就按写集预约强制 */
  sliceId?: string | null;
  /** agent 实际工作目录（worktree） */
  worktree?: string | null;
}

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: ClaudeHookEntry[] }>>;
  [key: string]: unknown;
}

/** 拼出 hook 命令行。路径统一用正斜杠，避免 shell 转义问题。 */
export function buildPreToolHookCommand(options: ClaudeHookOptions): string {
  const exec = buildPreToolHookExec(options);
  return [exec.command, ...exec.args].map(quoteArg).join(' ');
}

/**
 * 拼出 hook 的「exec 形式」：可执行文件 + 参数数组，不过 shell。
 *
 * SDK 的 `hooks` 选项支持这种形式（`command` + `args`），路径里有空格或
 * 引号也不会被 shell 重新解析 —— 比拼字符串可靠。
 */
export function buildPreToolHookExec(options: ClaudeHookOptions): {
  command: string;
  args: string[];
} {
  const entry = hookEntryPath().replace(/\\/g, '/');
  // `--project-root` 指的是**主仓库**：policy.yaml 与 .zelto/locks/<sliceId>.json 都在那里。
  // 这里曾误填成 worktree —— worktree 里没有 .zelto/（它不入版本库），
  // 于是 hook 读不到写集预约，按「预约缺失 = 拒绝」把所有写入一律拦下。
  const projectRoot = resolve(options.projectRoot ?? options.root).replace(/\\/g, '/');
  const args = [
    entry,
    'pretool',
    '--project-root',
    projectRoot,
  ];
  if (options.worktree) {
    args.push('--worktree', resolve(options.worktree).replace(/\\/g, '/'));
  }
  if (options.sliceId) {
    args.push('--slice', options.sliceId);
  }
  args.push(HOOK_MARKER_ARG);
  return { command: process.execPath, args };
}

/** 给单个参数加引号（Windows 的 cmd 与 POSIX shell 都认双引号）。 */
function quoteArg(value: string): string {
  if (value === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isZeltoHookEntry(entry: { hooks?: ClaudeHookEntry[] }): boolean {
  return (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER_ARG));
}

/**
 * 安装（或更新）Claude Code 的 PreToolUse 钩子。
 *
 * 写 `<root>/.claude/settings.local.json`；已存在的其他设置原样保留，
 * 只替换 zelto 自己那一条。
 */
export function installClaudeCodeHook(options: ClaudeHookOptions): {
  installed: boolean;
  path: string;
  message: string;
} {
  const settingsPath = join(options.root, CLAUDE_SETTINGS_RELATIVE);

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settings = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
    } catch {
      settings = {};
    }
  }

  const hooks = { ...(settings.hooks ?? {}) };
  const preToolUse = (hooks.PreToolUse ?? []).filter((entry) => !isZeltoHookEntry(entry));
  preToolUse.push({
    matcher: PRETOOL_MATCHER,
    hooks: [
      {
        type: 'command',
        command: buildPreToolHookCommand(options),
      },
    ],
  });
  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { installed: false, path: settingsPath, message: `写入失败: ${message}` };
  }

  return { installed: true, path: settingsPath, message: '已安装' };
}

/** 卸载 zelto 装的那条 Claude Code 钩子；其他设置原样保留。 */
export function removeClaudeCodeHook(root: string): { removed: boolean; path: string } {
  const settingsPath = join(root, CLAUDE_SETTINGS_RELATIVE);
  if (!existsSync(settingsPath)) return { removed: false, path: settingsPath };

  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = raw.trim() ? (JSON.parse(raw) as ClaudeSettings) : {};
    const hooks = { ...(settings.hooks ?? {}) };
    const preToolUse = (hooks.PreToolUse ?? []).filter((entry) => !isZeltoHookEntry(entry));
    let removed = false;

    if (preToolUse.length !== (hooks.PreToolUse ?? []).length) {
      removed = true;
      if (preToolUse.length > 0) hooks.PreToolUse = preToolUse;
      else delete hooks.PreToolUse;
      settings.hooks = hooks;

      if (Object.keys(hooks).length === 0) delete settings.hooks;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
    }
    return { removed, path: settingsPath };
  } catch {
    return { removed: false, path: settingsPath };
  }
}

/** Claude Code 钩子是否已安装。 */
export function claudeCodeHookInstalled(root: string): boolean {
  const settingsPath = join(root, CLAUDE_SETTINGS_RELATIVE);
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    return (settings.hooks?.PreToolUse ?? []).some((entry) => isZeltoHookEntry(entry));
  } catch {
    return false;
  }
}

// ─── Cursor / Codex 钩子（ADR-083）───────────────────────────────────────────
//
// 两者都用 `hooks.json`，但**信封不同**：
//
//   Cursor  .cursor/hooks.json
//     { "version": 1, "hooks": { "preToolUse": [ { command, matcher, failClosed } ] } }
//     输出 { "permission": "allow|deny", "user_message", "agent_message" }
//
//   Codex   .codex/hooks.json
//     { "hooks": { "PreToolUse": [ { command, matcher } ] } }
//     输出 { "hookSpecificOutput": { hookEventName, permissionDecision } }
//
// **Cursor 的 `failClosed: true` 是必须显式写的**（ADR-083 §4）：
// Cursor 默认 fail open —— hook 崩溃/超时时动作照常执行。
// 而 C9 要求「判定不了就拒绝」。不写这一条，
// zelto 在 Cursor 下就是默认放行，而文档写着「判定不了就拒绝」——
// **声称的强度与实际的强度不一致**（README 那句「已发布到 npm」同形状）。

/** Cursor 的项目级 hook 配置（不进版本库的建议由用户自行决定）。 */
export const CURSOR_HOOKS_RELATIVE = join('.cursor', 'hooks.json');
/** Codex 的项目级 hook 配置。 */
export const CODEX_HOOKS_RELATIVE = join('.codex', 'hooks.json');

/**
 * Cursor / Codex 的工具匹配串。
 *
 * **Cursor 用的是 CLI 真实工具名**（2026.09.18 实测）：
 *   `Write`（写文件）、`Delete`（删文件）、`Shell`（跑命令）。
 *
 * 之前这里写的是 `create_file|edit_file|write_file|replace|search_replace|
 * terminal|run_terminal_cmd|apply_patch|shell` —— 那是一组**假想的名字**，
 * Cursor CLI 里根本不存在。matcher 是拿 `new RegExp(matcher)` 去测
 * `tool_name` 的，一个都匹配不上 → hook 永远不被调用 →
 * **写集预约在 Cursor 下等于没有**，而配置文件看上去一切正常。
 *
 * 这正是「看不见的失效」：不是报错，是安静地不生效。
 * 所以这里必须跟 CLI 真实工具名对齐。
 */
export const CURSOR_PRETOOL_MATCHER = 'Write|Delete|Shell';

/** Codex 的工具匹配串 —— Codex 的工具名与 Cursor 不同，单独一份。 */
export const CODEX_PRETOOL_MATCHER = 'apply_patch|shell|write|edit';

interface CursorHookEntry {
  command: string;
  matcher?: string;
  /** Cursor 特有：hook 失败时是否阻断（默认 false = fail open） */
  failClosed?: boolean;
  timeout?: number;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

interface CodexHooksFile {
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

function isZeltoCursorEntry(entry: CursorHookEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(HOOK_MARKER_ARG);
}

function readHooksFile<T extends { hooks?: Record<string, CursorHookEntry[]> }>(
  path: string,
): T {
  if (!existsSync(path)) return {} as T;
  try {
    const raw = readFileSync(path, 'utf-8');
    return (raw.trim() ? JSON.parse(raw) : {}) as T;
  } catch {
    return {} as T;
  }
}

function writeHooksFile(path: string, data: unknown): { ok: boolean; message: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    return { ok: true, message: '已安装' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `写入失败: ${message}` };
  }
}

/**
 * 拼出某个 harness 的 hook 命令行。
 *
 * 与 Claude Code 的差别只有一个：多了 `--harness <name>`。
 * 判定内核完全共用。
 */
export function buildHarnessHookCommand(
  harness: 'cursor' | 'codex',
  options: ClaudeHookOptions,
): string {
  const exec = buildPreToolHookExec(options);
  const args = [...exec.args];
  // 插在标记之前 —— 无所谓位置，但放前面便于人读命令时一眼看出 harness。
  const markerIdx = args.indexOf(HOOK_MARKER_ARG);
  const withHarness = [
    ...args.slice(0, markerIdx),
    '--harness',
    harness,
    ...args.slice(markerIdx),
  ];
  return [exec.command, ...withHarness].map(quoteArg).join(' ');
}

/** 安装 Cursor 的 preToolUse 钩子。 */
export function installCursorHook(options: ClaudeHookOptions): {
  installed: boolean;
  path: string;
  message: string;
} {
  const hooksPath = join(options.root, CURSOR_HOOKS_RELATIVE);
  const file = readHooksFile<CursorHooksFile>(hooksPath);

  const hooks = { ...(file.hooks ?? {}) };
  const preToolUse = (hooks.preToolUse ?? []).filter((entry) => !isZeltoCursorEntry(entry));
  preToolUse.push({
    command: buildHarnessHookCommand('cursor', options),
    matcher: CURSOR_PRETOOL_MATCHER,
    // **必须显式 fail closed** —— Cursor 默认 fail open（ADR-083 §4）。
    failClosed: true,
  });
  hooks.preToolUse = preToolUse;
  file.hooks = hooks;
  if (file.version === undefined) file.version = 1;

  const result = writeHooksFile(hooksPath, file);
  return { installed: result.ok, path: hooksPath, message: result.message };
}

/** 卸载 Cursor 的钩子；其它 hook 原样保留。 */
export function removeCursorHook(root: string): { removed: boolean; path: string } {
  const hooksPath = join(root, CURSOR_HOOKS_RELATIVE);
  if (!existsSync(hooksPath)) return { removed: false, path: hooksPath };
  try {
    const file = readHooksFile<CursorHooksFile>(hooksPath);
    const hooks = { ...(file.hooks ?? {}) };
    const before = hooks.preToolUse?.length ?? 0;
    const after = (hooks.preToolUse ?? []).filter((entry) => !isZeltoCursorEntry(entry));
    if (after.length === before) return { removed: false, path: hooksPath };

    if (after.length > 0) hooks.preToolUse = after;
    else delete hooks.preToolUse;
    file.hooks = hooks;
    writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    return { removed: true, path: hooksPath };
  } catch {
    return { removed: false, path: hooksPath };
  }
}

/** Cursor 钩子是否已安装。 */
export function cursorHookInstalled(root: string): boolean {
  const hooksPath = join(root, CURSOR_HOOKS_RELATIVE);
  if (!existsSync(hooksPath)) return false;
  try {
    const file = readHooksFile<CursorHooksFile>(hooksPath);
    return (file.hooks?.preToolUse ?? []).some((entry) => isZeltoCursorEntry(entry));
  } catch {
    return false;
  }
}

/**
 * Cursor 的 zelto hook 是否**显式 fail closed**。
 *
 * 单独暴露一个判据 —— 因为「装上了但没写 failClosed」是**看不见的失效**：
 * 配置文件里有 zelto 的条目，看起来一切正常，
 * 但 hook 崩了就会放行。这是 ADR-083 §4 要求守住的点。
 */
export function cursorHookFailsClosed(root: string): boolean {
  const hooksPath = join(root, CURSOR_HOOKS_RELATIVE);
  if (!existsSync(hooksPath)) return false;
  try {
    const file = readHooksFile<CursorHooksFile>(hooksPath);
    const entry = (file.hooks?.preToolUse ?? []).find((e) => isZeltoCursorEntry(e));
    return entry?.failClosed === true;
  } catch {
    return false;
  }
}

/** 安装 Codex 的 PreToolUse 钩子。 */
export function installCodexHook(options: ClaudeHookOptions): {
  installed: boolean;
  path: string;
  message: string;
} {
  const hooksPath = join(options.root, CODEX_HOOKS_RELATIVE);
  const file = readHooksFile<CodexHooksFile>(hooksPath);

  const hooks = { ...(file.hooks ?? {}) };
  const preToolUse = (hooks.PreToolUse ?? []).filter((entry) => !isZeltoCursorEntry(entry));
  preToolUse.push({
    command: buildHarnessHookCommand('codex', options),
    matcher: CODEX_PRETOOL_MATCHER,
  });
  hooks.PreToolUse = preToolUse;
  file.hooks = hooks;

  const result = writeHooksFile(hooksPath, file);
  return { installed: result.ok, path: hooksPath, message: result.message };
}

/** 卸载 Codex 的钩子；其它 hook 原样保留。 */
export function removeCodexHook(root: string): { removed: boolean; path: string } {
  const hooksPath = join(root, CODEX_HOOKS_RELATIVE);
  if (!existsSync(hooksPath)) return { removed: false, path: hooksPath };
  try {
    const file = readHooksFile<CodexHooksFile>(hooksPath);
    const hooks = { ...(file.hooks ?? {}) };
    const before = hooks.PreToolUse?.length ?? 0;
    const after = (hooks.PreToolUse ?? []).filter((entry) => !isZeltoCursorEntry(entry));
    if (after.length === before) return { removed: false, path: hooksPath };

    if (after.length > 0) hooks.PreToolUse = after;
    else delete hooks.PreToolUse;
    file.hooks = hooks;
    writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    return { removed: true, path: hooksPath };
  } catch {
    return { removed: false, path: hooksPath };
  }
}

/** Codex 钩子是否已安装。 */
export function codexHookInstalled(root: string): boolean {
  const hooksPath = join(root, CODEX_HOOKS_RELATIVE);
  if (!existsSync(hooksPath)) return false;
  try {
    const file = readHooksFile<CodexHooksFile>(hooksPath);
    return (file.hooks?.PreToolUse ?? []).some((entry) => isZeltoCursorEntry(entry));
  } catch {
    return false;
  }
}

// ─── git hooks ──────────────────────────────────────────────────────────────

export interface HookScriptOptions {
  /**
   * zelto-hook 二进制的绝对路径（正斜杠形式）。
   * 不给就退回「仓库内 dist/hook/index.js」。
   */
  binaryPath?: string | null;
  /**
   * 策略所在的项目根绝对路径（正斜杠形式）——
   * hook 靠它找到 policy/policy.yaml。给空就退回 git 仓库根。
   */
  projectRoot?: string | null;
  /** node 可执行文件路径；给空就用 PATH 里的 node。 */
  nodePath?: string | null;
}

/**
 * 生成 git hook 脚本。
 *
 * 注意判定循环用的是 `while ... done < 文件` 而不是 `echo | while ... done`：
 * 后者会在子 shell 里跑循环，循环里给 HAS_DENY 赋值传不回外层，
 * 于是「有文件被拒绝」永远传不到退出码上（这个 bug 让 pre-commit 形同虚设）。
 *
 * 拦截口径（ADR-119），三分支：
 *
 * - **判定没跑成**（没有 decision，或 deny 且 matched_rule 为 `null`）→ **拦截**。
 *   hook 进程自己出错时输出 `matched_rule: null`；这不是「没有规则匹配」，
 *   是守卫本身坏了 —— 静默放行会让人以为门禁还在（C9）。
 * - **显式 deny**（matched_rule 是某条规则，含保护域 `protected:human` 以外的）→ 拦截；
 * - **default deny**（matched_rule == "default"，「没有规则匹配」）→ 只告警放行 ——
 *   否则策略没覆盖到的文件会把整条提交堵死，钩子反而变成摆设。运行时
 *   PreToolUse 对 agent 写仍是 fail closed；这里只降级提交时刻的兜底档。
 */
export function hookScript(name: string, condition: string, options: HookScriptOptions = {}): string {
  const binary = (options.binaryPath ?? '').replace(/\\/g, '/');
  const projectRoot = (options.projectRoot ?? '').replace(/\\/g, '/');
  const nodeBin = (options.nodePath ?? 'node').replace(/\\/g, '/');

  return `#!/bin/sh
${GIT_HOOK_MARKER}
# Auto-installed by \`zelto hook --install\`
# Runs zelto-hook policy check on ${name}

# --- 定位 zelto-hook 二进制 ---
ZELTO_HOOK="${binary}"
if [ ! -f "\$ZELTO_HOOK" ]; then
  FALLBACK="\$(git rev-parse --show-toplevel 2>/dev/null)/dist/hook/index.js"
  if [ -f "\$FALLBACK" ]; then
    ZELTO_HOOK="\$FALLBACK"
  fi
fi
if [ ! -f "\$ZELTO_HOOK" ]; then
  echo "❌ zelto-hook: Binary not found at \$ZELTO_HOOK"
  echo "   Rebuild zelto, then re-run 'zelto hook --install'."
  echo "   To skip zelto check: git commit --no-verify"
  exit 1
fi

# --- 策略所在的项目根 ---
ZELTO_PROJECT_ROOT="${projectRoot}"
if [ -z "\$ZELTO_PROJECT_ROOT" ]; then
  ZELTO_PROJECT_ROOT="\$(git rev-parse --show-toplevel 2>/dev/null)"
fi
export ZELTO_PROJECT_ROOT

NODE_BIN="${nodeBin}"
if [ ! -f "\$NODE_BIN" ]; then
  NODE_BIN="node"
fi

# --- 这次提交是谁发起的（D-24）---
#
# 保护域防的是 **agent**：agent 不许改策略（改了策略就等于解除了对自己的约束）。
# 但**人必须能改策略** —— C5 的配套流程是「人改 policy/policy.yaml →
# zelto policy lock --update 重新锚定」，拦掉人的提交会让这条流程走不通。
#
# 判据：zelto 起 agent 时注入 ZELTO_SLICE_ID / ZELTO_SESSION_ID，
# agent 派生的 git 进程会继承；人从终端直接提交时没有这些标记。
#
# 这个标记是**可判定的事实**（读环境变量），而不是「猜是谁按的按钮」。
if [ -n "\${ZELTO_SLICE_ID:-}" ] || [ -n "\${ZELTO_SESSION_ID:-}" ] || [ -n "\${ZELTO_AGENT_SESSION_ID:-}" ]; then
  HARNESS="git-agent"
else
  HARNESS="git-human"
fi

${condition}
if [ \$? -ne 0 ]; then
  FILES="${name === 'pre-commit' ? '$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR)' : '$(git -c core.quotePath=false diff --name-only @{push}.. 2>/dev/null || git -c core.quotePath=false diff --name-only HEAD~1..)'}"
  if [ -z "$FILES" ]; then
    exit 0
  fi

  HAS_DENY=0
  FILE_LIST="\$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/zelto-hooks-\$\$")"
  printf '%s\\n' "$FILES" > "\$FILE_LIST"

  while IFS= read -r file; do
    if [ -n "$file" ]; then
      RESULT=\$(echo "{\\"path\\":\\"$file\\",\\"operation\\":\\"write\\",\\"harness\\":\\"\$HARNESS\\"}" | "\$NODE_BIN" "\$ZELTO_HOOK" 2>/dev/null)
      DECISION=\$(echo "\$RESULT" | grep -o '"decision":"[^"]*"' | head -1 | cut -d'"' -f4)
      RULE=\$(echo "\$RESULT" | grep -o '"matched_rule":"[^"]*"' | head -1 | cut -d'"' -f4)
      BASIS=\$(echo "\$RESULT" | grep -o '"basis":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ "\$DECISION" = "deny" ] && [ "\$RULE" = "null" ]; then
        # 判定进程没给结论（崩溃 / 空输出 / 输入非法）—— fail closed（C9）。
        echo "❌ zelto-hook: \$file 的策略判定未完成（no verdict）"
        if [ -n "\$BASIS" ]; then echo "   Basis: \$BASIS"; fi
        echo "   To skip zelto check: git commit --no-verify"
        HAS_DENY=1
      elif [ "\$DECISION" = "deny" ] && [ "\$RULE" = "default" ]; then
        # 没有规则匹配 —— 只告警（ADR-119 决策一）
        echo "⚠️  zelto-hook: \$file 不在策略允许范围内（默认拒绝）—— 提交放行，但请确认"
      elif [ "\$DECISION" = "deny" ]; then
        echo "❌ zelto-hook: DENIED write to \$file"
        echo "   Basis: \$BASIS"
        HAS_DENY=1
      elif [ "\$DECISION" != "allow" ]; then
        # 既不是 deny 也不是 allow —— 守卫没跑成，按判定未完成处理
        echo "❌ zelto-hook: \$file 的策略判定未完成（no verdict）"
        echo "   To skip zelto check: git commit --no-verify"
        HAS_DENY=1
      fi
    fi
  done < "\$FILE_LIST"

  rm -f "\$FILE_LIST"

  if [ "\$HAS_DENY" = "1" ]; then
    echo ""
    echo "zelto-hook: Policy check failed. Commit blocked."
    exit 1
  fi
fi
`;
}

// ─── 安装作用域：只装进「被管理的项目」 ───────────────────────────────────

export interface HookInstallScope {
  /** git hooks 装到哪个仓库根；null 表示不装 */
  root: string | null;
  /** 判定依据（打印给用户看） */
  reason: string;
}

/** 读一个目录下的 .zelto/config.yaml（用与 shared.ts 相同的解析器）。 */
function readConfigAt(dir: string): ReturnType<typeof parseConfigYaml> {
  const configPath = join(dir, ZELTO_DIR_NAME, 'config.yaml');
  if (!existsSync(configPath)) return null;
  try {
    return parseConfigYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

const ZELTO_DIR_NAME = '.zelto';

/** 这个目录是不是 zelto 工具自己的源码库（而不是被管理的项目）。 */
export function isZeltoToolCheckout(dir: string): boolean {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
    if (pkg.name !== 'zelto') return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, 'src', 'hook', 'index.ts'));
}

/** 这个目录是不是被 zelto 管理的项目（有 .zelto/）。 */
export function isManagedProject(dir: string): boolean {
  return existsSync(join(dir, ZELTO_DIR_NAME));
}

/**
 * 决定 git hooks 装到哪个仓库。
 *
 * 规则：
 * 1. 当前目录是 zelto 工具自身的源码库 → git hooks 属于「被管理的项目」，
 *    不装在工具仓库里。改用配置里的 targetProject（若指向一个真实目录）。
 * 2. 当前目录是被管理的项目（有 .zelto/）→ 装在这里。
 * 3. 其余情况（随便一个目录）→ 不装，并说明原因。
 */
export function resolveHookInstallRoot(cwd: string = process.cwd()): HookInstallScope {
  if (isZeltoToolCheckout(cwd)) {
    const cfg = readConfigAt(cwd);
    const target = cfg?.targetProject?.path;
    if (target) {
      const dir = resolve(cwd, target);
      if (existsSync(dir)) {
        return { root: dir, reason: `zelto 工具仓库 → 被管理的项目（targetProject）：${dir}` };
      }
      return { root: null, reason: `zelto 工具仓库 → targetProject 指向的目录不存在：${dir}` };
    }
    return {
      root: null,
      reason: '这是 zelto 工具自身的源码库，且没有配置 targetProject —— git hooks 只装在被管理的项目里',
    };
  }

  if (isManagedProject(cwd)) {
    return { root: cwd, reason: `当前项目：${cwd}` };
  }

  return {
    root: null,
    reason: '当前目录不是被 zelto 管理的项目（缺少 .zelto/）—— git hooks 只装在被管理的项目里',
  };
}

/** 解析某个仓库的 git hooks 目录（worktree 下也能定位到真正的 hooks 目录）。 */
export function gitHooksDir(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

// ─── 命令实现 ───────────────────────────────────────────────────────────────

export async function hookCommand(args: string[]): Promise<number> {
  const action = args[0];
  const wantClaude = args.includes('--claude');

  // 多 harness（ADR-083）。
  //
  // 默认装**全部**已知的 harness —— 一个项目里往往同时开着好几种 agent。
  // `--all` 显式声明「全装」，供脚本使用（默认值将来变化时行为不漂移）。
  const wantCursor = args.includes('--cursor');
  const wantCodex = args.includes('--codex');
  const wantAllHarnesses = args.includes('--all');
  const anyHarnessFlag = wantClaude || wantCursor || wantCodex || wantAllHarnesses;

  // `--xxx-only` 是**排他**的：只动这一个 harness。
  //
  // 之前 `onlyHarness` 只是个布尔量，装卸时只用来决定「要不要顺带装
  // git hooks」—— harness 列表本身照样按上面的规则全装了一遍。
  // 于是 `zelto hook --install --cursor-only` 装了三个 harness：
  // 名字说「只装 Cursor」，实际把 Claude Code 与 Codex 也动了。
  //
  // **说了只做一件事却做了三件** —— 人以为没动 Claude Code，
  // 实际上 `.claude/settings.local.json` 已经被改了。
  const onlyCursor = args.includes('--cursor-only');
  const onlyCodex = args.includes('--codex-only');
  const onlyClaude = args.includes('--claude-only');

  /** 要装/卸的 harness 列表。 */
  const harnesses: Array<'claude-code' | 'cursor' | 'codex'> = [];
  if (onlyCursor) {
    harnesses.push('cursor');
  } else if (onlyCodex) {
    harnesses.push('codex');
  } else if (onlyClaude) {
    harnesses.push('claude-code');
  } else {
    if (wantCursor || (anyHarnessFlag && !wantClaude)) harnesses.push('cursor');
    if (wantCodex || (anyHarnessFlag && !wantClaude)) harnesses.push('codex');
    if (wantClaude || (anyHarnessFlag && !wantCursor && !wantCodex)) harnesses.push('claude-code');
    // 没有任何旗标 → 默认全装（ADR-083 §5）
    if (harnesses.length === 0) harnesses.push('cursor', 'codex', 'claude-code');
  }

  /** 装某个 harness 的 hook。 */
  function installHarnessHook(harness: 'claude-code' | 'cursor' | 'codex'): void {
    const opts = { root: process.cwd() };
    if (harness === 'claude-code') {
      const result = installClaudeCodeHook(opts);
      if (result.installed) {
        console.log(`  ✅ Claude Code PreToolUse hook installed → ${result.path}`);
      } else {
        console.error(`  ❌ Claude Code hook install failed: ${result.message}`);
      }
      return;
    }
    if (harness === 'cursor') {
      const result = installCursorHook(opts);
      if (result.installed) {
        console.log(`  ✅ Cursor preToolUse hook installed → ${result.path}`);
        console.log(`     (failClosed: true —— hook 出错也阻断，与 C9 一致)`);
      } else {
        console.error(`  ❌ Cursor hook install failed: ${result.message}`);
      }
      return;
    }
    const result = installCodexHook(opts);
    if (result.installed) {
      console.log(`  ✅ Codex PreToolUse hook installed → ${result.path}`);
    } else {
      console.error(`  ❌ Codex hook install failed: ${result.message}`);
    }
  }

  /** 卸某个 harness 的 hook。 */
  function uninstallHarnessHook(harness: 'claude-code' | 'cursor' | 'codex'): void {
    const root = process.cwd();
    if (harness === 'claude-code') {
      const result = removeClaudeCodeHook(root);
      console.log(
        result.removed
          ? `  ✅ Claude Code PreToolUse hook uninstalled`
          : `  ⬜ Claude Code PreToolUse hook — not installed`,
      );
      return;
    }
    if (harness === 'cursor') {
      const result = removeCursorHook(root);
      console.log(
        result.removed ? `  ✅ Cursor preToolUse hook uninstalled` : `  ⬜ Cursor preToolUse hook — not installed`,
      );
      return;
    }
    const result = removeCodexHook(root);
    console.log(
      result.removed ? `  ✅ Codex PreToolUse hook uninstalled` : `  ⬜ Codex PreToolUse hook — not installed`,
    );
  }

  /** 某个 harness 的安装状态。 */
  function harnessStatus(harness: 'claude-code' | 'cursor' | 'codex'): string {
    const root = process.cwd();
    if (harness === 'claude-code') {
      return claudeCodeHookInstalled(root)
        ? `  ✅ claude-code PreToolUse — installed (${CLAUDE_SETTINGS_RELATIVE})`
        : `  ⬜ claude-code PreToolUse — not installed`;
    }
    if (harness === 'cursor') {
      if (!cursorHookInstalled(root)) {
        return `  ⬜ cursor preToolUse — not installed`;
      }
      // 「装上了但没 failClosed」是**看不见的失效** —— 必须单独说。
      if (!cursorHookFailsClosed(root)) {
        return `  ⚠️  cursor preToolUse — installed but NOT failClosed（hook 出错会放行）`;
      }
      return `  ✅ cursor preToolUse — installed (failClosed) (${CURSOR_HOOKS_RELATIVE})`;
    }
    return codexHookInstalled(root)
      ? `  ✅ codex PreToolUse — installed (${CODEX_HOOKS_RELATIVE})`
      : `  ⬜ codex PreToolUse — not installed`;
  }

  // git hooks 的作用域：只装在被管理的项目里。
  const scope = resolveHookInstallRoot(process.cwd());
  const GIT_HOOKS_DIR = scope.root ? gitHooksDir(scope.root) : null;

  async function installHook(name: string, condition: string): Promise<boolean> {
    if (!GIT_HOOKS_DIR) return false;

    const hookBinary = hookEntryPath();
    if (!existsSync(hookBinary)) {
      console.warn(`  ⚠️  zelto-hook binary not found at ${hookBinary}`);
      console.warn(`     Hooks will be installed but will skip checks until "pnpm build" is run.`);
    }

    const hookPath = join(GIT_HOOKS_DIR, name);
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8');
      if (!existing.includes(GIT_HOOK_MARKER) && !existing.includes('# zelto-hook')) {
        console.error(`  ⚠️  ${name} already exists (not a zelto hook). Skipping.`);
        console.error(`     Merge manually: ${hookPath}`);
        return false;
      }
    }
    mkdirSync(GIT_HOOKS_DIR, { recursive: true });
    writeFileSync(
      hookPath,
      hookScript(name, condition, {
        binaryPath: hookBinary,
        projectRoot: scope.root,
        nodePath: process.execPath,
      }),
      'utf-8',
    );
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows: chmod may fail
    }
    console.log(`  ✅ ${name} installed → ${hookPath}`);
    return true;
  }

  async function uninstallHook(name: string): Promise<boolean> {
    if (!GIT_HOOKS_DIR) return false;
    const hookPath = join(GIT_HOOKS_DIR, name);
    if (!existsSync(hookPath)) return false;
    const existing = readFileSync(hookPath, 'utf-8');
    if (!existing.includes(GIT_HOOK_MARKER)) {
      console.error(`  ⚠️  ${name} is not a zelto hook. Skipping.`);
      return false;
    }
    try {
      unlinkSync(hookPath);
    } catch {
      writeFileSync(hookPath, '', 'utf-8');
    }
    console.log(`  ✅ ${name} uninstalled`);
    return true;
  }

  if (action === '--install') {
    // agent harness 的写前钩子（ADR-083）
    for (const harness of harnesses) {
      installHarnessHook(harness);
    }
    if (onlyCursor || onlyCodex || onlyClaude) return 0;

    if (!scope.root || !GIT_HOOKS_DIR) {
      console.log(`  ℹ️  ${scope.reason}`);
      console.log(`     agent 钩子仍然安装在当前目录（agent 实际工作的地方）。`);
      return 0;
    }

    const hookType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    console.log(`Installing zelto git hooks... (${scope.reason})`);
    let count = 0;
    if (hookType === 'pre-commit' || hookType === 'all') {
      if (await installHook('pre-commit', 'git diff --cached --quiet --exit-code')) count++;
    }
    if (hookType === 'pre-push' || hookType === 'all') {
      if (await installHook('pre-push', 'git diff --quiet @{push}.. 2>/dev/null || git diff --quiet HEAD~1..')) count++;
    }
    console.log(`\n✅ ${count} hook(s) installed.`);
    return 0;
  }

  if (action === '--uninstall') {
    for (const harness of harnesses) {
      uninstallHarnessHook(harness);
    }
    if (onlyCursor || onlyCodex || onlyClaude) return 0;

    if (!scope.root || !GIT_HOOKS_DIR) {
      console.log(`  ℹ️  ${scope.reason}`);
      return 0;
    }

    const hookType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    console.log(`Uninstalling zelto git hooks... (${scope.reason})`);
    let count = 0;
    if (hookType === 'pre-commit' || hookType === 'all') {
      if (await uninstallHook('pre-commit')) count++;
    }
    if (hookType === 'pre-push' || hookType === 'all') {
      if (await uninstallHook('pre-push')) count++;
    }
    console.log(`\n✅ ${count} hook(s) uninstalled.`);
    return 0;
  }

  if (action === '--check' || action === '--status') {
    const checkType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    if (!scope.root || !GIT_HOOKS_DIR) {
      console.log(`  ℹ️  ${scope.reason}`);
    } else {
      console.log(`  ℹ️  ${scope.reason}`);
      for (const name of checkType === 'all' ? ['pre-commit', 'pre-push'] : [checkType]) {
        const hookPath = join(GIT_HOOKS_DIR, name);
        if (existsSync(hookPath)) {
          const content = readFileSync(hookPath, 'utf-8');
          if (content.includes(GIT_HOOK_MARKER)) {
            console.log(`  ✅ ${name} — zelto hook installed`);
          } else {
            console.log(`  ⚠️  ${name} — exists but not a zelto hook`);
          }
        } else {
          console.log(`  ⬜ ${name} — not installed`);
        }
      }
    }

    // agent harness 的写前钩子状态（ADR-083）
    console.log('');
    for (const harness of harnesses) {
      console.log(harnessStatus(harness));
    }
    return 0;
  }

  // Test a single file
  const testPath = args.find((a) => !a.startsWith('--'));
  if (testPath) {
    const { evaluatePolicy, isProtectedPath, hashPolicy } = await import('../../core/policy/engine.js');
    const config = loadPolicyConfig();
    const policyVersion = hashPolicy(JSON.stringify(config));
    const decision = evaluatePolicy(config, testPath, 'write', policyVersion);
    console.log(JSON.stringify(decision, null, 2));
    return 0;
  }

  console.error('Usage: zelto hook --install [pre-commit|pre-push|all] [--claude] [--cursor] [--codex] [--all]');
  console.error('       zelto hook --uninstall [pre-commit|pre-push|all] [--claude] [--cursor] [--codex] [--all]');
  console.error('       zelto hook --check [pre-commit|pre-push|all]');
  console.error('       zelto hook <file-path>');
  console.error('');
  console.error('  不带 harness 旗标时默认装全部已知 agent（claude-code / cursor / codex）。');
  console.error('  Cursor 的钩子必须显式带 failClosed —— Cursor 默认 fail open（hook 出错就放行）。');
  return 1;
}

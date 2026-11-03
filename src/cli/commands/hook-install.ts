// hook 安装 — git hooks + Claude Code PreToolUse 运行时钩子
//
// 两套钩子各管一段：
// - git pre-commit / pre-push：提交那一刻判定「这一批改动能不能进版本库」
// - Claude Code PreToolUse：agent 写下每一个文件的那一刻判定（ADR-014）
//
// C4: 安装/卸载都写事件（由调用方负责，这里只做纯文件操作）。

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyConfig } from './shared.js';

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
  /** 写 .claude/settings.local.json 的目录 */
  root: string;
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
  const root = resolve(options.root).replace(/\\/g, '/');
  const args = [
    entry,
    'pretool',
    '--project-root',
    root,
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

// ─── git hooks ──────────────────────────────────────────────────────────────

/**
 * 生成 git hook 脚本。
 *
 * 注意判定循环用的是 `while ... done < 文件` 而不是 `echo | while ... done`：
 * 后者会在子 shell 里跑循环，循环里给 HAS_DENY 赋值传不回外层，
 * 于是「有文件被拒绝」永远传不到退出码上（这个 bug 让 pre-commit 形同虚设）。
 */
export function hookScript(name: string, condition: string): string {
  return `#!/bin/sh
${GIT_HOOK_MARKER}
# Auto-installed by \`zelto hook --install\`
# Runs zelto-hook policy check on ${name}

# Validate zelto-hook binary exists
ZELTO_HOOK="$(git rev-parse --show-toplevel 2>/dev/null)/dist/hook/index.js"
if [ ! -f "$ZELTO_HOOK" ]; then
  echo "⚠️  zelto-hook: Binary not found at \$ZELTO_HOOK"
  echo "   Run 'pnpm build' or 'npx tsc -p tsconfig.json' first."
  echo "   To skip zelto check: git commit --no-verify"
  exit 0
fi

${condition}
if [ \$? -ne 0 ]; then
  FILES="${name === 'pre-commit' ? '$(git diff --cached --name-only --diff-filter=ACMR)' : '$(git diff --name-only @{push}.. 2>/dev/null || git diff --name-only HEAD~1..)'}"
  if [ -z "$FILES" ]; then
    exit 0
  fi

  HAS_DENY=0
  FILE_LIST="\$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/zelto-hooks-\$\$")"
  printf '%s\\n' "$FILES" > "\$FILE_LIST"

  while IFS= read -r file; do
    if [ -n "$file" ]; then
      RESULT=\$(echo "{\\"path\\":\\"$file\\",\\"operation\\":\\"write\\",\\"harness\\":\\"git\\"}" | node "\$ZELTO_HOOK" 2>/dev/null)
      DECISION=\$(echo "\$RESULT" | grep -o '"decision":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ "\$DECISION" = "deny" ]; then
        echo "❌ zelto-hook: DENIED write to \$file"
        BASIS=\$(echo "\$RESULT" | grep -o '"basis":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "   Basis: \$BASIS"
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

// ─── 命令实现 ───────────────────────────────────────────────────────────────

export async function hookCommand(args: string[]): Promise<number> {
  const action = args[0];
  const GIT_HOOKS_DIR = join(process.cwd(), '.git', 'hooks');
  const wantClaude = args.includes('--claude');
  const onlyClaude = args.includes('--claude-only');

  async function installHook(name: string, condition: string): Promise<boolean> {
    const hookBinary = join(process.cwd(), 'dist', 'hook', 'index.js');
    if (!existsSync(hookBinary)) {
      console.warn(`  ⚠️  zelto-hook binary not found at dist/hook/index.js`);
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
    writeFileSync(hookPath, hookScript(name, condition), 'utf-8');
    try {
      const { chmodSync } = await import('node:fs');
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows: chmod may fail
    }
    console.log(`  ✅ ${name} installed`);
    return true;
  }

  async function uninstallHook(name: string): Promise<boolean> {
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
    if (wantClaude || onlyClaude) {
      const result = installClaudeCodeHook({ root: process.cwd() });
      if (result.installed) {
        console.log(`  ✅ Claude Code PreToolUse hook installed → ${result.path}`);
      } else {
        console.error(`  ❌ Claude Code hook install failed: ${result.message}`);
      }
      if (onlyClaude) return 0;
    }

    const hookType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    console.log('Installing zelto git hooks...');
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
    if (wantClaude || onlyClaude) {
      const result = removeClaudeCodeHook(process.cwd());
      if (result.removed) console.log(`  ✅ Claude Code PreToolUse hook uninstalled`);
      else console.log(`  ⬜ Claude Code PreToolUse hook — not installed`);
      if (onlyClaude) return 0;
    }

    const hookType = args.find((a) => a.startsWith('pre-')) ?? 'all';
    console.log('Uninstalling zelto git hooks...');
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

    const claudeInstalled = claudeCodeHookInstalled(process.cwd());
    console.log(
      claudeInstalled
        ? `  ✅ claude-code PreToolUse — installed (${join(CLAUDE_SETTINGS_RELATIVE)})`
        : `  ⬜ claude-code PreToolUse — not installed`,
    );
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

  console.error('Usage: zelto hook --install [pre-commit|pre-push|all] [--claude]');
  console.error('       zelto hook --uninstall [pre-commit|pre-push|all] [--claude]');
  console.error('       zelto hook --check [pre-commit|pre-push|all]');
  console.error('       zelto hook <file-path>');
  return 1;
}

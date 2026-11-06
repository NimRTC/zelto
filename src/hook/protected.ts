// hook 内部共享的路径匹配与保护域定义。
//
// 为什么单独一个文件：hook/ 是**可独立编译的判定进程**，不能 import core/
// （否则 hook 就得拖上整个 core 的编译产物）。所以 core/policy/engine.ts 与
// hook/ 各有一份 glob 与保护域实现——这是约束逼出来的，不是疏忽。
//
// 但「有意复制」不等于「可以漂移」：
//   - hook 内部（index.ts 与 pretool.ts）**必须共用这一份**，不许各抄各的；
//   - hook 与 core 之间的等价性由 tests/protected-domain-parity.test.ts 守住。
//
// 保护域是硬约束（C5 / C8）：不可被任何策略规则覆盖。改它等于改不变量，
// 必须走 ADR。

/** 把路径统一成正斜杠，便于跨平台比较。 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 受保护域：策略规则改不动它（C5 / C8）。
 *
 * 与 core/policy/engine.ts 的 PROTECTED_PATTERNS 必须逐项相同 ——
 * 漂移的后果是「本该拦住的文件被放行」。
 */
export const PROTECTED_PATTERNS: readonly string[] = [
  'policy/**',
  '.zelto/**',
  'AGENTS.md',
  '.cursor/rules/**',
  'zelto-hook',
  'zelto-hook.exe',
];

export function globToRegExp(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/\*\*\//g, '<<<DS>>>/')
    .replace(/\*\*/g, '<<<DSB>>>')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DS>>>\//g, '(.+/|)')
    .replace(/<<<DSB>>>/g, '.*');
  return new RegExp(`^${regexStr}$`);
}

export function matchPath(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATTERNS.some((p) => matchPath(p, path));
}

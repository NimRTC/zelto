// 「以后都允许」的授权记忆 —— zelto 侧，不是 agent 侧（ADR-133 补充）
//
// ── 为什么授权记忆在 zelto，不在 agent ─────────────────────────────────
//
// ACP 协议给 agent 两个放行选项：`allow_once`（本次）与 `allow_always`
// （以后都允许）。字面上看，把 `allow_always` 回给 agent 就实现了
// 「用户可以打开这个选项」。
//
// **但实测（2026-11-27，cursor-agent 2026.09.18-9a7762b）不能这么做。**
//
// agent 收到 `allow_always` 后的动作（`index.js` 的
// `InteractivePermissionsService.addToAllowList`）：
//
//   async addToAllowList(e, t, r) {
//     const n = `${t}(${r})`;
//     await this.permissionsProvider.updatePermissions((e) => {
//       const t = e.allow.includes(n) ? e.allow : [...e.allow, n];
//       return { ...e, allow: t };
//     });
//   }
//
// 即 —— 条目被写进 **agent 自己的 `.cursor/permissions.json`**（工作区级、
// 持久化）。之后同类操作**根本不再问 zelto**：
//
//   1. zelto 的**逐写判定**对该路径永久失效；
//   2. 这份记忆**跨切片存活** —— 下一个切片还在写同一个路径，
//      照样不问 zelto；
//   3. 写集预约是**按切片**的 —— 上一轮的「以后都允许」
//      会变成下一轮的越界通道。
//
// 这正是 ADR-133 决策四硬规则 1 要防的：
// 「写集预约是逐写判定的，allow_always 与它直接冲突」。
//
// ── 那怎么实现用户的意图 ──────────────────────────────────────────────
//
// **zelto 自己记住「以后都允许」，但对 agent 始终回 `allow_once`。**
//
//   - agent 的 allowlist 里**永远不会有** zelto 管理的路径
//     → 每次写仍然问 zelto → 逐写判定不被绕过；
//   - 用户仍然得到「别再烦我」的体验 —— zelto 直接放行，不再提问；
//   - 记忆由 **zelto** 管，可以限制在「当前切片的写集内」，
//     且随切片结束而消亡（文件是按切片分的）；
//   - 每次放行照常写 `policy.decision` 事件 → 审计链不丢。
//
// 代价：agent 侧仍会反复请求权限，但 zelto 秒回，人看不到提示。
// 换来的是 C9 的主防线**一点没松**。
//
// ── 边界：授权范围 ────────────────────────────────────────────────────
//
// 用户拍板（2026-11-27）：**只对当前切片写集内的路径**放开。
//
// 所以授权记忆必须同时满足：
//
//   1. 路径在**本次判定的写集内**（`ctx.writes`）—— 否则越界；
//   2. 路径在**用户配置的白名单**里（`agent.acp.alwaysAllowPaths`）——
//      缺省为空 = **关闭**。用户说「不重要的模块可以打开」，
//      那他就得在配置里明确列出那些模块。
//
// 两条都满足才允许「以后都允许」；否则只能本次放行。
//
// C1：状态只在文件里 —— 授权记忆写 `.zelto/locks/` 下的文件，
// 不进内存常驻（进程重启后仍在，因为它是「这一轮切片的决定」）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 授权记忆文件所在目录（相对项目根）。 */
export const ALWAYS_GRANTS_DIR = '.zelto/locks';

/** 一条「以后都允许」的授权。 */
export interface AlwaysGrant {
  /** 被授权的路径（相对 worktree 的 posix 路径） */
  path: string;
  /** 授权时所属的切片 —— 换切片即失效 */
  sliceId: string;
  /** 授权时间（ISO） */
  grantedAt: string;
  /** 授权来源（留痕：谁在什么语境下授权的） */
  source: string;
}

/** 授权记忆文件的内容形状。 */
interface GrantsFile {
  grants: AlwaysGrant[];
}

/** 授权记忆文件路径（按切片分文件 —— 换切片自然失效）。 */
export function grantsPath(projectRoot: string, sliceId: string): string {
  return join(projectRoot, ALWAYS_GRANTS_DIR, `always-${sliceId}.json`);
}

/**
 * 读一个切片的授权记忆。
 *
 * 读不到 / 坏掉 → 空列表（**不猜**）。缺省没有任何授权。
 */
export function loadGrants(projectRoot: string, sliceId: string): AlwaysGrant[] {
  const path = grantsPath(projectRoot, sliceId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as GrantsFile;
    if (!parsed || !Array.isArray(parsed.grants)) return [];
    return parsed.grants.filter(
      (g): g is AlwaysGrant =>
        !!g &&
        typeof g.path === 'string' &&
        g.path.length > 0 &&
        typeof g.sliceId === 'string' &&
        typeof g.grantedAt === 'string' &&
        typeof g.source === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 写一个切片的授权记忆（**覆盖** —— 这是一份「当前状态」快照）。
 *
 * 与事件流不同：授权记忆是**可变状态**，不需要 append-only
 * （append-only 是对「事件」的约束，ADR-014/C4 约束的是判定事件）。
 */
export function saveGrants(projectRoot: string, sliceId: string, grants: AlwaysGrant[]): void {
  const dir = join(projectRoot, ALWAYS_GRANTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload: GrantsFile = { grants };
  writeFileSync(grantsPath(projectRoot, sliceId), JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * 追加一条授权（同路径覆盖 —— 重复授权不重复记账）。
 */
export function addGrant(
  projectRoot: string,
  sliceId: string,
  grant: Omit<AlwaysGrant, 'sliceId' | 'grantedAt'> & { grantedAt?: string },
): AlwaysGrant[] {
  const existing = loadGrants(projectRoot, sliceId).filter((g) => g.path !== grant.path);
  const next: AlwaysGrant = {
    path: grant.path,
    sliceId,
    grantedAt: grant.grantedAt ?? new Date().toISOString(),
    source: grant.source,
  };
  existing.push(next);
  saveGrants(projectRoot, sliceId, existing);
  return existing;
}

/**
 * 某条路径是否已经有「以后都允许」的授权。
 *
 * **精确匹配** —— 不做 glob。授权是**具体某条路径**的授权，
 * 不是「这个目录以后都行」。范围控制靠两条：
 *
 *   1. 配置白名单（`alwaysAllowPaths`，可含 glob）；
 *   2. 写集内（`ctx.writes`）。
 *
 * 授权记忆本身记的是**确切路径** —— 记成 glob 会让一条
 * 「允许写 src/a.ts」的授权悄悄变成「允许写整个 src/」。
 */
export function hasGrant(grants: AlwaysGrant[], path: string): boolean {
  return grants.some((g) => g.path === path);
}

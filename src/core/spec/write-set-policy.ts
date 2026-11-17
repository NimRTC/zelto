// 写集与策略的交集判定 —— 门禁① 在「agent 开跑之前」就要回答的一个问题：
//
//   「这片声明要写的路径，policy.yaml 放行吗？」
//
// 病灶（实测于 nimrtc-zelto v2-ai-decision）：
//
//   切片写集声明 `demo-agent-realtime/**`，而 policy.yaml 的 allow 规则只覆盖
//   `src/**` `cmake/**` `docs/**` `examples/**` `interop/**` `profiles/**`
//   `scripts/**` `specs/**` `tests/**` `tools/**`。于是：
//
//   - 门禁①放行（写集路径不逃逸、不进保护域 → 没有任何阻断项）
//   - agent 起跑，第一次写文件就被 hook 按 `policy.yaml#default` 拒绝
//   - agent 换路径再试 → 再被拒 → 一路烧 token 直到超时
//
//   也就是说：**一片从一开始就注定写不出任何东西的切片，被放进了跑批**。
//   门禁①存在的意义正是「跑之前就确定跑不起来就别跑」（ADR-042），
//   而写集与策略互相矛盾正是这类「注定跑不起来」。
//
// 判定口径（三条都要，缺一条就会漏判）：
//
//   1. **写集路径完全不被任何 allow 规则覆盖** → 阻断。
//      这是最硬的：agent 一次都写不进去。
//   2. **写集路径被 deny 规则覆盖** → 阻断（保护域另行处理）。
//   3. **写集路径被 ask 规则覆盖** → 提示（人可以在跑之前拍板）。
//
// 只看**规则层面**的匹配，不做「这个文件现在存不存在」的判断 ——
// 存在性归 `evaluateWriteSet` 管，两边职责不重叠。
//
// C2: core/ 零第三方依赖；C3: 纯计算，不调模型、不触网。

import { matchPath } from '../policy/engine.js';
import type { PolicyConfig } from '../policy/types.js';

/** 一条写集与策略的冲突。 */
export interface WriteSetPolicyConflict {
  /** 写集条目（glob 或具体路径） */
  write: string;
  /** 命中的规则 id */
  ruleId: string | null;
  /** 冲突的严重级 */
  severity: 'blocking' | 'advisory';
  /** 人能看懂的一句话说明 */
  message: string;
}

/** 交集判定的结果。 */
export interface WriteSetPolicyResult {
  /** 阻断项：写集与策略互相矛盾，这片注定跑不起来 */
  conflicts: WriteSetPolicyConflict[];
  /** 提示项：需要人拍板，但不必然跑不起来 */
  advisories: WriteSetPolicyConflict[];
}

/** 归一化成正斜杠（跨平台比较的前提）。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * glob 写集与一条规则路径的交集判定。
 *
 * 两条 glob 要判「有没有交集」，不能简单地把其中一条当正则去测另一条 ——
 * `src/**` 与 `src/modules/rd_input/**` 有交集，但
 * `demo-agent-realtime/**` 与 `src/**` 没有。
 *
 * 做法：把规则路径**逐段**下探到写集 glob 能接受的形状里。
 * 这里采取保守策略：**宁可判「有交集」也不判「没交集」**——
 * 误报会多提示一句，漏报会让一片注定跑不起来的切片跑起来。
 */
function globMayOverlap(writeGlob: string, rulePath: string): boolean {
  const w = toPosix(writeGlob);
  const r = toPosix(rulePath);

  // 写集是 glob，规则是字面路径：
  //   把字面路径逐段拿去测写集 glob，命中任一段即算有交集。
  //   （`src/**` 测 `src/modules/x.cpp` → `src/modules/x.cpp` 命中 → 有交集；
  //     `src/**` 测 `docs/a.md` → 不命中 → 无交集）
  if (w.includes('*') || w.includes('?')) {
    if (matchPath(w, r)) return true;
    // 规则路径是目录前缀时，写集可能落在它下面的子目录里：
    //   `examples/**` 与 `examples/demo/foo.cpp` → 上面已命中。
    //   `examples` （无通配）与 `examples/**` → 命中。
    //   规则路径带通配时，逐段下探：
    const rSegments = r.split('/');
    const wSegments = w.split('/');
    // 写集比规则更深时，先看规则前缀能否满足写集的前缀段
    const minLen = Math.min(rSegments.length, wSegments.length);
    for (let i = 0; i < minLen; i++) {
      const wSeg = wSegments[i];
      const rSeg = rSegments[i];
      if (wSeg === '**') {
        // 写集此处通配 → 规则剩下的段都可能被覆盖
        if (i < rSegments.length) return true;
        return false;
      }
      if (rSeg.includes('*') || rSeg.includes('?')) return true;
      if (wSeg !== rSeg) return false;
    }
    // 写集比规则短（如写集 `examples`、规则 `examples/demo/**`）
    // → 写集是规则的前缀，落在规则覆盖范围内 → 有交集
    if (wSegments.length <= rSegments.length) return true;
    return false;
  }

  // 写集是字面路径，规则是 glob：直接测
  if (r.includes('*') || r.includes('?')) {
    return matchPath(r, w);
  }

  // 两条都是字面路径：目录前缀关系
  const wTrim = w.replace(/\/+$/, '');
  const rTrim = r.replace(/\/+$/, '');
  return wTrim === rTrim || wTrim.startsWith(`${rTrim}/`) || rTrim.startsWith(`${wTrim}/`);
}

/**
 * 判定写集与策略规则是否互相矛盾。
 *
 * @param writes 切片的写集条目
 * @param policy 策略配置（policy.yaml 解析结果）
 */
export function evaluateWriteSetAgainstPolicy(
  writes: string[],
  policy: PolicyConfig | null,
): WriteSetPolicyResult {
  const conflicts: WriteSetPolicyConflict[] = [];
  const advisories: WriteSetPolicyConflict[] = [];

  if (!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) {
    // 没有策略就没有「互相矛盾」可言 —— 写集是唯一判据。
    return { conflicts, advisories };
  }

  for (const raw of writes) {
    const write = toPosix(raw.trim());
    if (!write) continue;

    let allowed = false;
    let deniedBy: string | null = null;
    let askedBy: string | null = null;

    for (const rule of policy.rules) {
      const rulePath = rule.match.path;
      if (!rulePath) continue;
      // 只关心写操作
      if (rule.match.operation && rule.match.operation !== 'write') continue;

      if (!globMayOverlap(write, rulePath)) continue;

      if (rule.action === 'deny') {
        deniedBy = rule.id;
        break;
      }
      if (rule.action === 'allow') {
        allowed = true;
      } else if (rule.action === 'ask' && askedBy === null) {
        askedBy = rule.id;
      }
    }

    if (deniedBy !== null) {
      conflicts.push({
        write,
        ruleId: deniedBy,
        severity: 'blocking',
        message:
          `写集 "${write}" 命中策略的拒绝规则 "${deniedBy}" —— ` +
          `agent 写不进这个路径，这片注定跑不起来。`,
      });
      continue;
    }

    if (!allowed && askedBy !== null) {
      advisories.push({
        write,
        ruleId: askedBy,
        severity: 'advisory',
        message:
          `写集 "${write}" 命中策略的待确认规则 "${askedBy}" —— ` +
          `非交互运行下这条会被默认拒绝，建议先确认。`,
      });
      continue;
    }

    if (!allowed) {
      conflicts.push({
        write,
        ruleId: null,
        severity: 'blocking',
        message:
          `写集 "${write}" 不在 policy.yaml 的任何允许规则覆盖范围内 —— ` +
          `agent 第一次写文件就会被拒（policy.yaml#default）。` +
          `请把该路径加进 policy.yaml 的 allow 规则，或改写集。`,
      });
    }
  }

  return { conflicts, advisories };
}

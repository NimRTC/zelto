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

function hasGlob(p: string): boolean {
  return p.includes('*') || p.includes('?');
}

/**
 * 一条 glob 能否**接受**某个路径前缀（允许零段匹配）。
 *
 * `matchPath('examples/**', 'examples')` 是 false —— `**` 在这些规则里
 * 至少占一段。但判「写集能不能碰到这里」时，`examples/**` 的根目录
 * `examples` 显然在可达范围内：它下面的任何东西都归它。所以这里单独放宽
 * 「末端 `**` 的零段情形」，其余照 `matchPath` 的口径。
 */
function globReaches(pattern: string, path: string): boolean {
  if (matchPath(pattern, path)) return true;
  const c = toPosix(path).replace(/\/+$/, '');
  if (!c) return false;
  const p = toPosix(pattern).replace(/\/+$/, '');
  const segs = p.split('/').filter((s) => s !== '');
  for (let k = 1; k < segs.length; k++) {
    const prefix = segs.slice(0, k).join('/');
    if (prefix === c && (segs[k] === '**' || p.includes('**'))) return true;
  }
  return false;
}

/**
 * glob 写集与一条规则路径的「交集见证」。
 *
 * 两条 glob 要判「有没有交集」，不能把其中一条当正则去测另一条 ——
 * `src/**` 与 `src/modules/rd_input/**` 有交集（规则 `src/**` 接受
 * 写集里的任何具体路径），但没有哪一条包含另一条的字符串。
 *
 * 做法：**以写集为模板、在规则路径里找一件证物**。逐段对齐：
 *
 * - 写集字面段与规则字面段必须相等
 * - 写集字面段 vs 规则通配段 → 规则段必须命中这个字面段
 * - 写集通配段 vs 规则字面段 → 写集段必须命中这个字面段
 * - 两边同一位置都是通配 → 放弃（没有具体路径可借用，宁可不判「有交集」）
 * - 任一侧出现 `**` → 该侧剩余段全部「随便」，另一侧剩余段必须能落地
 *
 * 为什么必须严格：这条判据的两端都会误伤。
 * **误判「有交集」** → 写集明明放行不了，门禁却说没问题，
 * 一片注定跑不起来的切片被放进去烧 token（漏报，最糟）；
 * **误判「没交集」** → 门禁拦住一片其实能跑的切片，人被引去改正确的策略（误报）。
 * 见证法两头都堵住：找得出见证才说「有交集」。
 *
 * @returns 一件落在两边各自范围内的具体路径（见证）；无交集时 null
 */
function overlapWitness(writePath: string, rulePath: string): string | null {
  const w = toPosix(writePath).replace(/\/+$/, '');
  const r = toPosix(rulePath).replace(/\/+$/, '');

  // 完全同形的 pattern：一件证物都不必造，它自己就是
  if (w === r) return w;

  // 写集是字面路径：规则能接受它，它本身就是见证
  if (!hasGlob(w)) return globReaches(r, w) ? w : null;

  // 规则是字面路径：写集能接受它，它本身就是见证
  if (!hasGlob(r)) return globReaches(w, r) ? r : null;

  // 写集以 `**` 收尾（`dir/**`）：规则里任何落在 `dir` 下的路径都是见证。
  // 规则也以 `**` 收尾时，两边的根目录是同一个才算。
  //
  // 空写集（`**`）不归这条管：它的「根」是仓库根，对任何规则都成立，
  // 见上面的 `globReaches` 兜底。
  const wSegs = w.split('/').filter((s) => s !== '');
  const rSegs = r.split('/').filter((s) => s !== '');
  if (w === '**') return hasGlob(r) ? null : r;
  if (wSegs[wSegs.length - 1] === '**') {
    const wRoot = wSegs.slice(0, -1).join('/');
    if (wRoot === '' || wRoot.includes('*') || wRoot.includes('?')) {
      // 根目录本身带通配：只能尝试规则的所有前缀
      for (let k = rSegs.length; k >= 1; k--) {
        const cand = rSegs.slice(0, k).join('/');
        if (globReaches(w, cand) && globReaches(r, cand)) return cand;
      }
      return null;
    }
    // 规则路径里，`wRoot` 或其下一段就是见证
    for (let k = 1; k <= rSegs.length; k++) {
      const cand = rSegs.slice(0, k).join('/');
      if (!globReaches(w, cand)) continue;
      // 见证必须**真的被规则接受**：`x/src` 只命中 `x/src/**` 的前缀，
      // 不等于规则接受它，也不能用来证明与别的写集有交集。
      if (matchPath(r, cand)) return cand;
    }
    // 规则的根就在 `wRoot` 本身或它的前缀上（规则 `dir` / `dir/**`
    // vs 写集 `dir/**`）：见证取两者中更短的那个具体路径。
    for (let k = 1; k <= wSegs.length - 1; k++) {
      const cand = wSegs.slice(0, k).join('/');
      if (cand.includes('*') || cand.includes('?')) continue;
      if (globReaches(r, cand)) return cand;
    }
    return null;
  }

  // 写集不以 `**` 收尾：逐段对齐到写集耗尽。
  //
  // 对齐规则：两侧都有 `**` 段时，**先消费写集的 `**`**（把写集的剩余段
  // 对齐到规则尾部），否则先消费规则的 `**`（规则剩余段随便）。
  // 写集 `src/**\/*.ts` vs 规则 `src/**`：规则的 `**` 吞掉写集余下所有段，
  // 见证就是已对齐的前缀 `src`。
  const cand: string[] = [];
  let j = 0;
  for (let i = 0; i < wSegs.length; i++) {
    const wSeg = wSegs[i];
    if (wSeg === '**') {
      const wRest = wSegs.slice(i + 1);
      if (wRest.length === 0) {
        return cand.length > 0 ? cand.join('/') : null;
      }
      // 规则此处是 `dir/**/file` 或直接以 `**` 收尾：写集剩余段整体
      // 交给规则的 `**` 处理 —— 规则的 `**` 接受写集余下所有段。
      if (rSegs.includes('**', j)) {
        const firstDs = rSegs.indexOf('**', j);
        const before = rSegs.slice(0, firstDs);
        if (before.length !== j) return null;
        return cand.length > 0 ? cand.join('/') : before[before.length - 1];
      }
      // 规则没有 `**`：写集剩余段必须能对齐到规则剩余段的尾部
      const rRest = rSegs.slice(rSegs.length - wRest.length);
      if (rRest.length !== wRest.length) return null;
      for (let k = 0; k < wRest.length; k++) {
        if (hasGlob(wRest[k]) && hasGlob(rRest[k])) return null;
        if (hasGlob(wRest[k])) {
          if (!matchPath(wRest[k], rRest[k])) return null;
        } else if (hasGlob(rRest[k])) {
          if (!matchPath(rRest[k], wRest[k])) return null;
        } else if (wRest[k] !== rRest[k]) {
          return null;
        }
      }
      return rSegs.slice(0, rSegs.length - wRest.length).join('/') || null;
    }
    // 规则到了 `**`：写集剩余段全由规则的 `**` 接受
    while (j < rSegs.length && rSegs[j] === '**') {
      j++;
      if (j >= rSegs.length) {
        if (cand.length === 0) return null;
        return cand.join('/');
      }
    }
    if (j >= rSegs.length) return null;
    const rSeg = rSegs[j];
    if (hasGlob(wSeg) && hasGlob(rSeg)) return null;
    if (hasGlob(wSeg)) {
      if (!matchPath(wSeg, rSeg)) return null;
      cand.push(rSeg);
    } else if (hasGlob(rSeg)) {
      if (!matchPath(rSeg, wSeg)) return null;
      cand.push(wSeg);
    } else {
      if (wSeg !== rSeg) return null;
      cand.push(wSeg);
    }
    j++;
  }
  // 写集耗尽：规则剩余段可以随便（`**` 收尾），但至少要有见证
  if (cand.length === 0) return null;
  const witness = cand.join('/');
  return globReaches(r, witness) ? witness : null;
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

      if (overlapWitness(write, rulePath) === null) continue;

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

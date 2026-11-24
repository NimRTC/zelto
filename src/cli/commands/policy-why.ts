/**
 * policy-why.ts — `zelto why <path|[slice-id]>` 解释型命令（M2 / v3-why-command）。
 *
 * 只组装已有能力，不写新判定（C3）：
 *   - `core/policy/engine.ts#evaluatePolicy` 做判定
 *   - `ReservationStore` + `pathInWriteSet` 找归属切片与预约写集
 *   - `isProtectedPath` / `isZeltoManagedSpecPath` 给上下文
 *
 * 只读：全程只读文件、纯计算，不写任何状态、不追加事件（C1/C4）。
 * C6：cli/ 可依赖 core/，反之不行 —— 这里只 import core，不碰 adapters/。
 */

import { resolve } from 'node:path';
import { evaluatePolicy, isProtectedPath } from '../../core/policy/engine.js';
import { isZeltoManagedSpecPath } from '../../core/project/managed-paths.js';
import { ReservationStore, pathInWriteSet } from '../../core/sched/index.js';
import { loadPolicyConfig, store, register } from './shared.js';
import { writeOutput } from '../output.js';
import { colors } from '../color.js';

export interface WhyExplanation {
  target: string;
  mode: 'path' | 'slice';
  operation: string;
  decision: 'allow' | 'deny' | 'ask';
  ruleId: string | null;
  basis: string;
  guidance: string | null;
  protected: boolean;
  managedSpec: boolean;
  owners: Array<{ sliceId: string; writes: string[]; active: boolean }>;
  suggestion: string;
}

function locksDir(): string {
  return resolve(process.cwd(), '.zelto', 'locks');
}

/**
 * 找出「哪些切片（预约/定义）覆盖这个路径」。
 *
 * 生效预约优先（运行时凭据，C9），切片定义的 writes 兜底（潜在归属）。
 */
async function findOwners(target: string): Promise<WhyExplanation['owners']> {
  const out: WhyExplanation['owners'] = [];
  try {
    const reservations = new ReservationStore(locksDir());
    const active = await reservations.active();
    for (const r of active) {
      try {
        if (pathInWriteSet(target, r.writes)) {
          out.push({ sliceId: r.sliceId, writes: [...r.writes], active: true });
        }
      } catch { /* 单条坏预约不阻断解释 */ }
    }
  } catch { /* 无预约目录 = 无生效预约 */ }

  // 切片定义的 writes（潜在归属）：预约只在运行时存在，平时看定义。
  try {
    const ids = await store.list();
    for (const id of ids) {
      if (out.some((o) => o.sliceId === id)) continue;
      try {
        const s = await store.read(id);
        const writes = s.writes ?? [];
        if (writes.length > 0 && pathInWriteSet(target, writes)) {
          out.push({ sliceId: id, writes: [...writes], active: false });
        }
      } catch { /* 坏切片跳过 */ }
    }
  } catch { /* store 读不到就只报预约 */ }
  return out;
}

function suggestionFor(
  decision: 'allow' | 'deny' | 'ask',
  ruleId: string | null,
  guidance: string | null,
  protectedHit: boolean,
  managedSpec: boolean,
  owners: WhyExplanation['owners'],
): string {
  if (protectedHit) {
    return '命中保护域：agent 不得修改。若你是人，可直接改；改完 policy/policy.yaml 后记得 `zelto policy lock --update` 重新锚定。';
  }
  if (managedSpec) {
    return 'zelto 托管的规格文件（specs/slices/*.md）：提交时刻放行是正常的；agent 能否写它由写集预约管，worktree 副本改动由托管文件哈希审计报篡改。';
  }
  if (decision === 'allow') {
    if (owners.length === 0) {
      return '策略放行，但没有切片的写集覆盖该路径 —— agent 运行时仍会被写集预约拦下（C9，缺预约 fail closed）。先确认归属切片。';
    }
    return `策略放行。归属切片 ${owners.map((o) => o.sliceId).join('、')} 的写集覆盖该路径。`;
  }
  if (decision === 'ask') {
    return '策略要求人工确认：执行前先让人看一眼（`zelto policy check <path>` 可复核）。';
  }
  // deny
  if (ruleId === 'default') {
    return '无匹配规则（default deny）：若确认该写，应在 policy/policy.yaml 中加一条 allow 规则；否则保持拒绝。';
  }
  if (guidance) return guidance;
  return `被规则 ${ruleId ?? '(未知)'} 拒绝：先看 basis，再决定改策略还是改路径。`;
}

export async function explainWhy(target: string, operation: string, agentContext: boolean): Promise<WhyExplanation> {
  const config = loadPolicyConfig();
  const decision = evaluatePolicy(config, target, operation, 'cli', agentContext);
  const protectedHit = isProtectedPath(target) && operation === 'write';
  const managedSpec = operation === 'write' && isZeltoManagedSpecPath(target);
  const owners = await findOwners(target);
  return {
    target,
    mode: 'path',
    operation,
    decision: decision.decision,
    ruleId: decision.ruleId,
    basis: decision.basis,
    guidance: decision.guidance,
    protected: protectedHit,
    managedSpec,
    owners,
    suggestion: suggestionFor(decision.decision, decision.ruleId, decision.guidance, protectedHit, managedSpec, owners),
  };
}

async function explainSlice(sliceId: string): Promise<{ found: boolean; text: string; json: unknown }> {
  try {
    const s = await store.read(sliceId);
    const reservations = new ReservationStore(locksDir());
    const r = await reservations.read(sliceId);
    const lines = [
      `${colors.bold('zelto why')} ${colors.cyan(sliceId)}（切片模式）`,
      `  状态: ${s.state}  标题: ${s.title}`,
      `  写集: ${(s.writes ?? []).join(', ') || '(empty)'}`,
      `  预约: ${r ? (r.releasedAt ? `已释放（${r.releasedAt}）` : `生效中（pid ${r.pid}）`) : '无预约记录'}`,
      `  规格: ${s.spec?.path ?? '(none)'}  冻结: ${s.spec?.frozenHash ? s.spec.frozenHash.slice(0, 16) + '…' : '(未冻结)'}`,
      `  建议: 用 \`zelto why <path> --operation write\` 看具体路径的判定；用 \`zelto reservation show ${sliceId}\` 看预约原文。`,
    ];
    return {
      found: true,
      text: lines.join('\n'),
      json: {
        mode: 'slice', sliceId, state: s.state, title: s.title,
        writes: s.writes ?? [], reservation: r,
        spec: s.spec ?? null,
      },
    };
  } catch {
    return { found: false, text: '', json: null };
  }
}

function printUsage(): void {
  console.log(`${colors.bold('Usage:')} zelto why <path> [--operation <read|write|execute>] [--as-human] [--json]`);
  console.log(`         zelto why <slice-id> [--json]`);
  console.log('');
  console.log('解释「这个路径能不能写、为什么」：结论 allow/deny/ask、命中的 ruleId + basis、');
  console.log('归属切片与预约写集、修复建议。只读，不写任何状态。');
  console.log('');
  console.log('示例:');
  console.log('  zelto why src/foo.ts                       # 默认 operation=write');
  console.log('  zelto why src/foo.ts --operation read');
  console.log('  zelto why policy/policy.yaml               # 保护域，agent 上下文 deny');
  console.log('  zelto why specs/slices/new.md              # 托管规格文件放行');
  console.log('  zelto why v3-why-command --json             # 切片模式');
}

register('why', async (args) => {
  const isJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const opIdx = args.indexOf('--operation');
  const operation = opIdx >= 0 && args[opIdx + 1] && !args[opIdx + 1].startsWith('--')
    ? args[opIdx + 1]
    : 'write';
  const agentContext = !args.includes('--as-human');

  const target = positional[0];

  // 无参数：按风险预案给引导，不输出堆栈，退出 0。
  if (!target || target === '--help' || target === '-h') {
    if (isJson) {
      writeOutput({ usage: 'zelto why <path> [--operation <op>] [--as-human] [--json]', operationDefault: 'write' }, undefined, { json: true });
      return 0;
    }
    if (!target) {
      console.log('尚无可用操作：请先给一个路径或切片 id，例如 `zelto why src/foo.ts`。');
      console.log('');
    }
    printUsage();
    return 0;
  }

  if (!['read', 'write', 'execute'].includes(operation)) {
    const msg = `未知操作 "${operation}"（应为 read|write|execute）。用法：zelto why <path> [--operation <op>]`;
    if (isJson) {
      writeOutput({ target, operation, error: msg }, undefined, { json: true });
      return 0;
    }
    console.error(msg);
    printUsage();
    return 0;
  }

  // 切片模式：target 是已存在的切片 id（不含路径分隔符时优先试）。
  const looksLikeSliceId = !target.includes('/') && !target.includes('\\') && !target.includes('.') && !target.includes('*');
  if (looksLikeSliceId) {
    const sl = await explainSlice(target);
    if (sl.found) {
      if (isJson) {
        writeOutput(sl.json, undefined, { json: true });
        return 0;
      }
      console.log(sl.text);
      return 0;
    }
    // 不是切片 id：按路径继续走，但多给一句面向运维的提示（风险 R3）。
    const exp = await explainWhy(target, operation, agentContext);
    if (isJson) {
      writeOutput({ ...exp, note: `没有 id 为 "${target}" 的切片，已按路径解释。` }, undefined, { json: true });
      return 0;
    }
    console.log(`（注：没有 id 为 "${target}" 的切片，按路径解释。用法见 zelto why --help）`);
    console.log('');
    printWhyText(exp);
    return 0;
  }

  const exp = await explainWhy(target, operation, agentContext);
  if (isJson) {
    writeOutput(exp, undefined, { json: true });
    return 0;
  }
  printWhyText(exp);
  return 0;
});

function printWhyText(exp: WhyExplanation): void {
  const decisionColor = exp.decision === 'allow' ? colors.green : exp.decision === 'ask' ? colors.yellow : colors.red;
  console.log(`${colors.bold('zelto why')} ${colors.cyan(exp.target)} (${exp.operation}${'、agent 上下文'})`);
  console.log(`  结论: ${decisionColor(exp.decision)}`);
  console.log(`  规则: ${exp.ruleId ?? '(none)'}  ${colors.dim(`basis: ${exp.basis}`)}`);
  if (exp.guidance && exp.guidance !== exp.suggestion) {
    console.log(`  依据: ${exp.guidance}`);
  }
  console.log(`  保护域: ${exp.protected ? '是（agent 不得修改）' : '否'}  托管规格: ${exp.managedSpec ? '是' : '否'}`);
  if (exp.owners.length === 0) {
    console.log('  归属: 无切片写集覆盖该路径（无生效预约命中）');
  } else {
    console.log('  归属:');
    for (const o of exp.owners.slice(0, 5)) {
      console.log(`    · ${o.sliceId}${o.active ? '（生效预约）' : '（切片写集）'}  writes: ${o.writes.join(', ')}`);
    }
    if (exp.owners.length > 5) {
      console.log(`      …还有 ${exp.owners.length - 5} 个`);
    }
  }
  console.log(`  建议: ${exp.suggestion}`);
}

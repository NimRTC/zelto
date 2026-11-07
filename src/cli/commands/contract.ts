// zelto contract —— 契约演进检查
//
// 做什么：把 `contracts/schemas/` 里的契约与**人工确认过的基线**对比，
// 算出这次改动里哪些是破坏性的，并分清破坏的方向：
//
//   写入方破坏（writer）：新契约不再接受旧数据 —— 旧版本写出来的文件读不进来
//   读取方破坏（reader）：新契约产出的数据旧程序读不懂 —— 升级后下游炸了
//
// 三个子命令：
//   zelto contract check     —— 只检查，不改任何东西
//   zelto contract baseline  —— 把当前契约记为新基线（**人的动作**）
//   zelto contract status    —— 看基线状态
//
// 为什么「更新基线」必须是人显式跑的：更新基线 = 人签字接受这次变化。
// 自动化会把破坏也一起签掉，那道闸门就白设了（ADR-036）。
//
// 状态只在文件里（C1）：基线落在 `.zelto/contracts/baseline.json`。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultFormatter } from '../output-formatter.js';
import { register, ZELTO_DIR, events } from './shared.js';
import { ContractRegistry, ContractBaselineStore, diffSchemas, renderChanges } from '../../core/contracts/index.js';
import type { SchemaChange } from '../../core/contracts/index.js';

/** 契约目录（相对当前工作目录） */
const CONTRACTS_DIR = join('contracts', 'schemas');

/** 一份契约的检查结论 */
interface ContractCheck {
  name: string;
  /** 相对基线的变化 */
  changes: SchemaChange[];
  /** 破坏性变化的条数 */
  breaking: number;
}

async function loadCurrentContracts(): Promise<Record<string, Record<string, unknown>>> {
  const dir = join(process.cwd(), CONTRACTS_DIR);
  if (!existsSync(dir)) return {};
  const registry = new ContractRegistry(dir);
  const schemas = await registry.loadAll();
  const out: Record<string, Record<string, unknown>> = {};
  for (const contract of schemas) {
    out[contract.name] = contract.schema;
  }
  return out;
}

/**
 * 检查当前契约相对基线的破坏性变化。
 *
 * 没有基线时返回 null —— 「没有基线」不是「没有破坏」，
 * 两者的报告口径必须分开（否则会把「还没确认过」说成「一切正常」）。
 */
async function checkContracts(): Promise<{
  checks: ContractCheck[];
  hasBaseline: boolean;
  baselineUpdatedAt: string | null;
}> {
  const store = new ContractBaselineStore(ZELTO_DIR);
  const baseline = await store.read();
  const current = await loadCurrentContracts();

  if (!baseline) {
    return { checks: [], hasBaseline: false, baselineUpdatedAt: null };
  }

  const checks: ContractCheck[] = [];
  const names = new Set([...Object.keys(baseline.contracts), ...Object.keys(current)]);

  for (const name of [...names].sort()) {
    const before = baseline.contracts[name];
    const after = current[name];
    const changes = diffSchemas(before ?? null, after ?? {});
    checks.push({
      name,
      changes,
      breaking: changes.filter((c) => c.breaking).length,
    });
  }

  return {
    checks,
    hasBaseline: true,
    baselineUpdatedAt: baseline.updatedAt,
  };
}

register('contract', async (args) => {
  const subcmd = args[0] ?? 'check';
  const f = getDefaultFormatter();
  const asJson = args.includes('--json');

  if (subcmd === 'status') {
    const store = new ContractBaselineStore(ZELTO_DIR);
    const baseline = await store.read();
    const current = await loadCurrentContracts();

    if (asJson) {
      f.data({
        hasBaseline: baseline !== null,
        baselinePath: store.path,
        updatedAt: baseline?.updatedAt ?? null,
        updatedBy: baseline?.updatedBy ?? null,
        baselineContracts: baseline ? Object.keys(baseline.contracts).length : 0,
        currentContracts: Object.keys(current).length,
      });
      return 0;
    }

    if (!baseline) {
      f.out('尚未建立契约基线。');
      f.out(`   基线位置：${store.path}`);
      f.out('   先跑一次：zelto contract baseline');
      return 0;
    }

    f.out(`契约基线：${store.path}`);
    f.out(`   确认时间：${baseline.updatedAt}`);
    f.out(`   确认人：${baseline.updatedBy}`);
    f.out(`   基线契约数：${Object.keys(baseline.contracts).length}`);
    f.out(`   当前契约数：${Object.keys(current).length}`);
    return 0;
  }

  if (subcmd === 'baseline') {
    const store = new ContractBaselineStore(ZELTO_DIR);
    const current = await loadCurrentContracts();
    const names = Object.keys(current);

    if (names.length === 0) {
      f.error('NOT_FOUND', `没找到契约文件：${CONTRACTS_DIR}`);
      return 1;
    }

    const previous = await store.read();
    const updatedBy = 'human';

    await store.write({
      format: 1,
      updatedAt: new Date().toISOString(),
      updatedBy,
      contracts: current,
    });

    await events.append('contracts', 'contract.baseline_updated', 'zelto', {
      contracts: names,
      previousContracts: previous ? Object.keys(previous.contracts) : [],
    });

    if (asJson) {
      f.data({ baselinePath: store.path, contracts: names, updatedAt: new Date().toISOString() });
      return 0;
    }

    f.success(`契约基线已更新：${names.length} 份契约`);
    f.out(`   位置：${store.path}`);
    f.out('   这次更新等于签字接受当前的全部契约变化 —— 确认过再跑。');
    return 0;
  }

  if (subcmd !== 'check') {
    f.error('USAGE', 'Usage: zelto contract [check|baseline|status] [--json]');
    return 1;
  }

  // ── check ────────────────────────────────────────────────────────────
  const { checks, hasBaseline, baselineUpdatedAt } = await checkContracts();

  if (!hasBaseline) {
    if (asJson) {
      f.data({ hasBaseline: false, breaking: 0, checks: [] });
      return 0;
    }
    f.out('尚未建立契约基线 —— 没有可对比的对象，本次不做判断。');
    f.out('   建立基线：zelto contract baseline');
    return 0;
  }

  const breakingTotal = checks.reduce((sum, c) => sum + c.breaking, 0);

  await events.append('contracts', 'contract.evolution_checked', 'zelto', {
    contracts: checks.length,
    breaking: breakingTotal,
    baselineUpdatedAt,
  });

  if (asJson) {
    f.data({
      hasBaseline: true,
      baselineUpdatedAt,
      breaking: breakingTotal,
      checks: checks.map((c) => ({
        name: c.name,
        breaking: c.breaking,
        changes: c.changes,
      })),
    });
    return breakingTotal > 0 ? 1 : 0;
  }

  f.out(`契约演进检查（基线确认于 ${baselineUpdatedAt}）`);
  for (const check of checks) {
    if (check.changes.length === 0) continue;
    const mark = check.breaking > 0 ? '✗' : '·';
    f.out(`\n${mark} ${check.name}`);
    f.out(renderChanges(check.changes));
  }

  if (breakingTotal > 0) {
    f.out('');
    f.error('CONTRACT_BREAK', `检出 ${breakingTotal} 处破坏性契约变化。`);
    f.out('   确认可以接受之后，再更新基线：zelto contract baseline');
    return 1;
  }

  f.out('');
  f.success('没有检出破坏性契约变化。');
  return 0;
});

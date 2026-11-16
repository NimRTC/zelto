/**
 * arch.command.ts — `zelto policy arch` 子命令组（ADR-068）
 *
 * 管 policy.yaml 的 `arch:` 段 —— 架构护栏的判定依据。
 *
 * ```
 * zelto policy arch list [--json]
 * zelto policy arch add <kind> --action <action> --basis <basis> [--guidance <text>]
 * zelto policy arch edit <kind> [--action <action>] [--basis <basis>] [--guidance <text>]
 * zelto policy arch remove <kind> [--json]
 * ```
 *
 * **改完不自动改锚**（ADR-068 §4.3）—— 改锚是人的决定（C5），
 * 但命令输出会**明确告诉人下一步跑什么**。
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { existsSync, readFileSync } from 'node:fs';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';
import {
  addArchGuard,
  editArchGuard,
  listArchGuards,
  removeArchGuard,
} from '../handlers/arch.handler.js';
import type { ArchHandlerResult } from '../handlers/arch.handler.js';
import type { Decision } from '../../../core/policy/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchListOptions {
  json?: boolean;
}

export interface ArchAddOptions {
  kind: string;
  action: Decision;
  basis: string;
  guidance?: string;
  json?: boolean;
}

export interface ArchEditOptions {
  kind: string;
  action?: Decision;
  basis?: string;
  guidance?: string;
  json?: boolean;
}

export interface ArchRemoveOptions {
  kind: string;
  json?: boolean;
}

/** 可配的六类硬偏离（ADR-027）—— 与 core 的校验判据同源 */
export const ARCH_KINDS = [
  'missing_dependency',
  'undeclared_dependency',
  'ambiguous_module',
  'unmapped_file',
  'unknown_module',
  'cycle',
] as const;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `zelto policy arch list` */
export async function listArchGuardsCommand(options: ArchListOptions): Promise<number> {
  const yaml = readPolicyYaml();
  const arch = listArchGuards(yaml);

  if (options.json) {
    writeOutput({ arch }, undefined, { json: true });
    return 0;
  }

  if (arch.length === 0) {
    console.log(`${colors.yellow('No arch guard rules defined.')}`);
    console.log(`  ${colors.dim('arch: 段缺省时，所有硬偏离都按 deny 处置。')}`);
  } else {
    console.log(`${colors.bold('Arch Guard Rules:')}`);
    for (const g of arch) {
      const status =
        g.action === 'allow' ? colors.green('✓') : g.action === 'deny' ? colors.red('✗') : colors.yellow('?');
      console.log(`  ${status} [${colors.cyan(g.kind)}] ${colors.dim(g.action.padEnd(5))} ${colors.dim(g.basis)}`);
      if (g.guidance) {
        console.log(`    ${colors.dim(g.guidance)}`);
      }
    }
  }

  console.log(`\n${colors.dim('Source: policy/policy.yaml')}`);
  return 0;
}

/** `zelto policy arch add` */
export async function addArchGuardCommand(options: ArchAddOptions): Promise<number> {
  const result = addArchGuard({
    kind: options.kind,
    action: options.action,
    basis: options.basis,
    ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
  });

  return reportArchResult(result, options.json, `arch 规则 "${options.kind}" 已添加。`);
}

/** `zelto policy arch edit` */
export async function editArchGuardCommand(options: ArchEditOptions): Promise<number> {
  const result = editArchGuard({
    kind: options.kind,
    ...(options.action !== undefined ? { action: options.action } : {}),
    ...(options.basis !== undefined ? { basis: options.basis } : {}),
    ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
  });

  return reportArchResult(result, options.json, `arch 规则 "${options.kind}" 已更新。`);
}

/** `zelto policy arch remove` */
export async function removeArchGuardCommand(options: ArchRemoveOptions): Promise<number> {
  const result = removeArchGuard(options.kind);
  return reportArchResult(result, options.json, `arch 规则 "${options.kind}" 已删除。`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 统一的输出与「下一步提示」。
 *
 * **关键**（ADR-068 §4.3）：改完策略文件，锚点必然失配。
 * 这里必须明确告诉人**下一步跑什么** ——
 * 这正是第一轮遗留里「人不知道还要跑什么」的修复点。
 */
function reportArchResult(
  result: ArchHandlerResult,
  json: boolean | undefined,
  successMessage: string,
): number {
  if (!result.success) {
    if (json) {
      writeOutput(
        { success: false, errors: result.errors },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} 操作失败：`);
      for (const err of result.errors) {
        console.error(`  ${colors.red('✗')} ${err.message}${err.code ? ` [${colors.yellow(err.code)}]` : ''}`);
      }
    }
    return 1;
  }

  if (json) {
    writeOutput(
      {
        success: true,
        kind: result.kind,
        arch: result.arch,
        anchorNeedsUpdate: result.anchorNeedsUpdate,
      },
      undefined,
      { json: true },
    );
    return 0;
  }

  console.log(`${colors.green('✓')} ${successMessage}`);
  if (result.anchorNeedsUpdate) {
    console.log('');
    console.log(
      `${colors.yellow('⚠')} ${colors.bold('策略锚点已失配')} ${colors.dim('（策略文件变了，锚点没跟上）')}`,
    );
    console.log(`  ${colors.dim('跑 zelto policy validate --update 重锚。')}`);
  }
  return 0;
}

/** 读 policy.yaml 全文 */
function readPolicyYaml(): string {
  if (!existsSync('policy/policy.yaml')) return '';
  return readFileSync('policy/policy.yaml', 'utf-8');
}

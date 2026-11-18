/**
 * arch.handler.ts — `zelto policy arch` 业务逻辑（ADR-068）
 *
 * 管 policy.yaml 的 `arch:` 段 —— 架构护栏的判定依据。
 *
 * **为什么单独一套 handler**（ADR-068 §4.1）：
 *
 * `rules:` 段的标识是**任意的 `id`**（`allow-src-ts`），
 * `arch:` 段的标识是**固定的 `kind`**（六类硬偏离之一）。
 * 两者标识空间完全不同 —— 塞进同一个命令，就得在参数层面猜
 * 「`<rule-id>` 还是 `<kind>`」。分成两个子命令组，
 * 每个命令的参数空间是单一的。
 *
 * **只动 `arch:` 那一段**（ADR-068 D-30）：
 * 用 core 的分段编辑器做**文本级**编辑，
 * 不做全量反序列化 —— 否则会抹掉：
 *   - `anchors:` 段（已废弃但仍认，ADR-040 §3.3）
 *   - 段之间的注释块（人写下的「为什么」）
 *
 * **不改锚**（ADR-068 §4.3）：改锚是人的决定（C5）。
 * 但**必须告诉人下一步是什么** —— 这正是本次要修的体验问题。
 *
 * C3: 纯文件读写 + 纯计算，不调模型、不触网。
 * C6: cli/policy/ 可依赖 core/，不可反向。
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteText } from '../../../core/io/atomic-write.js';
import { validateArchGuardRule } from '../../../core/policy/validator.js';
import {
  appendToSection,
  hasSection,
  listSectionEntries,
  removeSectionEntry,
  replaceSectionEntry,
} from '../../../core/policy/section-editor.js';
import type { ArchGuardRule, Decision } from '../../../core/policy/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchHandlerError {
  message: string;
  code: string;
  path?: string;
}

export interface ArchHandlerResult {
  success: boolean;
  kind?: string;
  errors: ArchHandlerError[];
  /** 改完之后 `arch:` 段的全量内容（便于调用方展示） */
  arch: ArchGuardRule[];
  /**
   * 锚点是否需要重锚
   *
   * 改 `arch:` 段 → 策略文件变了 → 锚点必然失配。
   * **但这里不自动重锚** —— 改锚是人的决定（C5）。
   * 调用方负责告诉人「下一步跑 zelto policy validate --update」。
   */
  anchorNeedsUpdate: boolean;
}

export interface ArchAddOptions {
  kind: string;
  action: Decision;
  basis: string;
  guidance?: string;
}

export interface ArchEditOptions {
  kind: string;
  action?: Decision;
  basis?: string;
  guidance?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * 往 `arch:` 段加一条护栏规则。
 *
 * 校验走 core 的 `validateArchGuardRule`（与 `policy validate` 同一判据）——
 * 不在这里另写一套，否则两处判据会漂。
 */
export async function addArchGuard(options: ArchAddOptions): Promise<ArchHandlerResult> {
  const { kind, action, basis, guidance } = options;

  const errors: ArchHandlerError[] = [];

  const candidate: ArchGuardRule = {
    kind: kind as ArchGuardRule['kind'],
    action,
    basis,
    ...(guidance !== undefined ? { guidance } : {}),
  };

  // 1. 单条规则的合法性（与 validate 同一判据）
  for (const err of validateArchGuardRule(candidate)) {
    errors.push({ message: err.message, code: err.code, path: err.path });
  }
  if (errors.length > 0) {
    return { success: false, kind, errors, arch: [], anchorNeedsUpdate: false };
  }

  // 2. 读现状
  const yaml = readPolicyYaml();
  const current = listArchGuards(yaml);

  // 3. kind 重复 → 拒绝（一类偏离只能有一条护栏规则）
  if (current.some((g) => g.kind === kind)) {
    errors.push({
      message: `Arch guard for kind "${kind}" already exists. Use "zelto policy arch edit ${kind}" to change it.`,
      code: 'E_DUPLICATE',
      path: 'kind',
    });
    return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
  }

  // 4. 追加到 `arch:` 段（只动那一段）
  const updated = appendToSection(yaml, 'arch', buildArchBlock(candidate));
  // ADR-082：写失败或内容没变 → 不能报告成功。
  try {
    const changed = await writePolicyYaml(updated);
    if (!changed) {
      errors.push({
        message: `Arch guard for kind "${kind}" already has identical content — nothing was changed.`,
        code: 'E_NO_CHANGE',
        path: 'kind',
      });
      return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({
      message: `Write failed: ${message}`,
      code: 'E_WRITE_FAILED',
      path: 'policy.yaml',
    });
    return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
  }

  return {
    success: true,
    kind,
    errors: [],
    arch: [...current, candidate],
    anchorNeedsUpdate: true,
  };
}

/**
 * 改一条护栏规则。只改显式传入的字段。
 */
export async function editArchGuard(options: ArchEditOptions): Promise<ArchHandlerResult> {
  const { kind, action, basis, guidance } = options;
  const errors: ArchHandlerError[] = [];

  const yaml = readPolicyYaml();
  const current = listArchGuards(yaml);

  const existing = current.find((g) => g.kind === kind);
  if (!existing) {
    errors.push({
      message: `Arch guard for kind "${kind}" not found in policy`,
      code: 'E_NOT_FOUND',
      path: 'kind',
    });
    return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
  }

  // 只改显式传入的字段 —— 其余保持原样
  const updatedRule: ArchGuardRule = {
    ...existing,
    ...(action !== undefined ? { action } : {}),
    ...(basis !== undefined ? { basis } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
  };

  // 校验改完之后的那一条
  for (const err of validateArchGuardRule(updatedRule)) {
    errors.push({ message: err.message, code: err.code, path: err.path });
  }
  if (errors.length > 0) {
    return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
  }

  // 文本级替换那一条 —— 位置不变，其它内容不动
  //
  // 段缺失 → 不能报告成功（D-31）。
  // `replaceSectionEntry` 找不到条目时原样返回 —— 文件没变，
  // 但命令会报「✓ 已更新」。必须在这里挡住。
  if (!hasSection(yaml, 'arch')) {
    errors.push({
      message:
        `Cannot locate the "arch:" section in policy/policy.yaml — ` +
        `the file may be malformed or start with a byte-order mark. Nothing was changed.`,
      code: 'E_SECTION_NOT_FOUND',
      path: 'arch',
    });
    return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
  }

  const updatedYaml = replaceSectionEntry(
    yaml,
    'arch',
    'kind',
    kind,
    buildArchBlock(updatedRule),
  );
  // ADR-082：写失败或内容没变 → 不能报告成功。
  try {
    const changed = await writePolicyYaml(updatedYaml);
    if (!changed) {
      errors.push({
        message: `Arch guard for kind "${kind}" was not changed — the requested values already match.`,
        code: 'E_NO_CHANGE',
        path: 'kind',
      });
      return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({
      message: `Write failed: ${message}`,
      code: 'E_WRITE_FAILED',
      path: 'policy.yaml',
    });
    return { success: false, kind, errors, arch: current, anchorNeedsUpdate: false };
  }

  return {
    success: true,
    kind,
    errors: [],
    arch: current.map((g) => (g.kind === kind ? updatedRule : g)),
    anchorNeedsUpdate: true,
  };
}

/**
 * 删掉一条护栏规则。
 */
export async function removeArchGuard(kind: string): Promise<ArchHandlerResult> {
  const yaml = readPolicyYaml();
  const current = listArchGuards(yaml);

  if (!current.some((g) => g.kind === kind)) {
    return {
      success: false,
      kind,
      errors: [
        {
          message: `Arch guard for kind "${kind}" not found in policy`,
          code: 'E_NOT_FOUND',
          path: 'kind',
        },
      ],
      arch: current,
      anchorNeedsUpdate: false,
    };
  }

  const updatedYaml = removeSectionEntry(yaml, 'arch', 'kind', kind);

  // 段缺失 → 不能报告成功（D-31）
  if (!hasSection(yaml, 'arch')) {
    return {
      success: false,
      kind,
      errors: [
        {
          message:
            `Cannot locate the "arch:" section in policy/policy.yaml — ` +
            `the file may be malformed or start with a byte-order mark. Nothing was changed.`,
          code: 'E_SECTION_NOT_FOUND',
          path: 'arch',
        },
      ],
      arch: current,
      anchorNeedsUpdate: false,
    };
  }

  // ADR-082：写失败或内容没变 → 不能报告成功。
  try {
    const changed = await writePolicyYaml(updatedYaml);
    if (!changed) {
      return {
        success: false,
        kind,
        errors: [
          {
            message: `Arch guard for kind "${kind}" was not changed — nothing was written.`,
            code: 'E_NO_CHANGE',
            path: 'kind',
          },
        ],
        arch: current,
        anchorNeedsUpdate: false,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      kind,
      errors: [
        {
          message: `Write failed: ${message}`,
          code: 'E_WRITE_FAILED',
          path: 'policy.yaml',
        },
      ],
      arch: current,
      anchorNeedsUpdate: false,
    };
  }

  return {
    success: true,
    kind,
    errors: [],
    arch: current.filter((g) => g.kind !== kind),
    anchorNeedsUpdate: true,
  };
}

/**
 * 列出 `arch:` 段里的所有护栏规则。
 */
export function listArchGuards(yaml: string): ArchGuardRule[] {
  const entries = listSectionEntries(yaml, 'arch', 'kind');
  const lines = yaml.split('\n');
  const result: ArchGuardRule[] = [];

  for (const entry of entries) {
    const block = lines.slice(entry.start, entry.end);
    result.push({
      kind: entry.id as ArchGuardRule['kind'],
      action: readField(block, 'action') as Decision,
      basis: readField(block, 'basis') ?? '',
      ...(readField(block, 'guidance') !== undefined
        ? { guidance: readField(block, 'guidance') }
        : {}),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** policy.yaml 的路径 */
const POLICY_PATH = 'policy/policy.yaml';

/**
 * 读 policy.yaml 全文。
 *
 * 文件不在时返回空串 —— 调用方要么新建段，要么报错，
 * 不该在这里抛「文件不存在」的异常。
 */
function readPolicyYaml(): string {
  if (!existsSync(POLICY_PATH)) return '';
  return readFileSync(POLICY_PATH, 'utf-8');
}

/**
 * 写 policy.yaml 全文（ADR-082：原子写入 + 写完读回验证；失败必抛）。
 *
 * 返回 `changed` —— 「内容没变」是失败，调用方据此不能报告成功。
 */
async function writePolicyYaml(content: string): Promise<boolean> {
  const receipt = await atomicWriteText(POLICY_PATH, content);
  return receipt.changed;
}

/**
 * 生成一条护栏规则的 YAML 块。
 *
 * 格式与 `serializeRulesToYaml` 产出的 `arch:` 段一致：
 *
 * ```yaml
 *   - kind: cycle
 *     action: ask
 *     basis: "ADR-025"
 *     guidance: "..."
 * ```
 */
export function buildArchBlock(rule: ArchGuardRule): string[] {
  const lines: string[] = [];
  lines.push(`  - kind: ${rule.kind}`);
  lines.push(`    action: ${rule.action}`);
  lines.push(`    basis: "${escapeYamlString(rule.basis)}"`);
  if (rule.guidance !== undefined && rule.guidance !== null) {
    lines.push(`    guidance: "${escapeYamlString(rule.guidance)}"`);
  }
  return lines;
}

/** 从一个 YAML 块里读某个字段的值（去掉引号） */
function readField(block: string[], field: string): string | undefined {
  const prefix = `${field}:`;
  for (const line of block) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/** 转义 YAML 双引号字符串里的引号与反斜杠 */
function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

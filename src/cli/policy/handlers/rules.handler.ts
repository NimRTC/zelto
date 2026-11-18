/**
 * rules.handler.ts — `zelto policy add` / `edit` / `remove` 的业务逻辑
 *
 * **文本级编辑，不做全量反序列化**（ADR-068 D-30）。
 *
 * 为什么：`policy.yaml` 不只有 `rules:` 一段。真实项目（nimrtc-zelto）：
 *
 * ```yaml
 * rules:
 *   - id: ...
 *
 * # ── 架构护栏注释 ──
 * # 这条例外是 ADR-025 承认的
 * arch:
 *   - kind: cycle
 *     action: ask
 *
 * anchors:
 *   policy: "sha256:init"
 * ```
 *
 * 全量反序列化会把 `arch:` 段、`anchors:` 段、以及段之间的注释块全弄丢。
 * 注释里写着的是**人的设计决策**（「为什么这条环可以例外」），
 * 工具没有资格替人删掉。
 *
 * 所以：只动 `rules:` 那一段，其余部分**逐字节保留**。
 *
 * C3: 纯文件读写 + 纯计算，不调模型、不触网。
 * C6: cli/policy/ 可依赖 core/，不可反向。
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteText } from '../../../core/io/atomic-write.js';
import { validateRule } from '../../../core/policy/validator.js';
import {
  appendToSection,
  hasSection,
  removeSectionEntry,
  updateSectionEntryFields,
} from '../../../core/policy/section-editor.js';
import { parsePolicyYaml } from '../../../core/policy/yaml.js';
import type { PolicyRule } from '../../../core/policy/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddPolicyRuleOptions {
  id: string;
  path?: string;
  operation?: string;
  action: string;
  basis: string;
  guidance?: string;
  priority?: number;
  description?: string;
}

export interface AddRuleError {
  message: string;
  code: string;
  path?: string;
}

export interface AddHandlerResult {
  success: boolean;
  ruleId: string;
  errors: AddRuleError[];
  totalRulesAfter: number;
}

export interface RemoveOptions {
  ruleId: string;
}

export interface RemoveHandlerResult {
  success: boolean;
  ruleId: string;
  message: string;
  totalRulesAfter: number;
}

export interface EditOptions {
  ruleId: string;
  path?: string;
  operation?: string;
  action?: string;
  basis?: string;
  guidance?: string;
  description?: string;
  priority?: number;
}

export interface EditHandlerResult {
  success: boolean;
  ruleId: string;
  message: string;
  changes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * 加一条规则到 `rules:` 段。
 *
 * 校验走 core 的 `validateRule`（与 `policy validate` 同一判据）——
 * 不在这里另写一套，否则两处判据会漂。
 */
export async function addPolicyRule(options: AddPolicyRuleOptions): Promise<AddHandlerResult> {
  const errors: AddRuleError[] = [];

  // 1. 单条规则的合法性
  const ruleToValidate: Record<string, unknown> = {
    id: options.id,
    match: {
      ...(options.path ? { path: options.path } : {}),
      ...(options.operation ? { operation: options.operation } : {}),
    },
    action: options.action,
    basis: options.basis,
  };
  if (options.guidance !== undefined) ruleToValidate.guidance = options.guidance;
  if (options.priority !== undefined) ruleToValidate.priority = options.priority;
  if (options.description !== undefined) ruleToValidate.description = options.description;

  for (const err of validateRule(ruleToValidate)) {
    errors.push({ message: err.message, code: err.code, path: err.path });
  }
  if (errors.length > 0) {
    return { success: false, ruleId: options.id, errors, totalRulesAfter: 0 };
  }

  // 2. 读现状
  const yaml = readPolicyYaml();
  const current = parsePolicyYaml(yaml).rules;

  // 3. id 重复 → 拒绝
  if (current.some((r) => r.id === options.id)) {
    errors.push({
      message: `A rule with ID "${options.id}" already exists`,
      code: 'DUPLICATE_ID',
      path: 'id',
    });
    return { success: false, ruleId: options.id, errors, totalRulesAfter: current.length };
  }

  // 4. 追加到 `rules:` 段（**只动那一段** —— 其余逐字节保留）
  const updated = appendToSection(yaml, 'rules', buildRuleBlock(options));
  // ADR-082：写失败或内容没变 → 不能报告成功。
  try {
    const changed = await writePolicyYaml(updated);
    if (!changed) {
      return {
        success: false,
        ruleId: options.id,
        errors: [
          {
            message: `Rule "${options.id}" already exists with identical content — nothing was changed.`,
            code: 'NO_CHANGE',
            path: 'id',
          },
        ],
        totalRulesAfter: current.length,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      ruleId: options.id,
      errors: [{ message: `Write failed: ${message}`, code: 'WRITE_FAILED', path: 'policy.yaml' }],
      totalRulesAfter: current.length,
    };
  }

  return {
    success: true,
    ruleId: options.id,
    errors: [],
    totalRulesAfter: current.length + 1,
  };
}

/**
 * 按 ID 删掉一条规则。
 *
 * **只删那一块** —— `arch:` 段、`anchors:` 段、注释一律保留。
 */
export async function removePolicyRule(options: RemoveOptions): Promise<RemoveHandlerResult> {
  const { ruleId } = options;

  const yaml = readPolicyYaml();
  const current = parsePolicyYaml(yaml).rules;

  if (!current.some((r) => r.id === ruleId)) {
    return {
      success: false,
      ruleId,
      message: `Rule "${ruleId}" not found in policy`,
      totalRulesAfter: current.length,
    };
  }

  // 段缺失 → 不能报告成功（D-31）。
  //
  // 解析器认得这条规则（`parsePolicyYaml` 用 trim，BOM 安全），
  // 但分段编辑器可能找不到段（两种判据不一致）。
  // 这时 `removeSectionEntry` 会原样返回 —— 文件没变。
  // 必须在这里挡住，**不能让命令报「✓ removed」而文件没动**。
  if (!hasSection(yaml, 'rules')) {
    return {
      success: false,
      ruleId,
      message:
        `Cannot locate the "rules:" section in policy/policy.yaml — ` +
        `the file may be malformed or start with a byte-order mark. Nothing was changed.`,
      totalRulesAfter: current.length,
    };
  }

  const updated = removeSectionEntry(yaml, 'rules', 'id', ruleId);
  // ADR-082：写失败或内容没变 → 不能报告成功。
  try {
    const changed = await writePolicyYaml(updated);
    if (!changed) {
      return {
        success: false,
        ruleId,
        message: `Rule "${ruleId}" was not changed — nothing was written.`,
        totalRulesAfter: current.length,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      ruleId,
      message: `Write failed: ${message}`,
      totalRulesAfter: current.length,
    };
  }

  return {
    success: true,
    ruleId,
    message: `Rule "${ruleId}" has been removed`,
    totalRulesAfter: current.length - 1,
  };
}

/**
 * 改一条规则的字段。只改显式传入的字段。
 */
export async function editPolicyRule(options: EditOptions): Promise<EditHandlerResult> {
  const { ruleId, path, operation, action, basis, guidance, description, priority } = options;

  const yaml = readPolicyYaml();
  const current = parsePolicyYaml(yaml).rules;

  const existing = current.find((r) => r.id === ruleId);
  if (!existing) {
    return {
      success: false,
      ruleId,
      message: `Rule "${ruleId}" not found in policy`,
      changes: {},
    };
  }

  // 1. 算出改动
  const changes: Record<string, unknown> = {};
  const updatedRule: PolicyRule = {
    ...existing,
    match: { ...existing.match },
  };
  if (path !== undefined) {
    updatedRule.match.path = path;
    changes.path = path;
  }
  if (operation !== undefined) {
    updatedRule.match.operation = operation;
    changes.operation = operation;
  }
  if (action !== undefined) {
    updatedRule.action = action as PolicyRule['action'];
    changes.action = action;
  }
  if (basis !== undefined) {
    updatedRule.basis = basis;
    changes.basis = basis;
  }
  if (guidance !== undefined) {
    updatedRule.guidance = guidance;
    changes.guidance = guidance;
  }
  if (description !== undefined) {
    updatedRule.description = description;
    changes.description = description;
  }
  if (priority !== undefined) {
    updatedRule.priority = priority;
    changes.priority = priority;
  }

  if (Object.keys(changes).length === 0) {
    return {
      success: false,
      ruleId,
      message:
        'No changes specified. Use --path, --operation, --action, --basis, --guidance, --description, or --priority.',
      changes: {},
    };
  }

  // 2. 校验改完之后的那一条
  const errors: AddRuleError[] = [];
  for (const err of validateRule(updatedRule)) {
    errors.push({ message: err.message, code: err.code, path: err.path });
  }
  if (errors.length > 0) {
    return {
      success: false,
      ruleId,
      message: `Invalid rule definition: ${errors.map((e) => e.message).join('; ')}`,
      changes: {},
    };
  }

  // 3. **字段级**文本替换 —— 只改指定字段，条目里的其它字段原样保留。
  //
  // 为什么不整条重建（ADR-068 D-30 的延伸）：
  // `parsePolicyYaml` 只认 `id` / `match` / `action` / `basis` / `guidance` /
  // `priority`。真实项目的 policy.yaml 里还有 `reason:` 这种字段 ——
  // 整条重建会把它悄悄丢掉。**工具没有资格替人删掉它不认识的字段。**
  const fields: Record<string, string | null> = {};
  const matchFields: Record<string, string | null> = {};
  if (action !== undefined) fields.action = action;
  if (basis !== undefined) fields.basis = basis;
  if (guidance !== undefined) fields.guidance = guidance;
  if (description !== undefined) fields.description = description;
  if (priority !== undefined) fields.priority = String(priority);
  if (path !== undefined) matchFields.path = path;
  if (operation !== undefined) matchFields.operation = operation;

  // 段缺失 → 不能报告成功（D-31）。
  //
  // 解析器认得这条规则（`parsePolicyYaml` 用 trim，BOM 安全），
  // 但分段编辑器可能找不到段（两种判据不一致）。
  // 这时 `updateSectionEntryFields` 会原样返回 —— 文件没变。
  // 必须在这里挡住，**不能让命令报「✓ updated」而文件没动**。
  if (!hasSection(yaml, 'rules')) {
    return {
      success: false,
      ruleId,
      message:
        `Cannot locate the "rules:" section in policy/policy.yaml — ` +
        `the file may be malformed or start with a byte-order mark. Nothing was changed.`,
      changes: {},
    };
  }

  const updated = updateSectionEntryFields(
    yaml,
    'rules',
    'id',
    ruleId,
    fields,
    matchFields,
  );
  // ADR-082：写失败或内容没变 → 不能报告成功。
  try {
    const changed = await writePolicyYaml(updated);
    if (!changed) {
      return {
        success: false,
        ruleId,
        message: `Rule "${ruleId}" was not changed — the requested values already match. Nothing was written.`,
        changes: {},
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      ruleId,
      message: `Write failed: ${message}`,
      changes: {},
    };
  }

  return {
    success: true,
    ruleId,
    message: `Rule "${ruleId}" updated`,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** policy.yaml 的路径 */
const POLICY_PATH = 'policy/policy.yaml';

/** 读 policy.yaml 全文（文件不在时返回空串） */
function readPolicyYaml(): string {
  if (!existsSync(POLICY_PATH)) return '';
  return readFileSync(POLICY_PATH, 'utf-8');
}

/**
 * 写 policy.yaml 全文（ADR-082：原子写入 + 写完读回验证；失败必抛）。
 *
 * 「内容没变」也算失败 —— 调用方据此**不能**报告成功。
 */
async function writePolicyYaml(content: string): Promise<boolean> {
  const receipt = await atomicWriteText(POLICY_PATH, content);
  return receipt.changed;
}

/**
 * 生成一条规则的 YAML 块。
 *
 * ```yaml
 *   - id: my-rule
 *     match: { path: "src/**", operation: "write" }
 *     action: allow
 *     basis: "policy.yaml#my-rule"
 * ```
 */
export function buildRuleBlock(rule: AddPolicyRuleOptions): string[] {
  const matchParts: string[] = [];
  if (rule.path !== undefined) matchParts.push(`path: "${escapeYamlString(rule.path)}"`);
  if (rule.operation !== undefined) matchParts.push(`operation: "${escapeYamlString(rule.operation)}"`);
  if (matchParts.length === 0) matchParts.push('path: "**"');

  const lines: string[] = [];
  lines.push(`  - id: ${rule.id}`);
  lines.push(`    match: { ${matchParts.join(', ')} }`);
  lines.push(`    action: ${rule.action}`);
  lines.push(`    basis: "${escapeYamlString(rule.basis)}"`);
  if (rule.guidance !== undefined) {
    lines.push(`    guidance: "${escapeYamlString(rule.guidance)}"`);
  }
  if (rule.priority !== undefined) {
    lines.push(`    priority: ${rule.priority}`);
  }
  if (rule.description !== undefined) {
    lines.push(`    description: "${escapeYamlString(rule.description)}"`);
  }
  return lines;
}

/**
 * 从一条已存在的规则生成 YAML 块（保留给未来的整条重建场景）。
 */
function buildRuleBlockFromRule(rule: PolicyRule): string[] {
  return buildRuleBlock({
    id: rule.id,
    ...(rule.match.path !== undefined ? { path: rule.match.path } : {}),
    ...(rule.match.operation !== undefined ? { operation: rule.match.operation } : {}),
    action: rule.action,
    basis: rule.basis,
    ...(rule.guidance !== undefined ? { guidance: rule.guidance } : {}),
    ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
    ...(rule.description !== undefined ? { description: rule.description } : {}),
  });
}

/** 转义 YAML 双引号字符串里的引号与反斜杠 */
function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

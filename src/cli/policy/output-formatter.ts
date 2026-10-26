/**
 * output-formatter.ts — 统一 JSON 与文本格式化输出
 *
 * 为 CLI 命令提供一致的输出格式：JSON 和文本两种模式。
 * C6: cli/policy/ 可依赖 core/，但 core/ 不得依赖 cli/policy/。
 */

import type { PolicyRule } from "../../core/policy/types.js";

// ---------------------------------------------------------------------------
// 输出模式
// ---------------------------------------------------------------------------

export type OutputFormat = "text" | "json";

// ---------------------------------------------------------------------------
// CLI 层类型（非 core 层概念，此处定义）
// ---------------------------------------------------------------------------

export interface ValidationError {
  message: string;
  code?: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface PolicyRecord {
  id: string;
  ruleId: string;
  action: string;
  timestamp?: string;
  reason?: string;
  changes?: string[];
}

export interface CheckResultEntry {
  rule: PolicyRule;
  matched: boolean;
  details?: string;
}

export interface CheckSummary {
  total: number;
  matched: number;
  blocked: number;
}

// ---------------------------------------------------------------------------
// 格式化选项
// ---------------------------------------------------------------------------

export interface FormatOptions {
  format: OutputFormat;
  pretty?: boolean;
}

// ---------------------------------------------------------------------------
// JSON 输出
// ---------------------------------------------------------------------------

function formatJson(data: unknown, pretty = false): string {
  return JSON.stringify(data, null, pretty ? 2 : undefined);
}

// ---------------------------------------------------------------------------
// 文本输出
// ---------------------------------------------------------------------------

function formatRulesText(rules: PolicyRule[]): string {
  if (rules.length === 0) {
    return "No policy rules defined.";
  }

  const lines: string[] = [];
  for (const rule of rules) {
    lines.push(formatRuleOneLine(rule));
  }
  return lines.join("\n");
}

function formatRuleOneLine(rule: PolicyRule): string {
  const action = rule.action;
  const desc = rule.description || "(no description)";
  const matchPath = rule.match?.path ?? "*";
  return `  [${rule.id}] ${action} — ${desc} (${matchPath})`;
}

function formatRuleDetail(rule: PolicyRule): string {
  const lines: string[] = [];
  lines.push(`Rule: ${rule.id}`);
  lines.push(`  Description: ${rule.description || "(none)"}`);
  lines.push(`  Action:      ${rule.action}`);
  lines.push(`  Match Path:  ${rule.match?.path ?? "(none)"}`);
  lines.push(`  Operation:   ${rule.match?.operation ?? "(any)"}`);
  lines.push(`  Harness:     ${rule.match?.harness ?? "(any)"}`);
  lines.push(`  Basis:       ${rule.basis}`);
  if (rule.guidance) {
    lines.push(`  Guidance:    ${rule.guidance}`);
  }
  if (rule.priority !== undefined) {
    lines.push(`  Priority:    ${rule.priority}`);
  }
  return lines.join("\n");
}

function formatValidationText(result: ValidationResult): string {
  if (result.valid) {
    return "Validation: PASSED";
  }

  const lines: string[] = ["Validation: FAILED"];
  for (const err of result.errors) {
    lines.push(formatErrorOneLine(err));
  }
  return lines.join("\n");
}

function formatErrorOneLine(error: ValidationError): string {
  const code = error.code ? ` [${error.code}]` : "";
  const path = error.path ? `${error.path}: ` : "";
  return `  ✗ ${path}${error.message}${code}`;
}

function formatRecordsText(records: PolicyRecord[]): string {
  if (records.length === 0) {
    return "No audit records found.";
  }

  const lines: string[] = [];
  for (const rec of records) {
    lines.push(formatRecordOneLine(rec));
  }
  return lines.join("\n");
}

function formatRecordOneLine(record: PolicyRecord): string {
  const action = record.action ?? "unknown";
  const ts = record.timestamp ? new Date(record.timestamp).toISOString() : "-";
  const reason = record.reason ? ` — ${record.reason}` : "";
  return `  [${ts}] ${record.ruleId}: ${action}${reason}`;
}

function formatRecordDetail(record: PolicyRecord): string {
  const lines: string[] = [];
  lines.push(`Record: ${record.id}`);
  lines.push(`  Rule:       ${record.ruleId}`);
  lines.push(`  Action:     ${record.action ?? "unknown"}`);
  lines.push(`  Timestamp:  ${record.timestamp ? new Date(record.timestamp).toISOString() : "-"}`);
  if (record.reason) {
    lines.push(`  Reason:     ${record.reason}`);
  }
  if (record.changes && record.changes.length > 0) {
    lines.push(`  Changes:    ${record.changes.join(", ")}`);
  }
  return lines.join("\n");
}

function formatCheckResultsText(
  entries: CheckResultEntry[],
  summary: CheckSummary,
): string {
  const lines: string[] = [];

  if (entries.length === 0) {
    lines.push("No matching rules found.");
    return lines.join("\n");
  }

  for (const entry of entries) {
    const icon = entry.matched
      ? entry.rule.action === "deny"
        ? "✗"
        : "✓"
      : "○";
    const actionLabel = entry.rule.action;
    lines.push(
      `  ${icon} [${entry.rule.id}] ${actionLabel} ${entry.matched ? "MATCHED" : "not matched"}`,
    );
    if (entry.details) {
      lines.push(`       ${entry.details}`);
    }
  }

  lines.push("");
  lines.push(
    `  Summary: ${summary.total} rules, ${summary.matched} matched, ${summary.blocked} blocked`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export interface OutputFormatter {
  format: OutputFormat;

  /** 格式化规则列表（简要） */
  rules(rules: PolicyRule[]): string;

  /** 格式化单条规则详情 */
  ruleDetail(rule: PolicyRule): string;

  /** 格式化校验结果 */
  validation(result: ValidationResult): string;

  /** 格式化记录列表（简要） */
  records(records: PolicyRecord[]): string;

  /** 格式化单条记录详情 */
  recordDetail(record: PolicyRecord): string;

  /** 格式化策略检查结果 */
  checkResults(entries: CheckResultEntry[], summary: CheckSummary): string;
}

export function createOutputFormatter(options: FormatOptions): OutputFormatter {
  const isJson = options.format === "json";
  const pretty = options.pretty ?? true;

  function output<T>(textFn: () => string, data: T): string {
    if (isJson) {
      return formatJson(data, pretty);
    }
    return textFn();
  }

  return {
    format: options.format,

    rules(rules: PolicyRule[]): string {
      return output(() => formatRulesText(rules), rules);
    },

    ruleDetail(rule: PolicyRule): string {
      return output(() => formatRuleDetail(rule), rule);
    },

    validation(result: ValidationResult): string {
      return output(() => formatValidationText(result), result);
    },

    records(records: PolicyRecord[]): string {
      return output(() => formatRecordsText(records), records);
    },

    recordDetail(record: PolicyRecord): string {
      return output(() => formatRecordDetail(record), record);
    },

    checkResults(
      entries: CheckResultEntry[],
      summary: CheckSummary,
    ): string {
      return output(
        () => formatCheckResultsText(entries, summary),
        { entries, summary },
      );
    },
  };
}

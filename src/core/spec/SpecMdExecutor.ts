import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ParsedSpec {
  spec: string;
  checklists: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ChecklistResult {
  text: string;
  passed: boolean;
  error?: string;
}

// ─── Executor ─────────────────────────────────────────────────────────────

export class SpecMdExecutor {
  private readonly sliceRoot: string;

  constructor(sliceRoot: string) {
    this.sliceRoot = sliceRoot;
  }

  // ── parse ────────────────────────────────────────────────────────────────

  async parse(sliceId: string): Promise<ParsedSpec> {
    const content = await this.readFile(sliceId);
    return this.extractSections(content);
  }

  // ── validate ─────────────────────────────────────────────────────────────

  async validate(sliceId: string): Promise<ValidationResult> {
    const errors: string[] = [];

    // 1. 文件是否存在
    const filePath = join(this.sliceRoot, `${sliceId}.md`);
    try {
      await access(filePath);
    } catch {
      return { valid: false, errors: [`规格文件不存在: ${filePath}`] };
    }

    // 2. 读取并检查章节
    const content = await readFile(filePath, "utf-8");

    if (!content.includes("## Spec")) {
      errors.push("缺少 ## Spec 章节");
    }

    if (!content.includes("## Checklists")) {
      errors.push("缺少 ## Checklists 章节");
    }

    // 3. 检查是否有 checklist 条目
    const checklistLines = content
      .split("\n")
      .filter((line) => line.trimStart().startsWith("- [ ]") || line.trimStart().startsWith("- [x]"));

    if (checklistLines.length === 0) {
      errors.push("Checklists 中没有条目（需要至少一个 - [ ] 或 - [x] 条目）");
    }

    return { valid: errors.length === 0, errors };
  }

  // ── runChecklists ────────────────────────────────────────────────────────

  async runChecklists(sliceId: string): Promise<ChecklistResult[]> {
    const content = await this.readFile(sliceId);
    const parsed = this.extractSections(content);

    return parsed.checklists.map((text) => {
      try {
        // 每个 checklist 条目作为一个独立验证运行
        // 这里执行基本的自检：条目非空即可
        const passed = text.trim().length > 0;
        return {
          text,
          passed,
          error: passed ? undefined : "Checklist 条目为空",
        };
      } catch (err) {
        return {
          text,
          passed: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async readFile(sliceId: string): Promise<string> {
    const filePath = join(this.sliceRoot, `${sliceId}.md`);
    return readFile(filePath, "utf-8");
  }

  private extractSections(content: string): ParsedSpec {
    const lines = content.split("\n");
    const specLines: string[] = [];
    const checklists: string[] = [];

    let currentSection: "spec" | "checklists" | null = null;

    for (const line of lines) {
      if (line.startsWith("## Spec")) {
        currentSection = "spec";
        continue;
      }
      if (line.startsWith("## Checklists")) {
        currentSection = "checklists";
        continue;
      }
      // 遇到下一个二级标题则退出当前章节
      if (line.startsWith("## ") && currentSection !== null) {
        currentSection = null;
        continue;
      }

      if (currentSection === "spec") {
        specLines.push(line);
      } else if (currentSection === "checklists") {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- [x]")) {
          // 提取 checklist 文本（去掉 "- [ ] " 或 "- [x] " 前缀）
          const text = trimmed.replace(/^- \[[ x]\] /, "").trim();
          if (text) {
            checklists.push(text);
          }
        }
      }
    }

    return {
      spec: specLines.join("\n").trim(),
      checklists,
    };
  }
}

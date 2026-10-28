import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

describe("spec-md CLI (integration)", () => {
  const cli = 'npx tsx src/cli/index.ts';

  it("spec-md validate should pass for v1-spec-md-executor", () => {
    const out = execSync(`${cli} spec-md validate v1-spec-md-executor`, {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    assert.ok(out.includes("passed"));
  });

  it("spec-md run should execute v1-spec-md-executor checklists", () => {
    const out = execSync(`${cli} spec-md run v1-spec-md-executor`, {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    assert.ok(out.includes("all checklists passed"));
  });

  it("spec-md validate should report non-existent slice", () => {
    try {
      execSync(`${cli} spec-md validate v1-nonexistent`, {
        encoding: "utf-8",
        cwd: process.cwd(),
      });
      assert.fail("should throw");
    } catch (e: unknown) {
      const err = e as { stderr?: string; stdout?: string };
      const output = (err.stderr || err.stdout || "").toLowerCase();
      assert.ok(output.includes("fail") || output.includes("不存在"));
    }
  });

  it("gate --spec-md should validate all spec files", () => {
    const out = execSync(`${cli} gate --spec-md`, {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    assert.ok(out.includes("spec-md"));
  });
});

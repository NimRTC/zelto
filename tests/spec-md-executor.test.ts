import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SpecMdExecutor } from "../src/core/spec/SpecMdExecutor.js";

describe("SpecMdExecutor", () => {
  let tmpDir: string;
  let executor: SpecMdExecutor;

  const validSlice = `# v1-test-slice — Test Slice

## Spec

GIVEN a test slice
WHEN it is validated
THEN it should pass

## Checklists

- [ ] First checklist item
- [ ] Second checklist item
- [ ] Third checklist item

## Notes

Some extra notes that should not be parsed.
`;

  const missingSpecSlice = `# v1-no-spec — No Spec

## Checklists

- [ ] Only checklist
`;

  const missingChecklistsSlice = `# v1-no-checklist — No Checklists

## Spec

Some spec content
`;

  const emptyChecklistsSlice = `# v1-empty-checklist — Empty Checklists

## Spec

Some spec content

## Checklists

## Notes

Some notes
`;

  before(async () => {
    tmpDir = join(tmpdir(), `spec-md-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    await writeFile(join(tmpDir, "v1-test-slice.md"), validSlice);
    await writeFile(join(tmpDir, "v1-no-spec.md"), missingSpecSlice);
    await writeFile(join(tmpDir, "v1-no-checklist.md"), missingChecklistsSlice);
    await writeFile(join(tmpDir, "v1-empty-checklist.md"), emptyChecklistsSlice);

    executor = new SpecMdExecutor(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── parse ──────────────────────────────────────────────────────────────

  describe("parse()", () => {
    it("应正确解析 Spec 章节内容", async () => {
      const result = await executor.parse("v1-test-slice");
      assert.ok(result.spec.includes("GIVEN a test slice"));
      assert.ok(result.spec.includes("WHEN it is validated"));
      assert.ok(result.spec.includes("THEN it should pass"));
    });

    it("应正确解析 Checklists 条目", async () => {
      const result = await executor.parse("v1-test-slice");
      assert.equal(result.checklists.length, 3);
      assert.equal(result.checklists[0], "First checklist item");
      assert.equal(result.checklists[1], "Second checklist item");
      assert.equal(result.checklists[2], "Third checklist item");
    });

    it("不应包含 Notes 章节内容", async () => {
      const result = await executor.parse("v1-test-slice");
      assert.ok(!result.spec.includes("Some extra notes"));
    });
  });

  // ── validate ───────────────────────────────────────────────────────────

  describe("validate()", () => {
    it("应通过格式正确的规格文件", async () => {
      const result = await executor.validate("v1-test-slice");
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it("应检测缺失的 ## Spec 章节", async () => {
      const result = await executor.validate("v1-no-spec");
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("## Spec")));
    });

    it("应检测缺失的 ## Checklists 章节", async () => {
      const result = await executor.validate("v1-no-checklist");
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("## Checklists")));
    });

    it("应检测空的 Checklists", async () => {
      const result = await executor.validate("v1-empty-checklist");
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("条目")));
    });

    it("应检测不存在的文件", async () => {
      const result = await executor.validate("v1-nonexistent");
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("不存在")));
    });
  });

  // ── runChecklists ──────────────────────────────────────────────────────

  describe("runChecklists()", () => {
    it("应运行所有 checklist 条目并返回结果", async () => {
      const results = await executor.runChecklists("v1-test-slice");
      assert.equal(results.length, 3);
      for (const r of results) {
        assert.equal(r.passed, true);
      }
    });

    it("应返回每个条目的文本内容", async () => {
      const results = await executor.runChecklists("v1-test-slice");
      assert.equal(results[0].text, "First checklist item");
    });
  });
});

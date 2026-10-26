import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ReportGenerator, MarkdownGenerator } from "../../src/core/report/report-generator.js";
import type { Report, Section } from "../../src/core/report/report-generator.js";
import { renderString } from "../../src/core/report/markdown-generator.js";

void describe("ReportGenerator", () => {
  let generator: ReportGenerator;

  beforeEach(() => {
    generator = new ReportGenerator();
  });

  void describe("generate()", () => {
    void it("should create a report with title and sections", () => {
      const report = generator.generate({
        title: "Test Report",
        sections: [
          { heading: "Introduction", content: "This is the intro.", level: 1 },
          { heading: "Details", content: "More details here.", level: 2 },
        ],
      });

      assert.equal(report.title, "Test Report");
      assert.equal(report.sections.length, 2);
      assert.equal(report.sections[0].heading, "Introduction");
      assert.equal(report.sections[0].content, "This is the intro.");
      assert.equal(report.sections[0].level, 1);
      assert.equal(report.sections[1].heading, "Details");
      assert.equal(report.sections[1].level, 2);
    });

    void it("should default section level to 1", () => {
      const report = generator.generate({
        title: "Test",
        sections: [{ heading: "Section", content: "Content" }],
      });

      assert.equal(report.sections[0].level, 1);
    });

    void it("should include a generatedAt timestamp", () => {
      const before = Date.now();
      const report = generator.generate({
        title: "Timed",
        sections: [],
      });
      const after = Date.now();

      const ts = Date.parse(report.generatedAt);
      assert.ok(ts >= before && ts <= after, `generatedAt ${report.generatedAt} should be within [${before}, ${after}]`);
    });

    void it("should pass through metadata", () => {
      const report = generator.generate({
        title: "Meta",
        sections: [],
        metadata: { author: "Alice", version: "1.0.0", description: "A test" },
      });

      assert.equal(report.metadata.author, "Alice");
      assert.equal(report.metadata.version, "1.0.0");
      assert.equal(report.metadata.description, "A test");
    });

    void it("should accept extra metadata fields", () => {
      const report = generator.generate({
        title: "Extra",
        sections: [],
        metadata: { project: "zelto", milestone: "v1" },
      });

      assert.equal(report.metadata.project, "zelto");
      assert.equal(report.metadata.milestone, "v1");
    });
  });
});

void describe("MarkdownGenerator", () => {
  let markdownGenerator: MarkdownGenerator;

  beforeEach(() => {
    markdownGenerator = new MarkdownGenerator();
  });

  void describe("render()", () => {
    void it("should render a report with title and sections", () => {
      const report: Report = {
        title: "My Report",
        sections: [
          { heading: "Intro", content: "Welcome.", level: 1 },
          { heading: "Details", content: "Some details.", level: 2 },
        ],
        metadata: {},
        generatedAt: "2025-01-01T00:00:00.000Z",
      };

      const output = markdownGenerator.render(report);

      assert.ok(output.includes("# My Report"));
      assert.ok(output.includes("# Intro"));
      assert.ok(output.includes("Welcome."));
      assert.ok(output.includes("## Details"));
      assert.ok(output.includes("Some details."));
      assert.ok(output.includes("Generated: 2025-01-01T00:00:00.000Z"));
    });

    void it("should render metadata when present", () => {
      const report: Report = {
        title: "With Meta",
        sections: [],
        metadata: { author: "Bob", version: "2.0", description: "A meta report" },
        generatedAt: "2025-06-15T12:00:00.000Z",
      };

      const output = markdownGenerator.render(report);

      assert.ok(output.includes("*Author: Bob*"));
      assert.ok(output.includes("*Version: 2.0*"));
      assert.ok(output.includes("A meta report"));
    });

    void it("should not render missing metadata", () => {
      const report: Report = {
        title: "No Meta",
        sections: [],
        metadata: {},
        generatedAt: "2025-06-15T12:00:00.000Z",
      };

      const output = markdownGenerator.render(report);

      assert.ok(!output.includes("*Author:*"));
      assert.ok(!output.includes("*Version:*"));
    });

    void it("should render multiple sections with mixed levels", () => {
      const sections: Section[] = [
        { heading: "H1", content: "Level 1", level: 1 },
        { heading: "H2a", content: "Level 2a", level: 2 },
        { heading: "H2b", content: "Level 2b", level: 2 },
        { heading: "H3", content: "Level 3", level: 3 },
      ];

      const report: Report = {
        title: "Levels",
        sections,
        metadata: {},
        generatedAt: "2025-01-01T00:00:00.000Z",
      };

      const output = markdownGenerator.render(report);

      assert.ok(output.includes("# H1"));
      assert.ok(output.includes("## H2a"));
      assert.ok(output.includes("## H2b"));
      assert.ok(output.includes("### H3"));
    });
  });
});

void describe("renderString (markdown-generator)", () => {
  void it("should replace simple variables", () => {
    const result = renderString("Hello {{name}}!", { name: "World" });
    assert.equal(result, "Hello World!");
  });

  void it("should handle nested paths", () => {
    const result = renderString("{{user.name}}", { user: { name: "Alice" } });
    assert.equal(result, "Alice");
  });

  void it("should handle {{#if}} blocks", () => {
    const result = renderString("{{#if show}}visible{{/if}}", { show: true });
    assert.equal(result, "visible");
  });

  void it("should hide {{#if}} blocks when false", () => {
    const result = renderString("{{#if show}}visible{{/if}}", { show: false });
    assert.equal(result, "");
  });

  void it("should handle {{#each}} blocks", () => {
    const template = "{{#each items}}{{name}}, {{/each}}";
    const result = renderString(template, { items: [{ name: "a" }, { name: "b" }] });
    assert.equal(result, "a, b, ");
  });

  void it("should handle {{#repeat}} blocks", () => {
    const result = renderString("{{#repeat level}}#{{/repeat}}", { level: 3 });
    assert.equal(result, "###");
  });
});

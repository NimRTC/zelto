import type { Report } from "./report-generator.js";

/**
 * Renders a Report into a pretty-printed JSON string.
 *
 * Mirrors the MarkdownGenerator pattern: takes a structured Report
 * and serializes it to the target format.
 */
export class JsonGenerator {
  /**
   * Render a Report to a JSON string.
   *
   * @param report - The Report to render
   * @param indent - Number of spaces for indentation (default 2)
   * @returns Pretty-printed JSON string
   */
  render(report: Report, indent: number = 2): string {
    return JSON.stringify(report, null, indent);
  }
}

/**
 * Render a Report object as a JSON string.
 *
 * Convenience standalone function, equivalent to `new JsonGenerator().render(report)`.
 *
 * @param report - The Report to render
 * @param indent - Number of spaces for indentation (default 2)
 * @returns Pretty-printed JSON string
 */
export function renderJsonReport(report: Report, indent: number = 2): string {
  return JSON.stringify(report, null, indent);
}

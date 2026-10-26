import { renderTemplate } from "./markdown-generator.js";
import type { ReportData } from "./report-analyzer.js";

/**
 * A section of a report with a heading, content, and heading level.
 */
export interface Section {
  /** The heading text */
  heading: string;
  /** The body content (markdown) */
  content: string;
  /** Heading level (1 = #, 2 = ##, etc.) */
  level: number;
}

/**
 * Metadata associated with a report.
 */
export interface ReportMetadata {
  /** Report author */
  author?: string;
  /** Version string */
  version?: string;
  /** Short description */
  description?: string;
  /** Additional metadata fields */
  [key: string]: unknown;
}

/**
 * A generated report with title, sections, metadata, and timestamp.
 */
export interface Report {
  /** Report title */
  title: string;
  /** Report sections */
  sections: Section[];
  /** Report metadata */
  metadata: ReportMetadata;
  /** ISO timestamp when the report was generated */
  generatedAt: string;
}

/**
 * Generates structured reports from input data.
 */
export class ReportGenerator {
  /**
   * Generate a Report object from input data.
   *
   * @param data - Raw data to convert into a report
   * @returns A structured Report object
   */
  generate(data: {
    title: string;
    sections: Array<{ heading: string; content: string; level?: number }>;
    metadata?: Record<string, unknown>;
  }): Report {
    const sections: Section[] = data.sections.map((s) => ({
      heading: s.heading,
      content: s.content,
      level: s.level ?? 1,
    }));

    return {
      title: data.title,
      sections,
      metadata: {
        author: undefined,
        version: undefined,
        description: undefined,
        ...(data.metadata ?? {}),
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Renders a Report into markdown using a template.
 */
export class MarkdownGenerator {
  /**
   * Render a Report to a markdown string.
   *
   * @param report - The Report to render
   * @returns Markdown string
   */
  render(report: Report): string {
    return renderTemplate("templates/report.hbs", {
      title: report.title,
      sections: report.sections,
      metadata: report.metadata,
      generatedAt: report.generatedAt,
    });
  }
}

// ─── Legacy API (used by CLI `zelto report` command) ─────────────────────────

export type ReportFormat = 'markdown' | 'json';

function renderReportDataMarkdown(data: ReportData): string {
  const lines: string[] = [];

  lines.push(`# ${data.project.name} — Status Report`);
  lines.push(`*Generated: ${data.project.generatedAt}*`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Requirements
  lines.push('## Requirements');
  lines.push('');
  lines.push(`- Total: ${data.requirements.total}`);
  lines.push(`- Confirmed: ${data.requirements.confirmed}`);
  lines.push(`- Draft: ${data.requirements.draft}`);
  lines.push('');

  // Designs
  lines.push('## Designs');
  lines.push('');
  lines.push(`- Total: ${data.designs.total}`);
  lines.push(`- Confirmed: ${data.designs.confirmed}`);
  lines.push(`- Draft: ${data.designs.draft}`);
  lines.push('');

  // Plans
  lines.push('## Plans');
  lines.push('');
  lines.push(`- Total: ${data.plans.total}`);
  lines.push(`- Confirmed: ${data.plans.confirmed}`);
  lines.push(`- Draft: ${data.plans.draft}`);
  lines.push('');

  // Slices
  lines.push('## Slices');
  lines.push('');
  lines.push(`- Total: ${data.slices.total}`);
  lines.push(`- Draft: ${data.slices.draft}`);
  lines.push(`- Clarifying: ${data.slices.clarifying}`);
  lines.push(`- Frozen: ${data.slices.frozen}`);
  lines.push(`- Running: ${data.slices.running}`);
  lines.push(`- Completed: ${data.slices.completed}`);
  lines.push(`- Abandoned: ${data.slices.abandoned}`);
  lines.push('');

  // Versions
  if (data.versions.length > 0) {
    lines.push('## Versions');
    lines.push('');
    for (const v of data.versions) {
      lines.push(`### ${v.version} — ${v.description}`);
      lines.push('');
      lines.push(`- Status: ${v.status}`);
      lines.push(`- Slices: ${v.completedSlices}/${v.totalSlices} completed`);
      lines.push('');
    }
  }

  // Gate stats
  if (data.gates.total > 0) {
    lines.push('## Gate Results');
    lines.push('');
    lines.push(`- Passed: ${data.gates.passed}`);
    lines.push(`- Failed: ${data.gates.failed}`);
    lines.push(`- Pass Rate: ${(data.gates.passRate * 100).toFixed(1)}%`);
    lines.push('');
  }

  // Events
  lines.push('## Events');
  lines.push('');
  lines.push(`- Total Events: ${data.events.total}`);
  lines.push('');
  if (data.events.recent.length > 0) {
    lines.push('### Recent Events');
    lines.push('');
    lines.push('| Timestamp | Type | Slice |');
    lines.push('|-----------|------|-------|');
    for (const e of data.events.recent) {
      lines.push(`| ${e.ts.slice(0, 19)} | ${e.type} | ${e.slice} |`);
    }
    lines.push('');
  }

  // Anomalies
  if (data.anomalies.length > 0) {
    lines.push('## Anomalies');
    lines.push('');
    for (const a of data.anomalies) {
      lines.push(`- **${a.id}** (${a.state}): ${a.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a report string from analyzed data.
 * Legacy API used by the CLI `zelto report` command.
 *
 * @param data - Analyzed report data
 * @param format - Output format ('markdown' | 'json')
 * @returns Formatted report string
 */
export function generateReport(data: ReportData, format: ReportFormat): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }
  return renderReportDataMarkdown(data);
}

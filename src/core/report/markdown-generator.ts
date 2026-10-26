import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A simple template engine that replaces {{variable}} placeholders
 * and supports {{#each items}}{{/each}}, {{#if cond}}{{/if}}, and
 * {{#repeat n}}{{/repeat}} blocks.
 *
 * This replaces Handlebars to keep core/ zero third-party dependencies.
 */

interface TemplateContext {
  [key: string]: unknown;
}

function renderBlock(
  template: string,
  context: TemplateContext,
): string {
  // Process each blocks first
  let result = template;

  // {{#each items}}...{{/each}}
  result = result.replace(
    /{{#each\s+(\w+)}}([\s\S]*?){{\/each}}/g,
    (_match: string, key: string, block: string) => {
      const items = context[key];
      if (!Array.isArray(items)) return "";
      return items
        .map((item: unknown, index: number) => {
          if (typeof item === "object" && item !== null) {
            const itemContext = ({ ...context, ...item, "@index": index }) as unknown as TemplateContext;
            return renderBlock(block, itemContext);
          }
          return renderBlock(block, ({ ...context, ".": item, "@index": index }) as unknown as TemplateContext);
        })
        .join("");
    },
  );

  // {{#if condition}}...{{/if}}
  result = result.replace(
    /{{#if\s+(\w+)}}([\s\S]*?){{\/if}}/g,
    (_match: string, key: string, block: string) => {
      const value = context[key];
      if (value && value !== false && value !== 0 && value !== "") {
        return renderBlock(block, context);
      }
      return "";
    },
  );

  // {{#repeat n}}#{{/repeat}} — repeat the inner content n times
  result = result.replace(
    /{{#repeat\s+(\w+)}}([\s\S]*?){{\/repeat}}/g,
    (_match: string, key: string, block: string) => {
      const count = context[key];
      if (typeof count !== "number" || count <= 0) return "";
      return block.repeat(count);
    },
  );

  // {{variable}} or {{variable.field}}
  result = result.replace(
    /{{([\w.@]+)}}/g,
    (_match: string, path: string) => {
      const value = resolvePath(context, path);
      if (value === undefined || value === null) return "";
      return String(value);
    },
  );

  return result;
}

function resolvePath(obj: TemplateContext, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    if (part === "@index") return current;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Load and render a template file with the given context.
 *
 * Resolves the template relative to this source file's directory.
 * When running from compiled output (dist-test/), falls back to the source location.
 */
export function renderTemplate(templatePath: string, context: TemplateContext): string {
  const resolvedPath = join(__dirname, templatePath);

  if (existsSync(resolvedPath)) {
    const template = readFileSync(resolvedPath, "utf-8");
    return renderBlock(template, context);
  }

  // When running from compiled output (dist-test/), resolve relative to source
  if (__dirname.includes("dist-test")) {
    const srcPath = __dirname.replace(/dist-test[\\/]/, "");
    const fallbackPath = join(srcPath, templatePath);
    if (existsSync(fallbackPath)) {
      const template = readFileSync(fallbackPath, "utf-8");
      return renderBlock(template, context);
    }
  }

  throw new Error(`Template not found: ${resolvedPath}`);
}

/**
 * Render a template string directly (for testing).
 */
export function renderString(template: string, context: TemplateContext): string {
  return renderBlock(template, context);
}

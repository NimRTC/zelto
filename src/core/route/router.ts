// Core router — command dispatch and route management

import type { Route, RouteHandler, RouteMatch } from './types.js';

export class Router {
  private routes: Map<string, Route> = new Map();

  register(name: string, handler: RouteHandler, description?: string): void {
    if (this.routes.has(name)) {
      throw new Error(`Route "${name}" is already registered`);
    }
    this.routes.set(name, { name, handler, description });
  }

  registerOrReplace(name: string, handler: RouteHandler, description?: string): void {
    this.routes.set(name, { name, handler, description });
  }

  get(name: string): Route | undefined {
    return this.routes.get(name);
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  list(): Route[] {
    return Array.from(this.routes.values());
  }

  /**
   * Match and dispatch a command string.
   * Supports subcommands: "require confirm req-123" → route "require" with args ["confirm", "req-123"]
   */
  match(input: string): RouteMatch | null {
    const parts = input.trim().split(/\s+/);
    if (parts.length === 0 || parts[0] === '') return null;

    // Try exact match first (e.g., "help" → route "help")
    const exactRoute = this.routes.get(parts[0]);
    if (exactRoute) {
      return { route: exactRoute, args: parts.slice(1) };
    }

    // Try compound match: first two parts (e.g., "require confirm" → route "require" with args ["confirm", ...])
    // but only if there's no exact match for the compound form
    if (parts.length >= 2) {
      const compoundName = `${parts[0]}-${parts[1]}`;
      const compoundRoute = this.routes.get(compoundName);
      if (compoundRoute) {
        return { route: compoundRoute, args: parts.slice(2) };
      }
    }

    return null;
  }

  async dispatch(name: string, args: string[]): Promise<number> {
    const route = this.routes.get(name);
    if (!route) {
      throw new Error(`Unknown command: "${name}"`);
    }
    return route.handler(args);
  }

  remove(name: string): boolean {
    return this.routes.delete(name);
  }

  clear(): void {
    this.routes.clear();
  }

  get size(): number {
    return this.routes.size;
  }
}

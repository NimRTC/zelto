// Route types — core command routing abstractions

export interface Route {
  name: string;
  handler: RouteHandler;
  description?: string;
}

export type RouteHandler = (args: string[]) => Promise<number>;

export interface RouteMatch {
  route: Route;
  args: string[];
}

export interface RouterConfig {
  prefix?: string;
  allowUnknownCommands?: boolean;
}

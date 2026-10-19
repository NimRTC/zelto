# zelto

zelto is an **AI Programming Cockpit** — it doesn't write code, it makes sure every line an agent writes traces back to a human-approved spec.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Project Structure

```
src/
  core/        Slice state machine, policy engine, gate, scheduler, events, audit, metrics
  adapters/    Executor adapters (Claude Agent SDK)
  cli/         CLI command implementations
  hook/        Standalone policy check process
tests/
  acceptance/  Acceptance test suites (one per slice)
```

## Commands

Run `zelto help` for all available commands.

## Constraints

- C1: State in files only — no database, no in-memory state
- C2: `core/` has zero npm dependencies (Node built-ins only)
- C3: Deterministic decisions — policy/gate/sched never call models or network
- C4: Every action writes to append-only event stream
- C6: Dependency direction is one-way — `core/` never imports `adapters/`
- C7: `llm/` output is draft/suggestion only — never participates in decisions

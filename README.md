# zelto

**Your agents do the work. zelto makes sure they stay inside the spec you approved.**

[![CI](https://github.com/NimRTC/zelto/actions/workflows/ci.yml/badge.svg)](https://github.com/NimRTC/zelto/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-7-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English | [简体中文](README.zh-CN.md)

> **Status: v0.4.0 — pre-1.0.** CLI flags, config schema, and event format may change
> without migration. Pin a commit if you need stability.

zelto is a local-first cockpit for AI coding agents. You write a slice spec, approve it,
and zelto runs the agent unattended — then refuses to merge anything that doesn't pass
the acceptance checks frozen alongside that spec.

- **Unattended, not babysat.** Stalls are classified. Environment failures retry on their
  own; everything that needs a human lands in one inbox instead of five terminal windows.
- **Gates you can't argue with.** The deterministic layer never calls a model. Acceptance
  checks are frozen with the spec, so an agent cannot make a gate pass by editing the test.
- **Agent-agnostic by construction.** Policy and gate decisions live in zelto, not in the
  harness. Two executors today: `claude-agent` (CLI spawn, default) and `claude-agent-sdk`
  (opt in with `--adapter claude-agent-sdk`); others plug in as adapters.
- **Everything is a file.** Slices, events, locks — no daemon, no database, no account.
  `grep` and `git log` are your audit tools.
- **Planning you can review in one screen.** `zelto require|design|plan show <id>` prints
  a summary, the decision points that actually need a human (marked added / removed /
  changed) and the diff against the previous revision — no more reading a wall of
  markdown before you approve a plan (ADR-023).

## Quick start

```bash
git clone https://github.com/NimRTC/zelto && cd zelto
pnpm install && pnpm build && pnpm link --global

cd <your-project>
zelto init
zelto create rate-limit-gateway --title "add per-IP rate limiting to the gateway"
zelto check rate-limit-gateway   # gate 1 — deterministic: traceable? contracts? acceptance frozen?
zelto freeze rate-limit-gateway  # freeze the baseline the agent must stay inside
zelto run rate-limit-gateway     # runs the agent unattended
zelto dashboard --tty            # what's stuck, what's waiting for your signature
zelto sign rate-limit-gateway --approve  # you approve; merging stays a separate, explicit step
zelto merge rate-limit-gateway   # explicit merge, never automatic on sign
```

The optional LLM path (clarify / spec drafting) needs a key. Keep it out of files:

```bash
export ZELTO_LLM_API_KEY=sk-...   # or DEEPSEEK_API_KEY; falls back to llm.apiKey in .zelto/config.yaml
```

Only the key comes from the environment — `baseUrl`, `model` and `pricing` stay in
`.zelto/config.yaml` so the project stays reproducible (ADR-022).

Run `zelto help` for the full command list. Run `zelto help <cmd>` for one command's usage.

## How it works

```
clarify (shape the spec) → draft + acceptance skeleton → check (gate 1) → freeze
  → run (unattended) → gate (gate 2: acceptance) → sign (human) → merge (explicit)
```

1. **Write a slice spec.** One unit of work: scope, write-set, acceptance criteria.
2. **Freeze it.** Gate 1 checks traceability and contracts deterministically — no model involved.
3. **Run unattended.** zelto launches the agent in an isolated git worktree when available (otherwise the current directory) with the write-set enforced at runtime.
4. **Gate it.** Gate 2 runs the frozen acceptance checks. A red gate blocks the merge, with evidence on disk.
5. **Sign and merge.** You approve in the inbox. Merging is always an explicit `zelto merge` step.

Humans set intent and sign. Agents implement. zelto guards the boundary in between.

## Why it's different

| Tool | What it solves | What it leaves out |
|---|---|---|
| **Cursor / Copilot** | How to write this code well in one session | Beyond the session: who approved it, what gate it passed, whether it still runs tomorrow |
| **Spec Kit / Kiro** | How specs are written and drive generation | After approval: who stops the agent when it drifts off-spec |
| **zelto** | How a batch of slices lands on-spec, verifiably, with minimal supervision | Completion feel, chat experience — that layer belongs to your agent |

One line: **zelto doesn't write code. It decides whether the code that was written is allowed to land.**

## Guarantees

What the architecture constraints mean for you:

- **No hidden state.** Everything lives in files under `.zelto/`. No daemon, no database.
- **Deterministic verdicts.** Policy and gate decisions never call a model and never touch the network.
- **Frozen acceptance.** The tests that decide the gate are frozen with the spec — the agent can't move the goalposts.
- **Isolation when git is there.** Agents run in isolated git worktrees when the project is a git repo (otherwise they run in the current directory); write-set reservations are enforced at runtime by a standalone hook process. This is not an OS sandbox.
- **Every action leaves a trace.** Append-only event logs back every state change, so failures can be attributed.
- **Sign ≠ merge.** Approving a slice never touches the branch. Merging is always explicit.
- **Hotfix is explicit.** Skipping gate 2 requires `zelto run --hotfix --yes`, and everything else (write-set, audit, protected paths) still applies.

Protected paths are hard-coded outside policy reach, and `core/` has zero third-party runtime dependencies (Node built-ins only).

## Status

- **Pre-1.0.** CLI flags, config schema, and event format may change without migration.
- **Two executors, default included.** `claude-agent` (CLI spawn) is the default; `claude-agent-sdk`
  is opt-in via `--adapter claude-agent-sdk`. The policy/gate layer is harness-agnostic,
  but claiming more harnesses before the adapters exist would be a lie.
- **Install from source.** Not on npm yet (`private: true`). Planned for 0.5.

## CLI reference

Everyday commands (`zelto help <cmd>` for flags):

```bash
zelto slices          # list all slices
zelto next            # recommended next action
zelto check <id>      # gate 1: deterministic pre-freeze checks
zelto freeze <id>     # freeze the slice baseline
zelto run <id>        # run the slice (parallel admission + runtime guard)
zelto gate <id>       # gate 2: run frozen acceptance checks
zelto inbox           # pending signature queue
zelto sign <id> --approve | --reject | --revoke
zelto halt            # emergency stop: pause the batch, hand control back to you
zelto merge <id>      # merge an approved slice (explicit; never automatic)
zelto dashboard --tty # terminal status: stalled, running, next actions
```

Hotfix skips gate 2 only, and requires explicit confirmation:

```bash
zelto run <id> --hotfix --yes
```

## Architecture

```
                    ┌─────────────────┐
                    │  human (dev)    │
                    │  intent · sign  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌──────────┐  ┌──────────┐  ┌──────────┐
       │ clarify  │  │   sign   │  │  inbox   │
       │ shape    │  │ approve /│  │ pending  │
       │ the spec │  │ reject   │  │ queue    │
       └────┬─────┘  └──────────┘  └──────────┘
            │
       ┌────▼─────┐     ┌──────────┐     ┌──────────┐
       │  slice   │────►│  sched   │────►│   gate   │
       │ state    │     │ parallel │     │ gate     │
       │ machine  │     │ admission│     │ executor │
       └──────────┘     └──────────┘     └──────────┘
            │
       ┌────▼─────┐     ┌──────────┐     ┌──────────┐
       │  policy  │     │  stall   │     │ metrics  │
       │ engine   │     │ classifi-│     │ rework / │
       │ determ.  │     │ cation   │     │ cycle    │
       └──────────┘     └──────────┘     └──────────┘

       ┌──────────┐     ┌──────────┐     ┌──────────┐
       │  events  │     │  audit   │     │   hook   │
       │ append-  │     │ readable │     │ standalone│
       │ only log │     │ trail    │     │ verdict  │
       └──────────┘     └──────────┘     └──────────┘
```

Core loop: `clarify → draft → check (gate 1) → freeze → run → gate (gate 2) → sign → merge`.

Roles: the developer sets intent and signs; the agent implements unattended;
zelto validates traceability, classifies stalls, enforces gates, records events, and routes work.

Key invariants:

| Constraint | Meaning |
|---|---|
| **C1** | State lives in files only — no database, no in-memory state |
| **C2** | `core/` depends on no SDK and no `adapters/` |
| **C3** | Verdicts are deterministic — `core/policy/` and `core/gate/` never call models or network |
| **C4** | Every action appends to the event stream |
| **C5/C8** | Protected paths are hard-coded and cannot be overridden by policy rules |
| **C6** | One-way dependencies — `core/` never imports `adapters/` |
| **C7** | `llm/` output is always a draft or suggestion, never part of a verdict |
| **C9** | Write-set reservations are enforced at runtime by the hook |

## Project structure

```
zelto/
├── src/
│   ├── core/           slice state machine · policy · gate · sched · stall
│   │                    clarify · events · audit · metrics · halt · ports · review
│   │                    (+ artifacts/budget/contracts/design/project/question
│   │                     report/requirements/route/spec/version/worktree)
│   ├── cli/            CLI implementation (`zelto help` is the source of truth)
│   │   ├── commands/   slice/pipeline/governance/panoramic command groups
│   │   └── policy/     policy CLI entry
│   ├── hook/           standalone verdict process (git hooks / CI gate)
│   ├── adapters/       executor adapters (`claude-agent` default, `claude-agent-sdk` opt-in)
│   └── llm/            passage B only: drafts and suggestions, never verdicts
├── contracts/schemas/  JSON Schema source of truth
├── policy/             policy.yaml + lock.json
├── tests/              unit tests + acceptance suites (tests/acceptance/)
├── specs/slices/       slice specs
└── .zelto/             runtime state (slices/ events/ locks/ halts/ worktrees/ ...)
```

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 7, `strict: true` |
| Runtime | Node 22, ESM |
| Tests | `node --test` (no test framework dependency) |
| Format / Lint | Biome |
| Package manager | pnpm 9 |
| Runtime deps | `core/` has zero third-party dependencies (Node built-ins only) |

## Development

```bash
pnpm dev              # watch-mode compile
pnpm test             # build + run all tests (including acceptance)
pnpm test:quick       # run tests without rebuilding
pnpm test:watch       # watch-mode tests
pnpm lint             # biome check on src/
pnpm format           # biome format src/
pnpm clean            # remove build output
```

Build first: acceptance tests spawn the real `dist/cli/index.js` binary,
so always `npm run build` (or `npm test`, which builds) after changing `src/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow and DCO sign-off.
Design records live in [docs/](docs/adr-018-no-auto-merge-on-sign.md); start with the ADR index.

## License

[MIT](LICENSE)

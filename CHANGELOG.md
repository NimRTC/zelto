# Changelog

## [Unreleased]

### Fixed
- **Multi-line gate commands in `.zelto/config.yaml` are no longer swallowed**
  (ADR-041). YAML's idiomatic way of writing a long shell command is a folded
  block scalar (`run: >`), but the config parser only understood a single-line
  `run: <one line>` — so `run: >` was read as the literal command `>`, and the
  gate failed instantly with a syntax error that pointed at the *build*, not at
  the parser. The failure was in the wrong place: the code that was actually
  broken (the parser) reported nothing, and the error surfaced several layers
  downstream. The parser now understands block scalars (`>` folded, `|`
  literal) in all four places they may appear (gate commands, slice-level
  acceptance, agent command, target-project gate), and the cursor advances
  exactly past the block. A folded value never contains a newline — a value
  with newlines would turn "one command" into "several commands".
- **The slice ledger now matches what actually happened** (ADR-041). Three
  fields were structurally present but never filled in, so a person reading a
  slice's state file was reading fiction. `runs` was a dead field (nothing in
  the repository ever pushed to it) and the clarification round number was
  derived from it, so the round was always 1 — asking the same questions in
  every round and colliding on question ids; each agent run now appends a
  `{ at, ok, exitCode }` record and the clarification round has its own
  monotonic counter. `baseCommit` was always `null`, which made the merge
  guard's "the base moved — block the merge" rule a no-op; the base commit is
  now written back when the worktree is created (an existing base is never
  overwritten). A slice in a terminal state (`completed` / `abandoned`) no
  longer carries a stall classification — "this slice is stuck" is simply not
  true of a finished slice — and legacy state files are corrected when read.

## [0.5.0] — 2026-11-10

### Added
- **Taking over an existing project now actually takes over** (ADR-040).
  Managed files are tracked in three states — `generated` / `legacy` /
  `manual` — instead of two. Files zelto generated *before* ADR-038 have no
  marker line, so the hash comparison classified them as hand-written and the
  takeover path stopped working: gate commands stayed generic, write-set rules
  were not derived from the real modules, and root-level build manifests had no
  rule at all, so an agent editing the top-level `CMakeLists.txt` was rejected
  by the PreToolUse hook. `legacy` files are recognised by content signature
  and rebuilt only when the old rule set is provably covered by the new one;
  strategies that contain hand-written rules, or configurations with custom
  gate commands, are left byte-for-byte untouched and reported. A deprecated
  `anchors:` section no longer fails `policy validate` — it is reported as a
  warning, and the old anchor is moved into `policy/lock.json` without being
  overwritten, so a mismatch still surfaces. The migration is recorded as a
  `project.policy_migrated` event (C4). **Breaking:** `initializeProject` is
  now asynchronous, because it has to write that event.
- **Five follow-ups to taking over an existing project** (ADR-039). The
  remaining gaps on the path a person actually walks: registering the current
  code as baseline slices now writes a `slice.baseline_registered` event (C4 —
  the event stream is the only carrier of evidence, so a registration with no
  event did not happen); the policy hash anchor moved **out of the policy file**
  into `policy/lock.json`, because a file that declares its own hash proves
  nothing — changing the policy no longer silently changes the standard it was
  judged by (C5); the pre-merge guard now tells zelto's own spec files apart
  from code changes, so uncommitted `specs/slices/**` no longer blocks a merge
  forever; `zelto init` and `zelto project init` now register the *same*
  baseline through one function; and baseline write sets are directory
  globs, so files added to a module later still fall inside the baseline.
- **Trace judgment is now a gate, not a suggestion** (ADR-032). `zelto freeze`,
  `version start` and the scheduler's admission check all refuse to let a slice
  through when its trace is incomplete — a slice with no requirement trace used
  to freeze, run an agent, pass gate② and land in the sign queue. The spec's
  「验收标准」section is materialised into the requirement trace, so the
  "every line traces to an approved spec" promise is now enforced on the path
  people actually use.
- **Slice-level acceptance** (ADR-033). `zelto spec draft` generates an
  acceptance-test skeleton (one `todo` per acceptance criterion), and gate②
  now runs *this slice's* acceptance files instead of only the whole-project
  commands. Not configured is recorded as `skipped`, never silently skipped;
  configured but unrunnable is `failed`.
- **Spec generation with human confirmation** (ADR-034).
  `zelto spec draft <id>` produces a spec draft (via the LLM when one is
  configured, deterministic fallback otherwise) plus an acceptance skeleton;
  `zelto spec confirm <id>` is what makes it the "approved source" a trace can
  point at. Drafts never participate in any judgment (C7).
- **Agent spend is now metered, and the budget gate actually closes**
  (ADR-035). Both executor adapters report their real cost via the optional
  `getUsage(sessionId)` port; the CLI records it as a `budget.spent` event
  (`source: 'agent'`) after the agent exits and re-checks the budget. A slice
  that reaches its limit **does not enter gate② and gets no sign request** —
  it stops at `frozen` and waits for a human to add budget or cut scope.
  `run.finished` now carries `costUsd`; `null` means "not measured" and is
  deliberately distinct from zero.
- **Contract evolution check and cross-version regression baseline**
  (ADR-036). `zelto contract check` compares the contracts in
  `contracts/schemas/` against a **human-confirmed baseline** and reports
  which changes are breaking, split by direction: *writer* (the new contract
  no longer accepts old data) and *reader* (the new data breaks old programs).
  The baseline is only ever updated by an explicit `zelto contract baseline` —
  accepting a break is a human's signature, never an automatic step.
  `zelto version deliver` now runs the contract check as a precondition and
  records a regression baseline from the acceptance output, comparing it with
  the previous delivered version to catch the case where a slice deletes the
  test that proved a behaviour (regressed / degraded / missing). A detected
  regression blocks delivery; `--accept-regression` records an explicit
  acceptance instead.
- **The dashboard now reports token usage, not just money.** `zelto dashboard`
  (TTY / JSON / HTML) sums the `budget.spent` and `llm.called` events into one
  set of numbers: agent execution and planning-time LLM drafts are kept apart,
  and input/output tokens are broken out on each side — so "is the agent
  expensive because it re-reads the codebase, or because it keeps rewriting?"
  has an answer. The dashboard also shows the per-slice budget ceiling next to
  the most expensive slice, and a **Token 消耗 Top** table. Cost and token
  collection lives in one module (`src/cli/commands/dashboard-cost.ts`) so the
  three renderings cannot drift apart; "measured as zero" stays strictly
  separate from "not measured" (ADR-035).
- **"Completed" and "delivered" are now two separate things on the dashboard.**
  `completed` means both "gate② passed" and "a human signed off" (ADR-018:
  signing does not change the state), so a project overview could show
  `completed: 12` while three of those slices were still sitting outside the
  main branch and two had never been sent for signature at all. The new
  delivery view sorts every finished slice into one of six states —
  **已合入主干 / 已签字·待合并 / 门禁通过·待签字 / 门禁通过·未发起签字 /
  基线切片·无分支 / 已作废** — and shows them on `zelto dashboard` (TTY, JSON,
  HTML), `zelto suggest` and `zelto summary`. The classification reads the same
  sources as `zelto inbox` / `zelto merge` (sign requests, merge candidates),
  so the dashboard cannot disagree with the commands that do the work; the
  verdict itself is a pure function (`classifyDelivery`) locked by unit tests.
- **One wording for a run outcome, whichever path produced it.** The same
  ending — write-set violation, audit failure, budget exhausted, agent
  failure — used to be announced differently by `zelto run`, `zelto run
  --parallel` and `zelto run --background`. People then acted on the wrong
  path's advice. The wording now lives in one module (`run-messages.ts`) and
  every path says the same thing: this round does not count, the slice is
  back at `frozen` (not dead), and here is the exact command to run next.
- Planning confirmation is now a review view instead of a wall of markdown:
  `zelto require|design|plan show <id>` prints a summary, the **decision points**
  (acceptance criteria, modules, module dependencies, versions, slices — each
  marked added / removed / changed) and, with `--diff`, the change against the
  previous revision; `--full` appends the body (ADR-023).
- Draft revisions are snapshotted before every refine, so "what changed" is
  always visible. Snapshots live in `.zelto/revisions/<kind>/<id>/`.
- New event types `draft.created` / `draft.revised` / `draft.confirmed` —
  changes to a requirement, design or version plan are now traceable.
- `zelto pipeline status` lists the drafts that still need confirmation and
  the exact command to review them.
- LLM credentials can come from the environment instead of a file:
  `ZELTO_LLM_API_KEY` > `DEEPSEEK_API_KEY` > `llm.apiKey` in `.zelto/config.yaml`
  (ADR-022). `baseUrl` / `model` / `pricing` stay in the config file so the
  project remains reproducible.
- The config file can point at the environment itself: `apiKey: "${NIMRTC_LLM_API_KEY}"`
  in `.zelto/config.yaml` is replaced with that variable's value, so the key never
  touches disk (ADR-026). If the variable is unset, zelto reports "no key" with a
  warning — the literal `${...}` text is never sent as a credential. Only whole-value
  references are expanded; `"prefix-${FOO}"` is left as-is.
- `pnpm check:credentials` — scans changed, untracked and tracked files for
  credentials before a commit; wired into CI as a gate
- `zelto arch check` and the architecture guard now pick the **project baseline
  design** (`zelto project design`, tagged `__project__`) by default instead of
  "the most recently created confirmed design". Picking a local feature design
  and comparing it against the whole repo marked every unrelated file as
  unmapped — the report was misleading and the guard could block legitimate
  write sets. Other confirmed designs are listed in the report so `--design
  <id>` is discoverable.
- **Published to npm.** `npm install -g zelto` installs the CLI and the
  standalone hook. npm is the only distribution channel — the repository's
  `Dockerfile` and `docker-compose.yml` stay as development conveniences and
  do not carry releases. Releases run from a tag: `v<version>` must match the
  version in `package.json`, the tarball is installed into a clean directory
  and exercised (`zelto init` + policy-anchor self-check) before
  `npm publish --provenance` runs.

### Fixed
- **The installed package was never actually exercised.** The `files`
  whitelist decided *which* files ship, but nothing checked that the files
  that shipped *worked*. Three real defects were hiding in the gap:
  `bin/zelto.sh` pointed at `bin/dist/cli/index.js` while `dist/` sits next to
  `bin/`, so the wrapper had never run successfully since it landed; the
  package shipped `policy/` — zelto's own write-set rules, which the user's
  project never reads (`zelto init` generates a policy from the modules it
  detects) and which are actively misleading once they land in someone else's
  repository; and this repository's own `policy/lock.json` was still in the
  pre-ADR-039 format, so the anchor reader could not parse it and zelto
  reported itself as *unanchored* — C5's protection was silently inert on the
  one repository where it mattered most. `tests/package-availability.test.ts`
  now packs, installs and runs the real CLI in a clean directory, so these
  cannot come back.
- **Four event types could be emitted but were not in the contract.**
  ADR-036 added `contract.evolution_checked`, `contract.baseline_updated`,
  `version.regression_recorded` and `version.regression_detected`, but the
  enum in `contracts/schemas/event-envelope.json` — the declared source of
  truth — was never updated, so the code could write events the contract did
  not recognise. The enum now lists all 57 event types, and the gap is
  closed for good: the event list is a runtime array (`EVENT_TYPES`) that the
  `EventType` union is derived from, the audit summary map is typed
  `Record<EventType, ...>` (so a missing summary is a **compile error**, not a
  runtime degradation to `Event: <type>`), and `tests/event-contract-parity.test.ts`
  reconciles contract ↔ code ↔ audit summaries ↔ documentation on every test
  run.
- **A write-set audit failure no longer leaves the slice stuck in `running`.**
  When the post-run audit could not read git state, the slice was neither
  advanced nor rolled back — `run` / `merge` / `resume` were all blocked and
  the only way out was `abandon`, i.e. "the audit environment is broken" threw
  the work away. The slice now returns to `frozen` like a real violation does,
  with a `run.aborted` event whose reason is `write-set audit failed`. The
  message distinguishes it from an actual violation, because the next step
  differs: fix the audit environment vs. widen the write set.
- **A write-set violation is no longer announced twice on the background
  path.** `enforceWriteSet` already writes the `run.aborted` event and rolls
  the slice back; the caller wrote a second `run.aborted` on top of it. In an
  append-only event stream a duplicate entry reads as "this happened twice".
- **`zelto check` now exits non-zero on failure in text mode too** (ADR-032).
  It always returned 0, so it could not be chained into a script or a hook.
  The spec engine (`validateDeterministic` / `analyzeSemantic`) is now wired
  into `check` instead of being reachable only from tests: deterministic
  findings block, semantic heuristics only advise (C7).
- **`budgetLimitUsd: 0` now means "unlimited"** (ADR-035). The config comment
  said so, the implementation treated `0` as invalid and fell back to the
  default `1.0` — comment and code disagreeing means the setting is a lie.
- **The dashboard's "pending approval" hint never appeared.** It looked for
  `.zelto/inbox`, a directory that does not exist — sign requests live in
  `.zelto/locks/sign-*.json`. The hint now reads the same source as
  `zelto inbox` / `zelto next` / `zelto merge` and points at `zelto inbox`
  (the suggested `zelto sign --list` was not a command that exists).
- **The dashboard's HTML output now escapes dynamic text.** Slice titles and
  event actors come from files any process can append to; they were
  interpolated raw, so a title could inject markup into the generated page.
- **A slice whose measured cost is zero no longer disappears from the
  dashboard's cost view.** The old filter kept only slices with non-zero cost
  or at least one LLM call, which silently dropped "measured, and it was
  free" — the same distinction ADR-035 draws between `null` and `0`.
- **An agent failure no longer hides a write-set violation that happened in the
  same round.** When the agent exited non-zero *and* had written outside its
  write set, the single-slice and background paths printed only "agent exited
  with code N" — the list of offending files was computed, written to the event
  stream, and then never shown to a human. The violation message is now printed
  alongside the failure message on both paths, so the file list that decides
  "widen the write set or redo the spec" is not lost.
- **The parallel path now audits slices whose agent failed.** `zelto run
  --parallel` skipped the post-run write-set audit entirely when the agent
  exited non-zero, so on that path the C9 audit fallback simply did not exist:
  a slice that failed *and* wrote outside its write set was reported as a
  plain failure, with no violation event and no rollback to `frozen`. Failed
  slices are now audited like successful ones; the violation is reported and
  the slice goes back to `frozen` so it can be re-run after the write set is
  widened.
- **The background path writes `run.aborted` once, not twice.** The
  de-duplication added with the unified run messages only covered the
  `exitCode === 0` branch; an agent failure combined with a violation still
  produced two `run.aborted` entries, which reads as "this happened twice" in
  an append-only stream. The second entry is now written only when the audit
  did not already write one.
- **Policy YAML parsing now ignores quote style and inline key order**
  (ADR-028). A `deny` rule written as `path: 'secrets/**'` was parsed into the
  literal `'secrets/**'`, which never matches a real path — so the rule was
  silently skipped and the write was allowed by a broader `allow` rule.
  **Strategy written more strictly was easier to bypass.** Single quotes,
  double quotes and unquoted values are now equivalent, and
  `match: { operation: ..., path: ... }` parses the same as
  `match: { path: ..., operation: ... }`. Fixed in all three parsers
  (`core/policy/yaml.ts`, `hook/index.ts`, `hook/pretool.ts`); equivalence is
  locked by `tests/policy-parser-parity.test.ts`.
- The `arch:` section of `policy.yaml` no longer contaminates the last
  `rules:` entry in the hook parser — its `action:` / `basis:` used to be
  attached to the previous rule, which could turn an `allow` rule into a
  `deny`.
- The protected domain now has a single source of truth: `PROTECTED_PATTERNS`
  is exported from `core/policy/engine.ts` and reused by the report layer; the
  hook keeps its own copy (it must compile standalone) and
  `tests/protected-domain-parity.test.ts` asserts the two copies and their glob
  semantics stay identical.
- Every event type now has a dedicated audit summary — `sign.revoked`,
  `draft.created`, `draft.revised` and `draft.confirmed` previously fell back
  to the generic `Event: <type>` text. A test covers all 52 event types.
- `zelto config` with no subcommand now shows the configuration instead of
  printing usage text — the "show configuration" branch was unreachable.
- `zelto config get llm.apiKey` masks the credential by default; the real
  value requires an explicit `--raw`. Previously the full key went to stdout,
  which is a leak vector in terminals and CI logs. `zelto config set` masks
  the value it echoes back for secret keys too.
- Files written with a UTF-8 BOM (common on Windows) no longer break requirement
  / design / plan / revision parsing; `show` reports a readable error instead
  of throwing a stack trace.
- The Claude Agent SDK adapter now passes its `AbortController` to the SDK, so
  `stop()` and the timeout actually terminate the spawned Claude Code process.
  Previously the controller was created but never wired up, which left the child
  process running and made "halt" a no-op in practice.
- `waitForExit()` no longer hangs when the session already exited before the
  call
- `run*.txt` is git-ignored — test-run logs are local artifacts, not sources

## [0.4.0] — 2026-11-04

### Added
- `zelto halt` — emergency halt for a running batch; halted slices roll back to
  `frozen` with `human_halt` (ADR-020)
- `zelto batch` — admission review for a batch of slices: freeze / traceability /
  acceptance / budget checks plus dependency layering and write-set conflict detection
- `zelto merge` — merge is now an explicit action, decoupled from signing;
  `--push` lives on `merge` (ADR-018)
- `sign --revoke` — revoke an approved sign-off; writes `sign.revoked`, keeps the record (ADR-021)
- Version-level orchestration and a single parallel execution path
  (`executeSlicesParallel()`) shared by `run --parallel` and `version start` (ADR-017)
- Phased execution — topological layering by slice dependencies; overlapping write
  sets within a phase degrade to serial (ADR-019)
- Git hooks are installed only into managed projects; default-deny rules warn
  instead of blocking

### Changed
- `sign --approve` no longer auto-merges
- `zelto run --hotfix` requires an explicit `--yes`
- Removed `zelto version start --auto`

### Fixed
- Acceptance-test mock commands now use `process.exitCode=N`, fixing a POSIX shell
  syntax error that failed 8 tests on Linux CI

## [0.1.0] — 2026-10-19

### Added
- Full slice lifecycle: create, freeze, check, run, gate, sign, abandon
- CLI with 17 commands: summary, init, slices, create, start, check, freeze,
  run, gate, inbox, sign, abandon, events, next, hook, help
- Policy engine with YAML-based rules and protected domains
- Git hook integration (pre-commit, pre-push) for policy enforcement
- Event stream with 29 typed event types, append-only JSONL storage
- Audit trail and metrics collector (rework rate, cycle time, stall counts)
- Budget tracking (BudgetCollector: getSpent, getLimit, isExhausted)
- Clarify engine with 5 question types, interactive and auto modes
- Scheduler with parallel admission, write-set conflict detection
- Gate executor with command running, retry, and timeout
- Sign manager with request/approve/reject workflow
- 31 signed slices, 34 test files, 11 core modules

### Infrastructure
- TypeScript + Node 22 ESM, strict mode
- Biome for formatting and linting
- Node --test for test runner
- Conventional Commits with Refs-Slice trailers

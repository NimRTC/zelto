# ADR-107 — Shared append-only documentation is not a write-set conflict

> Status: **Accepted**
> Date: 2026-11-25
> Affects: `core/sched/paths.ts`, `core/sched/engine.ts`, `core/sched/batch.ts`

---

## 0. Real-world verification

The gap that motivated this ADR was hit immediately, on the nimrtc v1.4
line. Two slices whose **code** write-sets are completely disjoint:

```
v1-turn-tls-trust          →  src/engine/**, src/plugins/**, docs/api/engine_api.md, CHANGELOG.md
v1-install-tree-video-deps →  cmake/**, src/modules/nvcodec/**, docs/api/engine_api.md, CHANGELOG.md
```

Before this ADR:

```
zelto run v1-install-tree-video-deps — ❌ Cannot run: Write-set conflicts with: v1-turn-tls-trust
```

After: both run concurrently. `v1-turn-tls-trust` completed with its gate
green while `v1-install-tree-video-deps` was still running.

Zelto's own test suite: **3226 tests, 3226 pass, 0 fail** after the
change.

---

## 1. The problem

Two slices whose **code** write-sets are completely disjoint cannot run in
parallel, because both list the same two documentation files:

```
v1-turn-tls-trust          →  src/engine/**, src/plugins/**, docs/api/engine_api.md, CHANGELOG.md
v1-install-tree-video-deps →  cmake/**, src/modules/nvcodec/**, docs/api/engine_api.md, CHANGELOG.md
```

The only shared paths are `docs/api/engine_api.md` and `CHANGELOG.md` —
both **append-style** documents (numbered sections in one, bullet items in
the other). `zelto run` on the second slice fails:

```
zelto run v1-install-tree-video-deps — ❌ Cannot run: Write-set conflicts with: v1-turn-tls-trust
```

The code does not overlap. The docs are append-only. The parallel work is
safe. Zelto says no.

**Why this matters beyond one pair.** Every slice in the nimrtc v1.4 line
claims `docs/api/engine_api.md` + `CHANGELOG.md` — nine of the eleven slices
in `version/v3` do. The v1.4 plan §8a.5 explicitly designs for this:

> *"A PR that touches none is mergeable during the window (after `v1.3.0`);
> a PR that touches one names the section it appends to, so the merge order
> is a reading, not a guess."*

The plan **assumes** shared files with per-slice sections are a supported
shape. Zelto cannot express it: `writeSetsOverlap()` compares paths with no
notion of *what kind* of file it is, so any shared path blocks.

**The cost of not fixing it.** Zelto's core value proposition is parallel
agent development ("高速并行"). A two-file documentation overlap collapses
the whole fleet to serial — not because the work conflicts, but because the
tool cannot tell a shared *log* from a shared *source file*.

---

## 2. What already exists (and why it isn't enough)

Zelto already has artifact-category severity in `core/sched/artifact.ts`:

| Category | Severity | Blocking? |
|---|---|---|
| `type_definition` | error | yes |
| `api_contract` | error | yes |
| `schema` | warning | no |
| `config` | warning | no |
| `test_fixture` | info | no |
| `documentation` | info | no |

`core/sched/cross-version.ts` already uses this: `documentation` → `info`
→ **"低风险重叠（docs 类别）提示了但不阻断"** (ADR-056 §3.6, verified on
the real nimrtc project).

**But the two paths that matter for parallelism do not use it:**

- `Scheduler.admit()` (`core/sched/engine.ts:148`) — flat
  `writeSetsOverlap()` → **blocks**.
- `planExecutionPhases()` (`core/sched/batch.ts:493`) — flat
  `writeSetsOverlap()` → **serializes the phase**.

So the codebase contains the right idea in one place and the wrong behavior
in the two places that actually decide whether slices run together. This ADR
makes the two consistent.

---

## 3. Decision

**A shared path is a hard write-set conflict only if it is not an
append-only documentation path.**

Specifically: introduce `writeSetsConflict()` — the conflict predicate used
by `admit()` and `planExecutionPhases()` — which returns the conflicting
paths, treating shared documentation paths as **soft** (reported, not
blocking).

### 3.1 What counts as an append-only documentation path

A path qualifies when **both** hold:

1. It maps to the `documentation` artifact category
   (`core/sched/artifact.ts` `BUILTIN_MAPPINGS`): `docs/**` or `*.md`.
2. It is a **markdown file** (`.md`), **not** a directory glob and **not**
   a pattern that could match code.

Non-qualifying, explicitly:

- `**/*.md` as a *write-set pattern* (a glob that could match any markdown
  in the tree) — a slice claiming `**/*.md` is claiming the whole
  documentation surface; treat as hard conflict.
- `docs/**` as a *write-set pattern* — same reason. A slice that claims the
  whole docs tree is not appending to one file.
- Any non-markdown path under `docs/` (e.g. `docs/api/diagram.svg`) —
  binary or structured content, concurrent writes are not safe.

So the tolerated case is exactly: **two slices both naming the same
concrete `.md` file**.

### 3.2 What does NOT change

- **The write-set reservation (C9) is untouched.** A slice's `writes` still
  lists the doc file; the PreToolUse hook still permits writing it; the
  post-run audit still checks it. This ADR changes **only whether two
  slices may run at the same time**, not what any individual slice may
  write.
- **`pathInWriteSet()` is untouched.** Runtime enforcement still uses it.
- **The protected domain (C5) is untouched.** `policy/**`, `.zelto/**`,
  `AGENTS.md` are still denied by policy and are not documentation-tolerant
  — they are checked by `isProtectedPath()`, which runs **before** any
  write-set logic.
- **Spec files remain managed (ADR-046).** A spec copy in `specs/slices/`
  is `specs/**`, not `docs/**`, and `.md` — but spec files are governed by
  `isZeltoManagedSpecPath()` / the ADR-106 exemption, not by this ADR.
  **To be explicit: `specs/**` is excluded from documentation tolerance.**
  Two slices editing the same spec is a real conflict.

### 3.3 Reporting, not silence

A soft overlap must be **visible**, not silently allowed. The scheduler
writes a `sched.admitted` event carrying the soft-overlap paths, so the
audit trail (C4) records that two slices knowingly shared a doc file.

`zelto batch` reports soft overlaps as `info` issues alongside the existing
`error` write-set overlaps.

---

## 4. Alternatives considered

### 4.1 Curated allowlist of append-only doc paths

A hardcoded list (`CHANGELOG.md`, `docs/api/engine_api.md`, …).

**Rejected.** It is a maintenance trap: every new project's "shared log"
would need an entry, and the list would silently not apply. The criterion
should be a *property of the file*, not a registry of filenames.

### 4.2 Make it configurable in `policy.yaml`

**Rejected for now.** It would be a policy-schema change (contract change,
ADR required) and would put a scheduling decision under policy override.
C5 says the protected domain is hardcoded and not overridable; allowing
policy to weaken conflict detection is in the same spirit of hazard. If a
project needs a tighter rule later, a *stricter* mode (opt-in, deny soft
overlaps) is safer than a looser one.

### 4.3 Let the slice author declare "I only append to this file"

**Rejected.** It trusts an unverifiable claim from the agent, and the
conflict check runs *before* the agent starts. The write-set is the
slice's own declaration already; adding a second, weaker declaration
invites drift.

### 4.4 Keep it serial; fix it in the project (strip the docs from one slice)

**Rejected.** It leaves the tool unable to express the v1.4 plan's own
§8a.5 rule, and it pushes every project to under-declare its write-set to
work around a tool limitation. Under-declaring a write-set is exactly what
C9's runtime enforcement catches — the workaround creates a different bug.

---

## 5. Consequences

**Positive**

- Slices whose only overlap is a shared append-only doc can run in
  parallel — which is the common case in any project that keeps a
  changelog and an API reference.
- The three conflict paths (admit / batch phases / cross-version) finally
  agree on what "conflict" means.

**Negative / risks**

- Two agents appending to the same markdown file **can** interleave badly:
  agent A's bullet and agent B's bullet end up adjacent, and if both
  rewrite the same section header, the merge shows a conflict.
  Mitigation: this is a **git merge** conflict, visible at merge time, and
  Zelto merges sequentially (§8a.5's "merge order is a reading, not a
  guess"). It is a merge-time nuisance, not a silent corruption of code.
- The `documentation` category is broader than "append-only". A `.md` file
  under `docs/` that is *rewritten* rather than appended to (e.g. a
  generated API reference) would now be treated as soft. **Accepted
  risk**: the merge still surfaces a conflict, and the plan's convention
  is append-style sections.

**Neutral**

- `writeSetsOverlap()` keeps its current signature and semantics for
  existing callers; the new predicate is additive. Callers that want the
  strict behavior (e.g. the reservation-free `checkConflicts()` helper)
  keep using it.

---

## 6. Implementation

New in `core/sched/paths.ts`:

```typescript
/**
 * 是否是「可并行的共享文档」路径（ADR-107）。
 *
 * 判据：具体的 markdown 文件，且落在文档目录或根级 md。
 * glob 形态（`**/*.md`、`docs/**`）**不算** —— 那是在声称整片文档面。
 */
export function isAppendOnlyDocPath(path: string): boolean;

/**
 * 两个写集之间是否存在**硬冲突**（ADR-107）。
 *
 * 共享的 append-only 文档路径不算硬冲突 —— 它会被报出来，但**不拦**。
 */
export function writeSetsConflict(
  a: string[],
  b: string[],
): { hard: string[]; soft: string[] };
```

Call sites changed:

| File | Change |
|---|---|
| `core/sched/engine.ts` (`admit`) | use `writeSetsConflict`; block on `hard` only; record `soft` in the `sched.admitted` event |
| `core/sched/batch.ts` (`planExecutionPhases`) | group by `hard` overlap; record soft overlaps in `downgrades` as `severity: info` |
| `core/sched/batch.ts` (`evaluateBatchConflicts`) | report soft overlaps as `info` issues, hard as `error` |

**Explicitly not changed**: `pathInWriteSet`, `pathMatches`,
`writeSetsOverlap` (kept for strict callers), the reservation store, the
policy engine, `isProtectedPath`.

---

## 7. Verification

1. Two slices sharing only `CHANGELOG.md` → `admit()` returns `admitted`,
   and the `sched.admitted` event lists the soft-overlap path.
2. Two slices sharing `src/engine/src/engine.cpp` → `admit()` returns
   `blocked` with `blockedBy` (unchanged).
3. Two slices sharing `**/*.md` (glob) → `blocked` (glob is not tolerated).
4. Two slices sharing `specs/slices/x.md` → `blocked` (specs excluded).
5. `policy/**` is still denied by policy regardless (C5).
6. The reservation a running slice holds still covers its doc file; the
   hook still permits writing it (C9 unchanged).
7. `planExecutionPhases()` puts the two doc-sharing slices in the **same**
   phase; slices with a code overlap land in **different** phases.
8. All existing Zelto unit tests still pass.

---

## 8. Relation to existing ADRs

- **ADR-012** (parallel coordination) — this ADR refines its write-set
  overlap rule for one class of path. The `error`/`info` severity model
  already existed there; this ADR applies it to the within-batch paths.
- **ADR-019** (phased execution) — phase assignment now distinguishes
  hard from soft overlap, so the "merge order is a reading" property of
  §8a.5 becomes expressible.
- **ADR-024** (affinity scheduling) — unchanged; affinity is a *read-only
  hint* layered on top of the phase plan.
- **ADR-046 / ADR-106** (spec file management) — unchanged; spec copies
  are governed separately and are explicitly **excluded** here.
- **ADR-056** (version branches, §3.6) — this ADR makes the within-batch
  behavior match what cross-version detection already does.

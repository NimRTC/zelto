// 验收测试 —— v1-sign-review-core（核心判定：共享类型与纯函数评估）
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行，不经过 tsc 编译：
//   node --test tests/acceptance/v1-sign-review-core/acceptance.test.cjs
//
// 被测的是 src/core/sign-review/ 的纯函数判定。TS 源文件不能直接被 node
// 执行，所以这里 require() 编译产物：优先 dist-test/（`pnpm test` 每次重建；
// 门禁先跑 pnpm test 再跑本文件，产物一定新鲜），退回 dist/（`pnpm build`）。
//
// 判定语义见 specs/slices/v1-sign-review-core.md 与 ADR-070 §5：
// evaluateSignChecks(facts) 是纯函数 —— 只读入参、不碰文件、不跑 git、
// 不调模型、不触网（C3），同一份 facts 永远得到同一份结果。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

// tests/acceptance/v1-sign-review-core/ → 上三层是工作区根
const ROOT = resolve(__dirname, '..', '..', '..');
const TYPES_SRC = join(ROOT, 'src', 'core', 'sign-review', 'types.ts');
const EVALUATE_SRC = join(ROOT, 'src', 'core', 'sign-review', 'evaluate.ts');

// 编译产物定位：dist-test/（pnpm test 重建）优先，dist/（pnpm build）兜底。
const EVALUATE_MODULE = [
  join(ROOT, 'dist-test', 'src', 'core', 'sign-review', 'evaluate.js'),
  join(ROOT, 'dist', 'core', 'sign-review', 'evaluate.js'),
].find((p) => existsSync(p));
if (!EVALUATE_MODULE) {
  throw new Error('找不到编译产物（dist-test/ 或 dist/）—— 请先运行 `pnpm test` 或 `pnpm build`');
}
const { evaluateSignChecks } = require(EVALUATE_MODULE);

/** 一份「全部通过」的签字复查事实（ADR-070 §5.1 的完整形状） */
function passingFacts(overrides = {}) {
  return {
    sliceId: 'v1-sign-review-core',
    sliceState: 'signed',
    trace: {
      requirements: ['R1 验收标准逐条可追溯'],
      contracts: ['contracts/schemas/slice.json'],
      tests: ['tests/acceptance/v1-sign-review-core/acceptance.test.cjs'],
    },
    gate: { acceptanceRan: true, acceptancePassed: true, passCount: 6, totalCount: 6 },
    diff: {
      baseRef: 'abc1234',
      baseNote: '切片冻结时的基点 abc1234',
      filesChanged: 3,
      addedLines: 120,
      deletedLines: 6,
      files: [],
    },
    cost: { totalUsd: 1.23 },
    stall: { stalled: false, stallClass: null },
    writeSetAudit: { violations: [] },
    artifact: { status: 'in-trunk', path: 'dist/core/sign-review/evaluate.js', hash: 'abc123', note: null },
    ...overrides,
  };
}

/** 按 label 取确认项，便于断言「只坏一项、其余仍通过」 */
function byLabel(checks) {
  return Object.fromEntries(checks.map((c) => [c.label, c]));
}

/** 取某个 interface 的声明体（从 `{` 到顶层 `}`），把字段检查限定在声明体内 */
function interfaceBody(src, name) {
  const head = src.indexOf(`export interface ${name}`);
  assert.notEqual(head, -1, `types.ts 应定义并导出 interface ${name}`);
  const open = src.indexOf('{', head);
  const close = src.indexOf('\n}', open);
  assert.notEqual(open, -1, `interface ${name} 应有 {`);
  assert.notEqual(close, -1, `interface ${name} 应有配对的顶层 }`);
  return src.slice(open, close);
}

/** 断言 interface 声明体里出现了全部指定字段名 */
function hasFields(body, fields) {
  for (const field of fields) {
    assert.match(body, new RegExp(`\\b${field}\\b`), `interface 应声明字段 ${field}`);
  }
}

test('types.ts 定义并导出 SignReviewFacts 与 SignCheck（含全部事实字段与三态产物证据）', () => {
  const src = readFileSync(TYPES_SRC, 'utf8');

  // 切片标识与状态 + trace 三元组 + gate 结果 + diff 统计 + 成本聚合
  // + 停机摘要 + 写集审计结论 + 产物证据（全在 SignReviewFacts 声明体内）
  const reviewBody = interfaceBody(src, 'SignReviewFacts');
  hasFields(reviewBody, ['sliceId', 'sliceState']);
  hasFields(reviewBody, ['trace', 'requirements', 'contracts', 'tests']);
  hasFields(reviewBody, ['gate', 'acceptanceRan', 'acceptancePassed', 'passCount', 'totalCount']);
  hasFields(reviewBody, ['diff', 'filesChanged', 'addedLines', 'deletedLines']);
  hasFields(reviewBody, ['cost', 'totalUsd']);
  hasFields(reviewBody, ['stall', 'stalled', 'stallClass']);
  hasFields(reviewBody, ['writeSetAudit']);
  hasFields(interfaceBody(src, 'WriteSetAuditFacts'), ['violations']);
  hasFields(reviewBody, ['artifact']);

  // 产物证据三态 in-trunk | not-in-trunk | unknown（ADR-059/061 语义）
  assert.match(
    src,
    /export\s+type\s+ArtifactEvidenceStatus\s*=\s*'in-trunk'\s*\|\s*'not-in-trunk'\s*\|\s*'unknown'/,
    'ArtifactEvidenceStatus 应为三态 in-trunk | not-in-trunk | unknown',
  );
  hasFields(interfaceBody(src, 'ArtifactEvidence'), ['status', 'path', 'hash', 'note']);

  // SignCheck 形状 { label, ok, evidence, adrRef }
  hasFields(interfaceBody(src, 'SignCheck'), ['label', 'ok', 'evidence', 'adrRef']);

  // 零导入：types.ts 只放类型，不 import 任何模块（切片风险：与 evaluate.ts 循环依赖）
  assert.doesNotMatch(src, /^\s*import\b/m, 'types.ts 应零导入（只放类型）');

  // 运行时形状：完整 facts 能交给 evaluateSignChecks 且得到四项确认项，
  // 证明这组字段形状被判定端认可（类型层面的编译正确由门禁的 pnpm test 把关）。
  assert.equal(typeof evaluateSignChecks, 'function');
  assert.equal(evaluateSignChecks(passingFacts()).length, 4);
});

test('evaluate.ts 导出纯函数 evaluateSignChecks，输出四项确认项，且源码无 IO/网络/时间/随机/console（C3）', () => {
  const src = readFileSync(EVALUATE_SRC, 'utf8');

  // 导出纯函数（含类型签名）
  assert.match(src, /export\s+function\s+evaluateSignChecks\s*\(facts:\s*SignReviewFacts\):\s*SignCheck\[\]/, 'evaluate.ts 应导出 evaluateSignChecks(facts: SignReviewFacts): SignCheck[]');
  assert.equal(typeof evaluateSignChecks, 'function');

  // 全通过 facts → 四项确认项，顺序固定：追溯→验收→写集→产物
  const checks = evaluateSignChecks(passingFacts());
  assert.equal(checks.length, 4);
  assert.deepEqual(checks.map((c) => c.label), ['追溯链未断', '验收真跑过本片', '改动在写集内', '产物真落地']);

  // grep 无命中：fs|child_process|execFile|fetch|http|Date.now|Math.random|console.
  // （验收标准 2 的判据：判定里不得混入 IO/时间/随机/console —— C3 可复现性）
  const forbidden = /(fs|child_process|execFile|fetch|http|Date\.now|Math\.random|console\.)/;
  const hits = src
    .split('\n')
    .map((line, i) => ({ lineNumber: i + 1, line }))
    .filter(({ line }) => forbidden.test(line));
  assert.deepEqual(hits, [], 'evaluate.ts 不得含 IO/网络/时间/随机/console 记号');

  // 不导入 src/cli/ 下任何模块（判定层不得依赖 CLI 实现）
  for (const stmt of src.match(/import[^;]+;/g) ?? []) {
    assert.doesNotMatch(stmt, /cli/, `evaluate.ts 不得导入 src/cli/ 下任何模块：${stmt.trim()}`);
  }
});

test('四项确认项各有一条 ADR 锚点（追溯→ADR-060/032，验收→ADR-033/051，写集→ADR-014，产物→ADR-059/061）', () => {
  const checks = evaluateSignChecks(passingFacts());
  assert.equal(checks.length, 4);

  // 全通过：四条全部 ok === true，四条 adrRef 均非空
  for (const c of checks) {
    assert.equal(c.ok, true, `${c.label} 应通过`);
    assert.ok(c.adrRef.length > 0, `${c.label} 的 adrRef 应非空`);
    assert.ok(c.evidence.length > 0, `${c.label} 的 evidence 应非空`);
  }

  // 各条 adrRef 指向 ADR-070 §5.2 的判据来源
  const by = byLabel(checks);
  assert.equal(by['追溯链未断'].adrRef, 'ADR-060/032');
  assert.equal(by['验收真跑过本片'].adrRef, 'ADR-033/051');
  assert.equal(by['改动在写集内'].adrRef, 'ADR-014');
  assert.equal(by['产物真落地'].adrRef, 'ADR-059/061');
});

test('产物证据为 unknown 时不谎报失败：ok=false 但 evidence 明示「未知、未核对」，不得写成「产物不在主干」', () => {
  const checks = evaluateSignChecks(
    passingFacts({
      artifact: { status: 'unknown', path: null, hash: null, note: 'HEAD 读不到或非 git 仓库等' },
    }),
  );
  const artifact = byLabel(checks)['产物真落地'];

  assert.equal(artifact.ok, false, 'unknown 应判为未确认（ok=false）');
  assert.match(artifact.evidence, /未知|unknown/i, 'evidence 必须明示「未知 / unknown」');
  assert.doesNotMatch(artifact.evidence, /产物不在主干/, '不得把 unknown 写成「产物不在主干」');
});

test('阴性对照四种失败各一组断言：trace 为空→追溯项失败；gate 无 acceptance 记录→验收项失败；violations 非空→写集项失败；artifact 为 not-in-trunk→产物项失败；且每次只坏一项时其余三项仍通过', () => {
  const otherThree = (brokenLabel) => ['追溯链未断', '验收真跑过本片', '改动在写集内', '产物真落地'].filter((l) => l !== brokenLabel);

  // ① trace 为空 → 追溯项失败
  let r = byLabel(
    evaluateSignChecks(passingFacts({ trace: { requirements: [], contracts: [], tests: [] } })),
  );
  assert.equal(r['追溯链未断'].ok, false, 'trace 为空时追溯项应失败');
  for (const label of otherThree('追溯链未断')) assert.equal(r[label].ok, true, `${label} 应仍通过`);

  // ② gate 无 acceptance 记录 → 验收项失败
  r = byLabel(
    evaluateSignChecks(passingFacts({ gate: { acceptanceRan: false, acceptancePassed: false, passCount: 0, totalCount: 0 } })),
  );
  assert.equal(r['验收真跑过本片'].ok, false, 'gate 无 acceptance 记录时验收项应失败');
  for (const label of otherThree('验收真跑过本片')) assert.equal(r[label].ok, true, `${label} 应仍通过`);

  // ③ violations 非空 → 写集项失败
  r = byLabel(evaluateSignChecks(passingFacts({ writeSetAudit: { violations: ['src/evil.ts'] } })));
  assert.equal(r['改动在写集内'].ok, false, 'violations 非空时写集项应失败');
  for (const label of otherThree('改动在写集内')) assert.equal(r[label].ok, true, `${label} 应仍通过`);

  // ④ artifact 为 not-in-trunk → 产物项失败
  r = byLabel(
    evaluateSignChecks(passingFacts({ artifact: { status: 'not-in-trunk', path: null, hash: null, note: null } })),
  );
  assert.equal(r['产物真落地'].ok, false, 'artifact 为 not-in-trunk 时产物项应失败');
  for (const label of otherThree('产物真落地')) assert.equal(r[label].ok, true, `${label} 应仍通过`);
});

test('纯函数可复现：同一份 facts 连续调用三次返回 deepStrictEqual 相等，且冻结入参后调用不抛 TypeError', () => {
  // 同一份 facts 连续调用三次 → 结果 deepStrictEqual 相等
  const facts = passingFacts();
  const first = evaluateSignChecks(facts);
  const second = evaluateSignChecks(facts);
  const third = evaluateSignChecks(facts);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);

  // 深度冻结入参后调用：不得抛 TypeError（判定不得修改入参）
  function deepFreeze(obj) {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value !== null && typeof value === 'object') deepFreeze(value);
    }
    return Object.freeze(obj);
  }
  const frozen = deepFreeze(passingFacts());
  assert.doesNotThrow(() => evaluateSignChecks(frozen));

  // 冻结后的结果与未冻结时一致 —— 纯计算不依赖任何可变状态
  assert.deepEqual(evaluateSignChecks(frozen), first);
});

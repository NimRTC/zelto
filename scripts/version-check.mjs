#!/usr/bin/env node
// 版本与依赖一致性校验 —— 发布前的最后一道闸。
//
// 挂在 prepublishOnly 上（ADR-108）。不一致时以非零退出码阻断发布，
// 保证发布制品与仓库声明一致。
//
// ── 为什么校验的是 pnpm 锁文件，而不是 npm 锁文件（ADR-108 决策一）──
//
// 这个仓库是 **pnpm 仓库**：
//   - package.json 的 packageManager: "pnpm@9.12.0"
//   - CI 全部用 pnpm install --frozen-lockfile
//   - 真锁文件是 pnpm-lock.yaml
//
// 历史上这里校验的是 package-lock.json —— 但那个文件是 agent 从 pnpm 的
// 本地 store 造出来的**假锁文件**（resolved 指向 ../../../node_modules/.pnpm/...，
// 且零个 integrity），npm ci 在别的机器上必然失败。
// 详见 docs/adr-108-version-check-pnpm-lockfile.md 与缺陷记录 §ZD-037。
//
// ── 为什么不是「比根包版本号」──
//
// pnpm 锁文件（lockfileVersion 9.x）**不记录根包版本**。实测：
//
//   importers:
//     .:
//       dependencies:
//         js-yaml:
//           specifier: ^5.5.0
//           version: 5.5.0
//
// 只有依赖的 specifier 与解析后的版本，没有根包版本字段。
// 所以「根包版本一致性」在 pnpm 锁文件上**没有对应物**。
//
// 根包版本由 package.json 单点定义（发布流水线另有一步校验
// tag 版本与 package.json 一致），不需要第二个文件重复守。
//
// ── 那这条脚本守什么 ──────────────────────────────────────────────────
//
// 守**依赖声明的一致性**：package.json 里声明的依赖，
// 必须与 pnpm-lock.yaml 的 importers['.'] 逐条对得上。
//
// 判据（每一条都必须成立）：
//   ① package.json 的每个 dependency / devDependency，
//      在锁文件的 importers['.'] 里必须存在；
//   ② specifier 必须与 package.json 里的版本范围**逐字相同**；
//   ③ package.json 里没有、锁文件里有的依赖 → 也要报出来
//      （多出来的 = 锁文件是旧的）。
//
// 这比原来那条更强：原断言只比一个版本号字符串；
// 新断言逐条比对所有依赖的 specifier。
//
// 而且它比 `pnpm install --frozen-lockfile` 更早发现漂移：
// --frozen-lockfile 是**安装时**才发现（那时已经装了半个依赖树），
// 本脚本是**发布前**、**装任何东西之前**就发现。
//
// ── 脚本只读，不修改任何文件（验收标准）──
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 列出仓库里的**发布锚点** tag（纯 semver 形态 `v<major.minor.patch>`）。
 *
 * 只取这一种形态 —— 版本锚点（`plan-<planId>/v<n>`）是历史，
 * 不参与版本一致性判定（ADR-110 决策四）。
 */
function listSemverTags() {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^v\d+\.\d+\.\d+$/.test(s));
  } catch {
    // 不是 git 仓库 / git 不可用 —— 那就没有发布锚点可校，
    // 不该因为「列不出 tag」而阻断发布。
    return [];
  }
}

function fail(message) {
  console.error(`[version-check] 失败：${message}`);
  process.exit(1);
}

/**
 * 加载 YAML 解析器。
 *
 * 为什么用动态 import 而不是顶层 `import { load } from 'js-yaml'`：
 * 顶层 import 在**模块解析阶段**就会失败 —— 也就是说 `js-yaml` 装不上时，
 * 抛出的是 Node 的 ERR_MODULE_NOT_FOUND 堆栈，**没有一句人话**。
 * 而这个脚本的职责就是「发布前把话说清楚」，它自己却先崩在堆栈里，
 * 那说不过去。
 *
 * `js-yaml` 是 package.json 的运行时依赖（`dependencies`，不是 devDependencies），
 * 所以正常发布流程里它一定在。
 */
async function loadYamlParser() {
  try {
    const mod = await import('js-yaml');
    const load = mod.load ?? mod.default?.load;
    if (typeof load !== 'function') {
      fail('js-yaml 加载了，但它没有导出 load() 函数 —— 版本不对？');
    }
    return load;
  } catch (err) {
    fail(
      `加载 js-yaml 失败：${err instanceof Error ? err.message : String(err)}\n` +
        `它是本仓库的运行时依赖，正常情况下应该在 node_modules 里 —— ` +
        `跑一次 pnpm install 再试。`,
    );
  }
}

// ── 1. 读 package.json ────────────────────────────────────────────────
//
// **从 cwd 读，不是从脚本所在目录读。**
//
// 为什么：cwd 才是「正在被校验的那个项目」。
// 从脚本位置读，等于「永远在校验 zelto 自己」——
// 换个项目跑这个脚本，它报的永远是 zelto 的版本号，**判据就废了**。
//
// （脚本本身装在 zelto 仓里，但它的职责是校验**别的**仓库 ——
//  npm 发布流水线在别的仓库里也调它。）
const pkgPath = join(process.cwd(), 'package.json');
if (!existsSync(pkgPath)) {
  fail(`找不到 ${pkgPath}（cwd = ${process.cwd()}）。`);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// ── 2. 读 pnpm-lock.yaml ──────────────────────────────────────────────

const lockPath = join(process.cwd(), 'pnpm-lock.yaml');
if (!existsSync(lockPath)) {
  fail(`找不到 ${lockPath}（本仓库用 pnpm，真锁文件是它）。`);
}

const parseYaml = await loadYamlParser();

let lock;
try {
  lock = parseYaml(readFileSync(lockPath, 'utf8'));
} catch (err) {
  fail(`解析 ${lockPath} 失败：${err instanceof Error ? err.message : String(err)}`);
}

if (!lock || typeof lock !== 'object') {
  fail(`解析 ${lockPath} 得到的结果不是对象（可能是空文件）。`);
}

// 锁文件格式版本 —— 只认 9.x。老格式的 importers 结构不同，
// 判据不能直接套（否则会误报一片「依赖对不上」）。
const lockfileVersion = lock.lockfileVersion;
if (typeof lockfileVersion !== 'string' && typeof lockfileVersion !== 'number') {
  fail(`读不到 ${lockPath} 的 lockfileVersion。`);
}
const lockMajor = Number.parseInt(String(lockfileVersion), 10);
if (!Number.isFinite(lockMajor) || lockMajor < 9) {
  fail(
    `${lockPath} 的 lockfileVersion=${lockfileVersion}，本脚本只支持 9.x —— ` +
      `老格式的 importers 结构不同，判据不能直接套。`,
  );
}

const importers = lock.importers;
if (!importers || typeof importers !== 'object') {
  fail(`${lockPath} 里没有 importers 段（不是 pnpm 锁文件？）。`);
}
const rootImporter = importers['.'];
if (!rootImporter || typeof rootImporter !== 'object') {
  fail(`${lockPath} 的 importers 里没有 "." 段（找不到根包的依赖声明）。`);
}

/**
 * 把锁文件里的 importers['.'] 摊平成「依赖名 → specifier」。
 *
 * pnpm 的结构是 `dependencies` / `devDependencies` / `optionalDependencies`
 * 三段，每段下面是「名字 → { specifier, version }」。
 *
 * 为什么摊平：package.json 里也有 `dependencies` / `devDependencies` 两段。
 * 摊平之后比对的是「**依赖名集合**」而不是「分段结构」——
 * 分段（依赖 vs 开发依赖）在两边可能不一致，而**版本范围必须一致**。
 * 依赖类型归 pnpm 管（它按 importers 的段决定装不装 devDependencies），
 * 本脚本只守**声明的版本范围**对不对。
 */
function collectDeclared(segments) {
  const out = new Map();
  for (const segment of segments) {
    const group = rootImporter[segment];
    if (!group || typeof group !== 'object') continue;
    for (const [name, entry] of Object.entries(group)) {
      if (!entry || typeof entry !== 'object') continue;
      const specifier = entry.specifier;
      if (typeof specifier !== 'string') continue;
      // 同一个名字出现在两段里 → 记下来冲突（下面单独报错）
      if (out.has(name)) {
        out.get(name).conflict = true;
        continue;
      }
      out.set(name, { specifier, segment, conflict: false });
    }
  }
  return out;
}

const lockDeclared = collectDeclared([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

if (lockDeclared.size === 0) {
  fail(`${lockPath} 的 importers["."] 里一条依赖声明都没有 —— 锁文件不完整。`);
}

// ── 3. 比对 package.json ↔ pnpm-lock.yaml ─────────────────────────────

const pkgDeclared = new Map();
for (const segment of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  const group = pkg[segment];
  if (!group || typeof group !== 'object') continue;
  for (const [name, range] of Object.entries(group)) {
    if (typeof range !== 'string') continue;
    pkgDeclared.set(name, { range, segment });
  }
}

/** 不一致的问题清单（每条都能独立看懂） */
const problems = [];

for (const [name, decl] of pkgDeclared) {
  const locked = lockDeclared.get(name);
  if (!locked) {
    problems.push(
      `依赖 "${name}"（${decl.segment}，${decl.range}）在 pnpm-lock.yaml 的 importers["."] 里没有 —— ` +
        `锁文件是旧的，跑 pnpm install --frozen-lockfile 会失败。`,
    );
    continue;
  }
  if (locked.conflict) {
    problems.push(
      `依赖 "${name}" 在 pnpm-lock.yaml 里出现在多个段（dependencies / devDependencies / optionalDependencies）—— ` +
        `锁文件内部就有歧义。`,
    );
    continue;
  }
  if (locked.specifier !== decl.range) {
    problems.push(
      `依赖 "${name}" 的版本范围对不上：` +
        `package.json 写的是 ${decl.range}，pnpm-lock.yaml 里是 ${locked.specifier}。`,
    );
  }
}

// 反向：锁文件里有、package.json 里没有 → 锁文件是旧的
for (const [name, locked] of lockDeclared) {
  if (pkgDeclared.has(name)) continue;
  if (locked.conflict) continue;
  problems.push(
    `pnpm-lock.yaml 里还有依赖 "${name}"（${locked.specifier}），但 package.json 里已经没有它了 —— ` +
      `锁文件是旧的。`,
  );
}

if (problems.length > 0) {
  fail(
    `package.json 与 pnpm-lock.yaml 的依赖声明不一致（${problems.length} 处）：\n` +
      problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n'),
  );
}

// ── 4. 反向断言：不允许存在 npm 锁文件（ADR-108 决策四）────────────
//
// 这条是**最关键**的一条断言 —— 它直接锁住「不再造 npm 锁文件」这个决定。
//
// 为什么必须有反向断言：这次的失败模式是「agent 造了一个看起来对的
// 假文件，而验收只查了字段」。**只写正向断言，下一个 agent 还能再造一个。**
//
// 存在的 npm 锁文件在 pnpm 仓库里是**纯负债**：
//   - 它的 resolved 指向 npm registry 或 pnpm 本地 store，
//     两边都不对；
//   - 两套锁文件必然漂 —— 而这个脚本的存在意义就是防漂。
const npmLockPath = join(process.cwd(), 'package-lock.json');
if (existsSync(npmLockPath)) {
  fail(
    `仓库里存在 ${npmLockPath} —— 本仓库用 pnpm，真锁文件是 pnpm-lock.yaml。` +
      `两套锁文件会漂（而本脚本的存在意义就是防漂）。请删掉它。`,
  );
}

// ── 5. npm-shrinkwrap.json 同理 ──────────────────────────────────────
//
// npm-shrinkwrap.json 比 package-lock.json 更强：npm **优先**用它，
// 存在时 package-lock.json 会被忽略。所以它一旦出现，
// 装出来的依赖树就完全不受 pnpm-lock.yaml 控制。
const shrinkwrapPath = join(process.cwd(), 'npm-shrinkwrap.json');
if (existsSync(shrinkwrapPath)) {
  fail(
    `仓库里存在 ${shrinkwrapPath} —— npm 优先用它（会忽略 package-lock.json），` +
      `装出来的依赖树就不受 pnpm-lock.yaml 控制了。请删掉它。`,
  );
}

// ── 6. 发布锚点的版本一致性（ADR-110 决策四）────────────────────────
//
// **这条判据从 tag-namespace.mjs 搬到了这里。**
//
// 为什么搬：ADR-110 把 tag 分成两个轴 ——
//
//   plan-<planId>/v<n>   版本锚点（某个计划的某版做完时的产物汇聚点）
//   v<semver>            发布锚点（发到 npm 的那一版）
//
// 「发的包必须 == 当前要发的版本」只对**发布锚点**有意义。
// 版本锚点是**历史** —— 它不该因为 `package.json` 升版就失效
// （旧规则 `plan-<semver>/v<n>` 就是因为绑死了 semver，
// 导致升版当天所有历史 tag 全部变非法，发布闸门被锁死）。
//
// 而「发布锚点版本必须 == package.json」这件事，本脚本本来就在管
// `package.json` 的一致性 —— **版本号的一致性归它管，才叫同源**
// （ADR-106 §5：同一问题只能有一处判定）。
//
// ── 判据的精确形状 ─────────────────────────────────────────────────
//
// **要拦的是一件事**：仓库的 `package.json` 版本 **低于** 已经发出去的版本。
//
//   package.json = 0.6.0，但 npm 上已经有 v0.7.1 了
//   → package.json 落后了。下一次发版会把 0.6.0 当成「新版本」发出去，
//     而 npm 上 0.7.1 已经在那里 —— **发出去的包比已发布的旧**。
//
// **不是**「每个发布锚点都要等于当前版本」—— 那是错的：
// `v0.3.0` / `v0.4.0` / `v0.5.0` 是**过去**发出去的版本，
// 它们当然小于当前的 `0.7.1`。若那样判，这个脚本**永远跑不过**。
//
// **也不是**「最新的发布锚点必须等于当前版本」—— 那也错：
// 0.7.1 还没发到 npm（`release-status.json` 的 `published: false`），
// 所以「最新的发布锚点」是 `v0.6.0`，它与 `0.7.1` 不等是**正常的**。
// 那样判等于**逼着人先发版才能跑预检** —— 循环依赖。
//
// 所以判据是**单向**的：`package.json` 的版本必须 **>=** 最高的发布锚点版本。
// 版本**更高**（准备发新版）→ 放行（那正是发布的正常状态）。
// 版本**更低**（仓库落后于已发布）→ 拦下。
//
// 为什么这条不空转：它拦的是**真的发生过**的状态漂移
// （回滚了 package.json 却没回滚发布状态、或者并行分支改了版本号）。
const currentSemver = /^(\d+\.\d+\.\d+)/.exec(pkg.version || '');
const currentVersion = currentSemver ? currentSemver[1] : pkg.version;
const semverTags = listSemverTags();

if (semverTags.length > 0 && currentSemver) {
  // 逐段按数值比（字符串排序会把 v0.10.0 排在 v0.9.0 前面）。
  const parse = (t) => t.replace(/^v/, '').split('.').map(Number);
  const current = parse(currentVersion);

  let highest = null;
  let highestTag = null;
  for (const tag of semverTags) {
    const parts = parse(tag);
    if (
      highest === null ||
      parts[0] > highest[0] ||
      (parts[0] === highest[0] && parts[1] > highest[1]) ||
      (parts[0] === highest[0] && parts[1] === highest[1] && parts[2] > highest[2])
    ) {
      highest = parts;
      highestTag = tag;
    }
  }

  const pkgIsBehind =
    current[0] < highest[0] ||
    (current[0] === highest[0] && current[1] < highest[1]) ||
    (current[0] === highest[0] && current[1] === highest[1] && current[2] < highest[2]);

  if (pkgIsBehind) {
    fail(
      `package.json 的 version ${currentVersion} **低于**已发布的发布锚点 tag "${highestTag}"` +
        `（${highest.join('.')}）—— 仓库版本落后于已发布的版本。` +
        `下一次发布会把 ${currentVersion} 当成新版本发出去，而 ${highest.join('.')} 已经在 npm 上。` +
        `请把 package.json 的 version 提到 ${highest.join('.')} 或更高。`,
    );
  }
}

// ── 7. 全部一致 ──────────────────────────────────────────────────────

console.log(
  `[version-check] 通过：package.json 与 pnpm-lock.yaml 的 ${pkgDeclared.size} 条依赖声明一致` +
    `，package.json 版本 ${currentVersion} 不低于已发布的 ${semverTags.length} 个发布锚点 tag` +
    `（${semverTags.join('、') || '无'}）。`,
);
process.exit(0);

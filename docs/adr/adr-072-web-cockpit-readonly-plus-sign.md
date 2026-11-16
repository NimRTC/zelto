# ADR-072: Web 驾驶舱（ADR-010 的落地版）

**状态**: 已接受
**日期**: 2026-11-16
**作者**: 架构
**关联**: ADR-010（提案，2026-10-30）、ADR-018、ADR-056、ADR-070、ADR-059/061
**关联约束**: C1、C2、C3、C4、C5、C7、C9

---

## 1. 摘要

实现 ADR-010 提议的浏览器端界面，但**收窄写操作范围**并**修掉 ADR-010 的 CSRF 漏洞**。

形态：`zelto web` 起一个只绑定 `127.0.0.1` 的 `node:http` 服务，
提供**只读驾驶舱**（切片总览 / 切片详情 / 事件流 / 审计 / 签字复查）
与**唯一的一个写操作**：人在浏览器里**看完事实再签字**。

**与 ADR-010 的差别只有两处，且都是收窄，不是扩张。**

---

## 2. 为什么在 ADR-010 之后又写一份

ADR-010 写于 2026-10-30，状态是「提案」，从未落地。三个月里代码走得很远：

- ADR-056（版本分支）改变了「合进哪里」的语义；
- ADR-070（签字复查）已经做出一份**结构化的签字前事实**，
  它的 `SignReviewFacts` + `SignCheck` 就是 Web UI 该复用的那份契约；
- ADR-059/061（产物证据三态）把「产物在不在主干」的判据定死了。

所以 ADR-010 的 §5.3 端点表、§13.3 示例代码、§4.1 复用表**已经过期**。
本 ADR 不是推翻 ADR-010，而是**在它过时的部分上给出落地时的实际决定**。

---

## 3. 硬伤：ADR-010 §9 的 CSRF 缓解措施是错的

ADR-010 §9 写：

| 风险 | 缓解措施 |
|---|---|
| CSRF | 无 session/cookie，fetch 调用无副作用问题 |

**这句话把因果说反了。** 「无 session/cookie」不是缓解措施，
**它恰恰是 CSRF 成立的前提**。

CSRF（跨站请求伪造）的机制是：浏览器对目标站自动附带凭据。
如果目标站**不要求**任何浏览器无法猜测的凭据，那么
**任何第三方网页**都能让访问者的浏览器向 `127.0.0.1:4321` 发出请求，
且浏览器会认为这是同源请求（`Same-Origin-Policy` 只拦**读**响应，
不拦**发**请求）。

具体到 ADR-010 §5.3 的端点表：

```
POST /api/sign-requests/:id/approve
```

任意一个网页只要写着：

```html
<script>
  fetch('http://127.0.0.1:4321/api/sign-requests/<某片>/approve', { method: 'POST' })
</script>
```

就会在访问者打开那个网页的瞬间，**替他把这一片签了字**。
而签字是 zelto 里唯一「人行使的权力」——签字之后 `zelto merge` 就能合入主干。

**这不是「多一个入口」的代价，这是把人的签字权交给任何一个网页。**

### 本 ADR 的修法

**双因子**：请求必须同时满足

1. **启动时生成的会话 token**（`crypto.randomBytes(32)`），
   由服务端注入 HTML 页面；写操作必须在 `X-Zelto-Token` 头里带上它。
   第三方网页读不到本页内容（`Same-Origin-Policy` 拦读），
   所以拿不到 token —— **除非 CORS 放行，而本服务从不发 `Access-Control-Allow-Origin`**。
2. **`Origin` 校验**：写操作要求 `Origin` 为空（同源导航/`curl`）
   或等于本服务的 `http://127.0.0.1:<port>`。

两者任一不过 → `403`，且**不执行任何写操作**。

> **为什么不用「只绑 127.0.0.1」当安全措施**：那防的是**网络可达性**，
> 不是**浏览器可达性**。攻击者不需要能连到你的机器 ——
> 他只需要让**你的浏览器**替他连。

---

## 4. 硬伤：写操作范围与「一键批准」禁区

AGENTS.md 禁区明列：**「一键批准」**。ADR-010 §5.4 的签名审批页是：

```
┌─ slice-001 ────────────────────────────────┐
│  [✓ 批准]  [✗ 拒绝]                          │
└──────────────────────────────────────────────┘
```

**在浏览器里，这就是一键批准。** CLI 里的 `zelto sign --approve`
至少还是个显式命令；网页上的一个按钮连命令都不是。

### 本 ADR 的收窄

Web UI **不做**这些（ADR-010 §5.3 里有，本 ADR 砍掉）：

| 端点 | 砍掉理由 |
|---|---|
| `POST /api/slices/:id/run` | 会启动 agent 进程。`run` 有大量前置（写集预约、门禁①、worktree 准备），**HTTP 请求不该有副作用地启动另一个进程**。且长时间运行的操作不适合同步请求。 |
| `POST /api/slices/:id/admit`、`/gate` | 门禁是同步判定，但**触发门禁 = 发起一次执行**。CLI 侧已有完整实现（`core/gate/executor.ts`），Web 侧再实现一份会**分叉判定**（C3 的隐患）。 |
| `POST /api/slices/:id/freeze`、`/clarify` | 同上：都有 CLI 侧的完整实现，且 freeze 会改切片状态文件 —— 状态变更必须走同一条代码路径，否则两个实现会漂移。 |
| `POST /api/slices/:id/abandon`、`/resume` | 状态机变更。`core/slice/state.ts` 的 `transitionSlice` 是唯一判据，Web 侧不该自己拼状态迁移。 |
| `POST /api/slices`（创建切片） | 创建要生成规格路径、写集、追溯三元组 —— 那是 `zelto create` 的语义，含 D-4「规格与写集一致性」判定。 |
| `POST /api/sign-requests/:id/approve`、`/reject` | **保留，但见 §5**。 |

### 唯一保留的写操作：签字

签字是**人行使的权力**，而 Web UI 恰好能让「人」这个角色用上浏览器。
所以签字**要**在 Web UI 里 —— 否则驾驶舱只是好看的看板。

但签字按钮不能是「一键批准」。见下节。

---

## 5. 签字：不是「一键批准」，是「看完事实再签」

### 5.1 复用的是同一份判定

ADR-070 已经把签字前的事实抽成了结构化契约：

- `core/sign-review/types.ts` → `SignReviewFacts`（**事实**，不含判定）
- `core/sign-review/evaluate.ts` → `evaluateSignChecks()`（**判定**，纯函数）

Web UI 复用**同一份** `SignReviewFacts` + **同一个** `evaluateSignChecks`。
不另写一套判定 —— 两处判定漂移过一次（D-11：合并的两条路径判据不一致）。

`facts` 的收集层（读 `.zelto`、跑 git）在 ADR-070 里被放在 `src/cli/sign-review/collect-facts.ts`，
因为它要跑 git —— **core/ 不跑 git**（C2 的依赖方向：core 只用 Node 内置，
但 git 调用属于「IO + 外部进程」，既有约定是放 CLI 层）。

于是本 ADR 把这层**下沉到可共享的位置**：

```
src/core/sign-review/collect.ts     ← 新增：事实收集（读 .zelto / 跑 git）
src/cli/sign-review/collect-facts.ts ← 改为薄封装，复用 core 版
src/adapters/web/api/*.ts           ← 复用 core 版
```

> **为什么放 core/ 而不放 adapters/ 共用一份**：`adapters/` 可以 import `core/`（C6 单向向下），
> 但 `cli/` 与 `adapters/` 之间没有既定的依赖方向。
> 事实收集的本质是「读状态 + 跑 git 拿证据」，与 `core/sched/audit.ts`
> （同样跑 git 拿写集审计证据）是同一类东西 → 属于 core 侧。
> core/ 已经有 `execFileSync` 的先例（`core/sched/audit.ts`、`core/worktree/manager.ts`），
> 所以「core 不跑 git」这条约定**本来就不存在** —— 是 ADR-070 的 `collect-facts.ts`
> 放在 CLI 层时的**位置选择**，不是硬约束。
> 本 ADR 修正这个位置选择，让两份调用方共用一份事实收集。

### 5.2 「一键批准」的防线：先看后签，且服务器强制

浏览器里点一下按钮就签字 = 一键批准。要避免它，**判据必须在服务端**：

1. **前端**：签字页先渲染完整的四项确认项（追溯链 / 验收 / 写集 / 产物），
   人必须读过。批准按钮初始 `disabled`。
2. **服务端**：`POST /api/sign-requests/:id/approve` **必须带四项判定结果**，
   且**四项全 `ok`** 才执行签字；任一不过 → `409`，并回传是哪一项不过。

关键点：**服务端不信前端传上来的判定结果**——
它自己重新算一遍（`collectSignReviewFacts` + `evaluateSignChecks`），
只把前端传的当作「人确认过了这四项」的凭据。

> **为什么这不是「多一次点击」的形式主义**：
> 一键批准的问题是**人没看过就授权**。
> 服务端强制「四项全绿才准签」+ 前端强制「看过才解锁」，
> 两者合起来才构成「人真的看过了」。
> 只有前端那道是自欺欺人（改个 DOM 就能绕过）；
> 只有服务端那道是「暗室里批准」。

3. **签字 ≠ 合并**（ADR-018）：签字成功后前端**明确提示**
   「签字不等于合并，合入主干需另跑 `zelto merge <id>`」。
   Web UI **不提供**合并按钮。

---

## 6. 范围：只读驾驶舱 + 签字

保留的端点（全部 GET，加上签字那一个 POST）：

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/api/slices` | 切片总览（id / 标题 / 状态 / 追溯 / 写集 / 停机） |
| GET | `/api/slices/:id` | 切片详情（含 `SignReviewFacts` + `SignCheck`） |
| GET | `/api/slices/:id/events` | 该片事件流（支持 `?limit=`） |
| GET | `/api/slices/:id/audit` | 审计报告（`core/audit/trail.ts`） |
| GET | `/api/events` | 全局最近事件 |
| GET | `/api/sign-requests` | 签字请求清单（按状态过滤） |
| GET | `/api/summary` | 概况（切片数 / 状态分布 / 待签字数 / 成本） |
| POST | `/api/sign-requests/:id/approve` | **唯一写操作**（§5） |
| GET | `/` | SPA |

**SSE 不做**（ADR-010 §5.5）：前端用 5 秒轮询。
SSE 需要在服务端保持长连接与连接状态 —— 那是**内存状态**，
而 zelto 的状态只该在文件里（C1）。轮询读文件，天然与 CLI 一致。

---

## 7. 安全清单

| 风险 | 措施 |
|---|---|
| CSRF | 会话 token（`X-Zelto-Token`）+ `Origin` 校验（§3） |
| 跨源读 | **从不发** `Access-Control-Allow-Origin`；写 `Content-Type: application/json` |
| 路径穿越 | 路径参数 `:id` 过滤 `/^[A-Za-z0-9._-]+$/`；**不把 id 拼进文件路径**前先校验 |
| XSS | 前端**只用 `textContent`**，不拼 `innerHTML` |
| 绑定面 | **硬编码** `127.0.0.1`，不可配置（ADR-010 §7） |
| 静态资源 | 只服务内嵌的 HTML/CSS/JS 三个字符串，不读任意文件 |
| 端口占用 | 启动失败时明确报错退出，不静默换端口 |

> **「不读任意文件」是硬要求**：一旦服务端按请求读文件，
> 路径穿越就从一个理论洞变成一个实际洞。

---

## 8. 与既有架构的关系

```
浏览器 (SPA)
    │ fetch (127.0.0.1, X-Zelto-Token)
    ▼
src/adapters/web/          ← 适配器层（可依赖 core/，不被 core/ 依赖）
    ├── server.ts          node:http，零额外依赖
    ├── router.ts          手动路由
    ├── api/*.ts           处理器
    └── frontend.ts        内嵌 HTML/CSS/JS 字符串
    │
    ▼
src/core/
    ├── sign-review/       facts 收集 + evaluateSignChecks（判定，与 CLI 共用）
    ├── slice/store.ts     SliceStore
    ├── events/stream.ts   EventStream
    ├── gate/sign.ts       SignManager
    ├── audit/trail.ts     AuditTrail
    └── metrics/ budget/   度量与预算
```

CLI 与 Web UI **共享同一份文件状态与同一个 `core/`**，
所以可以在浏览器里看、在终端里改 —— 不会不一致。

**依赖方向**：C2/C6 满足（`core/` 不 import `adapters/`；`adapters/web` 只向下依赖 `core/`）。
`core/` 零第三方运行时依赖：Web UI 只用 `node:http` + `node:crypto`（C2）。

---

## 9. 决定

1. **实现** ADR-010 的架构（`node:http`、零依赖、本地绑定、复用 `core/`），
   **收窄**它的写操作范围（§4）。
2. **修掉** ADR-010 §9 的 CSRF 漏洞：token + Origin 双因子（§3）。
3. **签字**是唯一写操作，且服务端强制「四项确认项全绿」（§5）。
4. **不做 SSE**（内存状态 vs C1），用轮询（§6）。
5. 事实收集下沉到 `core/sign-review/collect.ts`，CLI 与 Web 共用一份（§5.1）。
6. **不提供**合并按钮 —— 签字不自动合并（ADR-018）。

## 10. 明确不做

- 完整 GUI（AGENTS.md 负向清单）—— 本 ADR 做的是**只读驾驶舱 + 一个签字动作**，
  不是「完整 GUI 产品」。
- 一键批准、自动合并、自动改规格（负向清单）。
- 策略规则编辑器（ADR-010 §12 已列在未来扩展里）。
- 多用户 / 认证 / 远程访问 —— 只绑本地，且只服务一个项目。

# ADR-054：托管的规格文件在提交时刻被豁免

## 状态

已接受（2026-11-11）

## 背景

在 `nimrtc-zelto` 合并 `v1-bwe-transport-cc-fields` 时，每次提交都会打出一行告警：

```
⚠️  zelto-hook: specs/slices/v1-bwe-transport-cc-fields.md 不在策略允许范围内（默认拒绝）—— 提交放行，但请确认
```

这不是一次性的巧合，是**每个切片合并时都会出现**的固定噪音。

### 为什么会这样

`specs/slices/*.md` 是 **zelto 自己写的文件**：

1. 人批准规格时，`zelto spec confirm` 把正式规格写进主仓；
2. 跑切片时，zelto 把规格副本放进隔离 worktree，让 agent 读得到它；
3. 合并时，zelto 把 worktree 里的规格提交回主干。

所以它出现在提交 diff 里是**正常的** —— 提交这个文件的人就是 zelto 自己。

但策略引擎判不出这件事。`policy/policy.yaml` 里没有覆盖 `specs/` 的规则：

- `scanner.ts` 刻意把 `policy/` 与 `specs/` 排除在「模块」之外
  （否则会给治理目录开一片 `v0-specs` 基线切片，把**保护域登记成可写模块**）；
- 于是 `specs/slices/x.md` 在策略里没有任何匹配规则 → 落到 `default: deny`；
- git pre-commit 钩子对 `default` 档的 deny 只告警放行 —— 提交没被拦，
  但每次都留下一行「不在策略允许范围内，请确认」。

人看着这行字会以为真出了什么事，但它每次都是同样的假警报。
**假警报比没有告警更坏** —— 它训练人忽略告警。

## 决策

在**策略判定的兜底档**（default deny）加一个例外：写操作落在
zelto 托管的规格文件上时，判定为 `allow`，规则 id 为 `zelto:managed-spec`。

改动落在三处判定层（它们必须同口径）：

| 层 | 文件 | 用途 |
|---|---|---|
| core | `src/core/policy/engine.ts` | `zelto policy check`、报告层 |
| hook | `src/hook/index.ts` | git pre-commit / pre-push 提交时刻判定 |
| hook | `src/hook/pretool.ts` | agent 运行时逐写判定 |

托管规格文件的路径口径住在 `src/core/project/managed-paths.ts`（core 侧）
与 `src/hook/managed-spec.ts`（hook 侧）—— **各有一份**，因为 hook 是
可独立编译的判定进程，不能 import core。两份的一致性由
`tests/adr-054-managed-spec-commit-exemption.test.ts` 锁死。

## 为什么放在兜底档，而不是判定之前就放行

这是本次决策里最重要的一条。

豁免如果放在判定**之前**，那么策略里显式写的 `deny` 规则就拦不住
`specs/slices/**` 了 —— 那等于给了一条「谁都能把保护解除」的路：
改一下策略，保护就没了。

放在兜底档，语义是：

> 「没有规则覆盖它」时，托管规格文件按 zelto 自己的产物处理；
> 「有人明确写了 deny」时，deny 依然生效。

想真拦它，写一条 deny 规则就行 —— 人的显式意图永远压过内置默认。

## 边界没有放松

这次放行的只是**提交时刻的策略判定**。更细的两层边界原封不动：

- **agent 能不能写它** —— 由写集预约管（预留在 `.zelto/locks/<id>.json`）。
  `judgeWriteTargets` 的判定顺序是「路径逃逸 → 保护域 → **写集预约** →
  策略规则」，写集预约在策略判定**之前**。规格文件不在任何切片的写集里，
  agent 想写它照样被拦。
- **worktree 里的规格副本被改动** —— 由托管文件哈希审计报篡改
  （`zeltoOwnedPaths` 把规格副本登记成 zelto 托管文件）。

换句话说：这次修的是**告警口径**，不是**权限口径**。

## 影响面

- 每次切片合并不再出现那行假告警。
- `zelto policy check specs/slices/x.md` 现在返回 allow，理由是
  `zelto:managed-spec` —— 人能一眼看出这是内置豁免，不是策略里写的规则。
- 策略里显式 deny `specs/slices/**` 的项目，deny 仍然生效。

## 备选方案

**在生成的 `policy/policy.yaml` 里加一条 `allow-write specs/slices/**`。**
否决：那会让「agent 能不能写规格文件」由策略决定，而规格文件是**追溯链的
出处** —— 它的可写性应该由内置机制（写集预约 + 哈希审计）统一管，
不该散落到每个项目的策略文件里。而且改策略要改锚点（C5），
接管既有项目时还要判断策略是不是「人写的」，成本高、收益小。

**让 git 钩子跳过 `specs/` 前缀的文件。** 否决：那把判定搬到了钩子脚本里，
策略层与提交层就出现了两套口径 —— `zelto policy check` 仍然会说 deny，
而钩子放行，人查策略时看到的结论与实际拦截行为对不上。

**不管这个告警。** 否决：每片一次、每次措辞都像在说「请确认」，
是典型的告警疲劳源。

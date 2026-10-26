# zelto 实用化改造路线图

## 阶段一：基础设施（Gap 2 + Gap 1 前半）✅
- ✅ 拆分 commands.ts → `src/cli/commands/*.ts`
- ✅ Agent 会话持久化（实现 SessionPort）
- ✅ Agent 超时/重试机制

## 阶段二：Agent 闭环（Gap 1 后半 + Gap 6）✅
- ✅ 并行多 agent 执行（`version start` 用 Promise.all）
- ✅ 执行完自动触发 gate（`run`/`start` 后 auto-gate）
- ✅ gate 通过自动发起签名请求
- ✅ sign approve 自动 merge（commit + merge to main）

## 阶段三：补核心模块（Gap 3）✅
- ✅ artifacts（制品管理）
- ✅ contracts（契约验证）
- ✅ spec（规格引擎）

## 阶段四：外部验证 + CI/CD（Gap 4 + Gap 5）✅
- ✅ 找真实项目跑接管流程
- ✅ GitHub Action / Docker / pre-commit 集成

## 阶段五：体验打磨（Gap 7）✅
- ✅ 进度指示、颜色输出、错误美化
- ✅ `zelto suggest` 引导命令
- ✅ help 文本与实际同步

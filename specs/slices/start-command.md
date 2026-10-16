# Slice: start-command

## 目的
添加 `zelto start <id>` 命令，一键走完创建→检查→冻结→执行全流程。
同时增强 `zelto inbox` 为交互式审批界面。

## 范围
- `src/cli/commands.ts` — 新增 `start` 命令，修改 `inbox` 为交互模式

## 验收标准
1. `zelto start my-slice` 自动走完：create（如需要）→ check → freeze → run
2. 切片已冻结时跳过 freeze，直接 run
3. 切片已在 running 时报错
4. `zelto inbox` 进入交互模式：显示待签列表，输入编号审批
5. `zelto inbox --list` 保留原有的非交互列表模式
6. 全部 70+ 测试通过

## 风险
- 涉及 stdin 交互式读取，需要处理输入缓冲

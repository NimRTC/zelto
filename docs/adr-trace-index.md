# ADR 追溯登记表

本表登记直推 main 的修复所对应的 ADR 版本追溯结果，供版本一致性检查模块参考。
「追溯状态」与 `scripts/adr-trace-check.mjs` 的校验结果一致：脚本通过（退出码 0）
时对应行为「已回填」；脚本报缺失（退出码非零）时不应为「已回填」。

## 追溯登记表

| ADR 编号 | 标题 | 所属版本号 | 提交哈希 | 验证方式 | 追溯状态 |
| --- | --- | --- | --- | --- | --- |
| ADR-102 | agent 占位符剥离 | v0.7.0 | c6e8aea3dbebe543de6f8d64ecc49b0e4f11165f | [git show --stat 抽查 + 人工复核] | 已回填 |
| ADR-103 | submodule 离线同步 | v0.7.0 | e90949c3db9a9024024cb27bf56620bf05990286 | [git show --stat 抽查 + 人工复核] | 已回填 |
| ADR-104 | sign-review 作用域证据 | v0.7.0 | cf467264e444c7e007a3af4f3d844d5f1075ca58 | [git show --stat 抽查 + 人工复核] | 已回填 |

## 校验入口

- `node scripts/adr-trace-check.mjs` —— 扫描三份 ADR 的「版本追溯」小节，
  全部字段齐全且格式合法时退出码 0，任一缺失/非法时退出码 1。

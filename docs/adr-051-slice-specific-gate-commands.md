# ADR-051：门禁命令可以按切片覆盖

## 状态

已接受（2026-11-11）

## 背景

在 `nimrtc-zelto` 推进 Track F 的 F3 切片（`v1-bwe-transport-cc-fields`）时，
门禁②的 build 步骤会去构建 **`test_net_feedback_test`** —— 那是 `net_feedback`
模块的测试目标，跟本片（`plugins` 模块的 BWE 类型扩展）**毫无关系**。

原因在 `.zelto/config.yaml`：门禁命令是**项目级**的，只有一套：

```yaml
gate:
  commands:
    - name: build
      run: cmake --build build --config Debug --target test_net_feedback_test
    - name: test
      run: ctest --test-dir build -C Debug -R net_feedback --output-on-failure
```

项目级配置对「同模块的连续切片」是对的，但对「跨模块的切片」是错的：
本片新增的测试文件在 `src/plugins/tests/` 下，CMake 目标名是
`test_bwe_feedback_fields_test`，ctest 用例名里含 `bwe_feedback_fields`。
用项目级命令去验，既不验本片产物，又白等一次构建。

## 决策

给切片加一个**专属门禁命令**字段：`slice.spec.gateCommands`。

```json
{
  "spec": {
    "path": "specs/slices/v1-bwe-transport-cc-fields.md",
    "gateCommands": [
      { "name": "configure", "run": "cmake -S . -B build -G \"Visual Studio 17 2022\" ..." },
      { "name": "build",    "run": "cmake --build build --config Debug --target test_bwe_feedback_fields_test" },
      { "name": "test",     "run": "ctest --test-dir build -C Debug -R bwe_feedback_fields --output-on-failure" },
      { "name": "api-freeze", "run": "node scripts/api_freeze_scan.js" }
    ]
  }
}
```

优先级：**本片专属命令 > 项目级 profile > 项目级默认命令**。

**为什么由人写、而不是工具从写集路径猜**：CMake 目标名不是从源文件路径
机械推导的 —— `nimrtc_add_test` 宏会做 `string(REPLACE "/tests/" "_test_")`
再拼上源文件名，猜出来的名字多半不对。门禁命令是「这片怎么算验过了」的
口径，属于**人的判断**，工具不该替人编。

## 命令行的取值格式：JSON 数组（支持 `@文件`）

`zelto set <id> --field spec.gateCommands --value '<json>'`

**为什么是 JSON 而不是 `name=run` 逗号分隔**：门禁命令里**经常**有逗号
（`-DFOO=a,b`），也经常有引号（`-G "Visual Studio 17 2022"`）。
任何基于分隔符的格式都会切错 —— 实测把 `-G "Visual Studio 17 2022"`
切成了两半，命令直接跑不通。

**为什么支持 `@<文件路径>`**：命令行的引号经过 shell 转义会被吃掉
（Windows PowerShell 上尤其明显：`-G "Visual Studio 17 2022"` 进去就变成
`-G " Visual Studio 17 2022\"`）。文件是可靠的通道。

## 影响面

三处读取门禁命令的地方都要认这个字段，否则「agent 用一套命令验证、
门禁用另一套」的老问题（ADR-045）会重新出现：

1. `core/gate/executor.ts` —— 门禁②真正执行的地方；
2. `cli/commands/run-support.ts` 的 `gateCommandsForSlice` ——
   装进约束包，给 agent 看（ADR-045）；
3. `cli/commands/gate-sign.ts` —— `zelto gate` 自己组装 GateConfig 的地方。

## 后果

- 跨模块切片可以声明自己该验什么；同模块切片保持用项目级命令，不受影响。
- 「agent 用同一套命令验证自己的产物」这条约束仍然成立 ——
  三处读的是同一个字段。

## 备选方案

**在 `config.yaml` 里加更多 profile（按模块分）**。否决：模块会持续增加，
profile 数量跟着涨，而且新增模块要改的是**项目配置**（人人共享的文件），
而按切片声明只改**那片自己的文件**。粒度不对。

**让工具从写集路径推导 CMake 目标名**。否决：目标名的推导规则
（`string(REPLACE "/tests/" "_test_")` + 源文件名）藏在 CMake 宏里，
工具复制一份就是复制一份必然发散的规则；猜错了还会让门禁构建**别的**目标
然后报一个跟本片无关的错。

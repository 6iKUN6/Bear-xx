# AgentFlow JSON 快速入库 CLI 设计

## 目标

提供一个面向本地开发环境的命令行脚本，把标准 FlowDefinition JSON 创建为新的逻辑 Flow
与首个草稿版本；需要真实执行验证时，可显式发布该版本。脚本同时提供一份 v10 Loop 测试
Definition，用于验证管理端容器交互和 AgentFlow/Temporal 多轮执行。

本功能不新增 HTTP 接口、数据库字段、依赖或兼容层，也不直接复制控制面的写库规则。

## 命令接口

在 `apps/api/package.json` 中提供 `flow:import`：

```bash
pnpm --filter ./apps/api run flow:import -- ./scripts/fixtures/loop-container-v10.json
pnpm --filter ./apps/api run flow:import -- ./scripts/fixtures/loop-container-v10.json \
  --model-preset=<presetId> --publish
```

支持以下参数：

- 第一个位置参数：必填 JSON 文件路径，相对路径按当前工作目录解析。
- `--publish`：可选；通过完整发布预检后，创建并发布首个版本。缺省只创建草稿。
- `--actor=<用户ID或用户名>`：可选；指定审计操作者。
- `--model-preset=<presetId>`：可选；将测试或跨环境 JSON 中所有模型节点统一物化为该具体模型预设。

未知参数、重复位置参数、文件不存在、JSON 语法错误或根值不是对象时立即失败，不连接数据库。

## 正式链路复用

脚本沿用现有调试脚本的启动方式：加载 `apps/api/.env`，注册 `ts-node` 与路径别名，再创建
Nest 应用上下文。通过依赖注入获取 `PrismaService`、`AgentFlowService` 和
`AgentFlowVersionService`，不直接创建 `agent_flows`、`agent_flow_versions` 或审计记录。

创建流程如下：

1. 读取并解析 JSON。
2. 如提供 `--model-preset`，只改写支持模型配置的节点：`agent`、`plan`、
   `plan-loop.executor`、`approval(policy=model)` 和 `synthesize`。
3. 解析操作者：显式值按用户 ID 或用户名查询且必须为管理员；缺省依次选择最早创建的
   `SUPER_ADMIN`、`ADMIN`。没有管理员时失败。
4. 不带 `--publish` 时调用 `AgentFlowService.create()`，按草稿结构校验创建 Flow、v1 草稿和
   `CREATED` 审计。拓扑可以暂未闭合，但字段、引用和 Loop 归属必须安全可编辑。
5. 带 `--publish` 时先调用 `AgentFlowVersionService.validateDefinition()` 对内存中的 Definition
   做结构与运行时能力预检。预检失败时不写任何数据；成功后调用正式创建服务，再调用正式
   发布服务，生成 digest、`PUBLISHED` 审计并设置发布指针。

创建与发布是现有服务提供的两个事务。发布预检消除了确定性的配置错误；若创建后发生数据库
断线等非确定性发布失败，脚本明确打印已创建的 Flow 与草稿 ID，不删除数据或伪装成全成功，
管理员可以修复环境后在后台继续发布。

## Loop 测试 Definition

测试文件放在：

```text
apps/api/scripts/fixtures/loop-container-v10.json
```

图结构为：

```text
start -> quality_loop --again--> draft -> review -> quality_loop
                        done  -> answer -> end
```

- `draft` 与 `review` 显式声明 `loopId: "quality_loop"`。
- `quality_loop` 使用 `maxIterations: 3` 与空 `continueWhen`，因此确定执行三轮，不依赖模型
  自由文本决定退出条件。
- 两个体内节点使用相对容器坐标；Loop 布局包含 `width`、`height`、`collapsed: false`，便于
  验证展开、折叠、缩放和拖入拖出。
- 体外 `answer` 节点负责最终回复，完整链路会产生真实模型调用和可见结果。
- JSON 使用可移植的 `agent-default`；创建草稿时可直接导入。发布前必须通过
  `--model-preset` 将所有模型节点显式物化为当前数据库中的具体预设，脚本同时写入该模型能力
  目录的默认思考参数。发布仍以当前数据库能力目录校验结果为准。
- 工具组和技能为空，避免 Loop 验证被外部工具、用户凭据或 HITL 干扰。

## 输出与错误

成功时打印：

- Flow ID、Version ID 和最终状态；
- 最终使用的模型预设；
- 管理端编辑器路由；
- Definition 来源文件。

所有错误以非零退出码结束。Nest `BadRequestException` 中的 Definition 校验错误要展开为路径、
规则和中文消息；不得只打印 `[object Object]`。日志不输出 token、cookie、数据库连接串或模型
密钥。

## 测试与验证

- 参数解析：默认草稿、发布开关、操作者和模型覆盖参数、未知参数与缺失文件参数。
- Definition 物化：所有支持模型的节点及其默认思考参数被覆盖，非模型字段与布局保持不变，
  输入对象不被修改。
- 发布预检失败时不调用创建服务。
- 创建成功时输出稳定的 Flow/Version 标识；发布失败时保留并报告已创建草稿。
- 测试 JSON 通过当前完整 Definition 校验器。
- 执行 API 定向测试、`build`、`lint:check` 和 `git diff --check`。
- 数据库可用时用脚本实际导入测试 JSON；只有存在可用具体模型预设时才执行 `--publish`，否则
  保留草稿并明确报告缺少的环境前置条件。

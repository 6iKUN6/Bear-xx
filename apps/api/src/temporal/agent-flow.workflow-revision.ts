/**
 * AgentFlow Workflow 代码修订号
 *
 * Temporal 在 replay 时会重放 History 并要求 Workflow 代码产生完全相同的命令序列。
 * 因此 `agent-flow.workflow.ts` 里任何改变命令序列的改动（新增/删除/重排 Activity
 * 调用、Timer、condition 等待）对**在途** Workflow 都是破坏性的。
 *
 * 破坏后的表现不是数据丢失：Temporal 会让该 Workflow Task 持续重试并阻塞在
 * NondeterminismError 上，回滚到旧代码即可恢复。但任务会在此期间停滞，因此仍需纪律。
 *
 * ## 改 agent-flow.workflow.ts 时的规则
 *
 * 1. **只加不改的分支** —— 用 `patched('<patch-id>')` 包住新命令序列，让在途 run 走旧路径：
 *
 *    ```ts
 *    if (patched('plan-loop-per-step')) {
 *      result = await activities.continueNode(...);   // 新 run
 *    } else {
 *      result = await activities.executeNode(...);    // 在途 run
 *    }
 *    ```
 *
 *    等到确认没有在途 run 仍走旧分支后，再用 `deprecatePatch('plan-loop-per-step')`
 *    过渡一个发布周期，最后删掉分支。
 *
 * 2. **排空后部署** —— 若可以接受等待，先停止派发新任务、等在途 run 全部到达终态，
 *    再部署；此时无需 patch。判断依据是本文件的修订号（见下）。
 *
 * 3. 无论走哪条路，**都要递增 `AGENT_FLOW_WORKFLOW_REVISION`**，并在下方登记改动。
 *
 * ## 修订号怎么用
 *
 * - 启动 Workflow 时作为 memo 写入，Temporal UI 上可按 memo 过滤出属于旧修订的在途 run，
 *   据此判断"是否已排空"。memo 由客户端在启动时写入，不参与 replay，不影响确定性。
 * - Worker 以它作为 `buildId`，使每个 Workflow Task 携带执行它的代码修订，便于事后定位
 *   "这个 run 是被哪一版代码推进的"。当前未开启 `useVersioning`（需先在服务端配置
 *   build-id 兼容集），因此它只是元数据，不参与任务路由。
 *
 * ## 修订历史
 *
 * - `2` plan-loop 改为逐步执行：新增 `continueNode` 调度，命令序列变化。
 *   部署时依赖"无在途 run"，未加 patch。
 * - `1` 初始版本：loadRunSnapshot -> executeNode/resumeNode 循环 -> finalizeRun。
 */
export const AGENT_FLOW_WORKFLOW_REVISION = 2;

/** memo 中记录启动修订号的键名。 */
export const AGENT_FLOW_WORKFLOW_REVISION_MEMO_KEY =
  'agentFlowWorkflowRevision';

/**
 * 生成 Worker 上报的构建标识
 * @returns 返回形如 `agent-flow-r2` 的稳定标识
 * @description 与修订号一一对应，便于在 Temporal UI 的 Workflow Task 上直接读出代码版本。
 */
export function getAgentFlowWorkflowBuildId(): string {
  return `agent-flow-r${AGENT_FLOW_WORKFLOW_REVISION}`;
}

import { AGENT_FLOW_WORKFLOW_REVISION } from '../../../temporal/agent-flow.workflow-revision';
import { getTemporalWorkerConfig } from '../../../temporal/temporal.config';
import type {
  AgentFlowWorkflowInput,
  AgentFlowWorkflowStartInput,
} from '../../../temporal/workflows/agent-flow.workflow.types';
import { createAgentFlowWorkflowStartOptions } from './temporal-client.service';

describe('TemporalClientService', () => {
  it('使用 StreamTask.id 作为 Workflow ID，并对重复派发复用已有执行', () => {
    const options = createAgentFlowWorkflowStartOptions(
      {
        streamTaskId: 'task-1',
        flowVersionId: 'version-1',
        flowDigest: 'a'.repeat(64),
      } satisfies AgentFlowWorkflowStartInput,
      getTemporalWorkerConfig({
        TEMPORAL_ADDRESS: 'temporal.internal:7233',
        TEMPORAL_NAMESPACE: 'agent-flow-dev',
        TEMPORAL_TASK_QUEUE: 'agent-flow',
      }),
    );

    expect(options).toEqual({
      taskQueue: 'agent-flow-orchestrator',
      workflowId: 'task-1',
      workflowIdConflictPolicy: 'USE_EXISTING',
      // 登记启动时的 Workflow 代码修订，供排空判断使用
      memo: {
        agentFlowWorkflowRevision: AGENT_FLOW_WORKFLOW_REVISION,
      },
      args: [
        {
          streamTaskId: 'task-1',
          flowVersionId: 'version-1',
          flowDigest: 'a'.repeat(64),
          activityTaskQueue: 'agent-flow-activity',
        } satisfies AgentFlowWorkflowInput,
      ],
    });
  });
});

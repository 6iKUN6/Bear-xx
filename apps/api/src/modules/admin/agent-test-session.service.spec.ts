import { NotFoundException } from '@nestjs/common';
import { StreamTaskType } from '@prisma/client';
import { createFlowDefinitionPreset } from '../agent-flow/definition/flow-definition.validator';
import { AgentTestSessionService } from './agent-test-session.service';

describe('AgentTestSessionService', () => {
  interface DetailQuery {
    where: { id: string; userId: string; isTest: boolean };
    include: {
      messages: {
        include: {
          streamTasks: {
            where: {
              userId: string;
              isTest: boolean;
              type: StreamTaskType;
            };
            take: number;
          };
        };
      };
    };
  }

  const prisma = {
    conversation: {
      findMany: jest.fn(),
      findFirst: jest.fn<Promise<unknown>, [DetailQuery]>(),
      delete: jest.fn(),
    },
    modelPreset: { findMany: jest.fn() },
  };

  /**
   * 构造测试会话服务
   * @returns 返回仅替换数据库依赖的真实服务实例
   * @description 会话快照解析仍执行真实 Definition 校验与 DTO 映射逻辑。
   */
  function createService() {
    return new AgentTestSessionService(prisma as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.modelPreset.findMany.mockResolvedValue([]);
  });

  it('只读取当前管理员的测试聊天任务并返回冻结执行快照', async () => {
    const definition = createFlowDefinitionPreset('direct');
    const explicitDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.type === 'agent'
          ? {
              ...node,
              name: '回答',
              config: { ...node.config, modelPreset: 'explicit-model' },
            }
          : node,
      ),
    };
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      title: '测试会话',
      updatedAt: new Date('2026-09-10T00:00:00.000Z'),
      messages: [
        {
          id: 'message-user',
          role: 'USER',
          content: '你好',
          agentId: null,
          status: 'DONE',
          createdAt: new Date('2026-09-10T00:00:00.000Z'),
          turnTraceItems: [],
          streamTasks: [],
        },
        {
          id: 'message-assistant',
          role: 'ASSISTANT',
          content: '你好',
          agentId: 'agent-1',
          status: 'DONE',
          createdAt: new Date('2026-09-10T00:00:01.000Z'),
          turnTraceItems: [],
          streamTasks: [
            {
              id: 'task-1',
              status: 'COMPLETED',
              resolvedAgentModelPresetId: 'default-model',
              flowDigest: 'digest-1',
              flowVersion: {
                id: 'version-1',
                version: 3,
                definition: explicitDefinition,
                flow: { id: 'flow-1', name: '三节点 Flow' },
              },
            },
          ],
        },
      ],
    });
    prisma.modelPreset.findMany.mockResolvedValue([
      {
        presetId: 'default-model',
        name: '默认模型',
        model: 'gpt-default',
        connection: { providerKey: 'openai' },
      },
    ]);

    const result = await createService().detail('admin-1', 'conversation-1');

    const query = prisma.conversation.findFirst.mock.calls[0][0];
    expect(query.where).toEqual({
      id: 'conversation-1',
      userId: 'admin-1',
      isTest: true,
    });
    expect(query.include.messages.include.streamTasks.where).toEqual({
      userId: 'admin-1',
      isTest: true,
      type: StreamTaskType.CHAT_COMPLETION,
    });
    expect(query.include.messages.include.streamTasks.take).toBe(1);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({ agentId: null, execution: null }),
    );
    expect(result.messages[1].execution).toEqual({
      taskId: 'task-1',
      taskStatus: 'completed',
      flow: {
        id: 'flow-1',
        name: '三节点 Flow',
        versionId: 'version-1',
        version: 3,
        digest: 'digest-1',
      },
      agentDefaultModel: {
        presetId: 'default-model',
        name: '默认模型',
        model: 'gpt-default',
        providerKey: 'openai',
      },
      nodeModels: [
        {
          nodeId: 'answer',
          nodeName: '回答',
          nodeType: 'agent',
          source: 'explicit',
          model: {
            presetId: 'explicit-model',
            name: null,
            model: null,
            providerKey: null,
          },
        },
      ],
    });
  });

  it('Definition 不兼容当前契约时保留 Flow 身份并跳过节点模型', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      title: '历史会话',
      updatedAt: new Date('2026-09-10T00:00:00.000Z'),
      messages: [
        {
          id: 'message-1',
          role: 'ASSISTANT',
          content: '历史回复',
          agentId: 'agent-1',
          status: 'DONE',
          createdAt: new Date('2026-09-10T00:00:00.000Z'),
          turnTraceItems: [],
          streamTasks: [
            {
              id: 'task-1',
              status: 'COMPLETED',
              resolvedAgentModelPresetId: 'deleted-model',
              flowDigest: 'digest-old',
              flowVersion: {
                id: 'version-old',
                version: 1,
                definition: { schemaVersion: 1 },
                flow: { id: 'flow-old', name: '历史 Flow' },
              },
            },
          ],
        },
      ],
    });

    const result = await createService().detail('admin-1', 'conversation-1');

    expect(result.messages[0].execution).toEqual(
      expect.objectContaining({
        agentDefaultModel: {
          presetId: 'deleted-model',
          name: null,
          model: null,
          providerKey: null,
        },
        nodeModels: [],
      }),
    );
  });

  it('同一 FlowVersion 的 agent-default 按各自任务快照解析', async () => {
    const definition = createFlowDefinitionPreset('direct');
    /**
     * 构造共享 FlowVersion 的任务快照
     * @param id 测试任务 ID
     * @param presetId 该任务冻结的 Agent 默认模型预设 ID
     * @returns 返回会话查询所需的任务关联形状
     */
    const task = (id: string, presetId: string) => ({
      id,
      status: 'COMPLETED',
      resolvedAgentModelPresetId: presetId,
      flowDigest: 'digest-1',
      flowVersion: {
        id: 'version-1',
        version: 1,
        definition,
        flow: { id: 'flow-1', name: '共享 Flow' },
      },
    });
    /**
     * 构造关联单个测试任务的 assistant 消息
     * @param id 消息 ID
     * @param streamTask 待关联的测试任务快照
     * @returns 返回会话详情查询所需的消息形状
     */
    const message = (id: string, streamTask: ReturnType<typeof task>) => ({
      id,
      role: 'ASSISTANT',
      content: '回复',
      agentId: 'agent-1',
      status: 'DONE',
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
      turnTraceItems: [],
      streamTasks: [streamTask],
    });
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      title: '多轮会话',
      updatedAt: new Date('2026-09-10T00:00:00.000Z'),
      messages: [
        message('message-1', task('task-1', 'model-a')),
        message('message-2', task('task-2', 'model-b')),
      ],
    });

    const result = await createService().detail('admin-1', 'conversation-1');

    expect(
      result.messages.map(
        (item) => item.execution?.nodeModels[0]?.model.presetId,
      ),
    ).toEqual(['model-a', 'model-b']);
  });

  it('拒绝读取其他管理员或非测试会话', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      createService().detail('admin-1', 'conversation-missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

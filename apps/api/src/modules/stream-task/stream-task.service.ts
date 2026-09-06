import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgentStrategyMode,
  APPROVAL_DECISION_LABELS,
  PLAN_REVIEW_DECISION_LABELS,
} from '@litter-bear/types/protocol';
import type { ReasoningSelection } from '@litter-bear/types';
import type {
  AgentRoutedPayload,
  ApprovalDecision,
  ApprovalResolvedPayload,
  PlanReviewDecision,
  PlanReviewResolvedPayload,
  StreamTaskPayloadMap,
  TaskErrorPayload,
} from '@litter-bear/types/protocol';
import { classifyLlmError } from '../llm/llm-error';
import {
  StreamTaskStatus,
  StreamTaskRunStatus,
  StreamTaskType,
  MessageRole,
  MessageStatus,
  ConversationTraceItemType,
  ConversationTraceItemStatus,
  ConversationType,
  AgentFlowApprovalKind,
  Prisma,
} from '@prisma/client';
import {
  getModelCallCount,
  getModelCallTokenUsage,
  runWithModelCallContext,
} from '../ai/telemetry/model-call-context';
import { randomUUID } from 'crypto';
import type { SseEvent } from '../../common/sse';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AiService } from '../ai/ai.service';
import { CommonChatAgentRunnerService } from '../ai/agents';
import type {
  AgentLoopStreamEvent,
  PersistedAgentStrategySnapshot,
} from '../ai/agent-loop';
import type {
  LlmMessage,
  LlmRunMetrics,
  LlmTokenUsageMetrics,
} from '../llm/llm.types';
import { LlmService } from '../llm/llm.service';
import { ConversationService } from '../conversation/conversation.service';
import {
  GroupRouterService,
  type GroupRouteContext,
  type GroupRouteSource,
} from '../conversation/group-router.service';
import { ConversationTraceService } from '../conversation-trace';
import type { ChatContextBundle } from '../memory/chat-context.service';
import { ConversationSummaryService } from '../memory/conversation-summary.service';
import { ConversationTitleService } from '../memory/conversation-title.service';
import { McDonaldsOrderService } from '../mcdonalds-order/mcdonalds-order.service';
import { McDonaldsCredentialService } from '../mcdonalds-credential/mcdonalds-credential.service';
import { CapabilityRegistry } from '../ai/agent-loop/capability/capability.registry';
import { MCDONALDS_MCP_SERVER_NAME } from '../ai/mcp/McDonalds.mcp';
import {
  consumeCreatedMcDonaldsOrderIds,
  runWithMcDonaldsOrderContext,
} from '../mcdonalds-order/mcdonalds-order-context';
import {
  STREAM_TASK_TERMINAL_EVENT_TYPES,
  StreamTaskEventType,
} from './stream-task-event.types';
import { StreamTaskRegistry } from './stream-task.registry';
import { StreamTaskSnapshotService } from './stream-task-snapshot.service';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';
import { AgentFlowApprovalService } from '../agent-flow/agent-flow-approval.service';
import { AgentFlowSignalOutboxService } from '../agent-flow/temporal/agent-flow-signal-outbox.service';
import {
  AgentAccessDenialReason,
  AgentAccessService,
} from '../agent-access/agent-access.service';

interface ChatTaskPayload {
  content: string;
  agentId?: string;
  /** 创建任务时锁定的用户级麦当劳凭据；只用于动态 MCP 工具装配。 */
  mcdonaldsCredentialId?: string;
}

interface CreatedTaskResult {
  taskId: string;
  streamId: string;
  messageId: string;
  conversationId: string;
  status: string;
}

interface StreamTaskEventData<TPayload = undefined> {
  type: StreamTaskEventType;
  taskId: string;
  streamId?: string;
  conversationId: string;
  messageId: string;
  status: string;
  payload?: TPayload;
  errorMessage?: string;
}

interface PersistedSemanticEvent {
  eventId: number;
  sseEvent: SseEvent;
}

interface PersistedModelRunMetrics {
  modelCallCount: number;
  tokenUsage?: LlmTokenUsageMetrics;
}

export interface TaskStreamResult {
  stream: AsyncGenerator<SseEvent>;
}

const TASK_CANCELED_REASON = 'task_canceled';
const EMPTY_ASSISTANT_CONTENT =
  '模型本次没有返回有效文本。请检查模型名称、中转站响应格式或流式输出配置。';

const INITIAL_STREAM_TRIGGER = 'initial';
/** 群聊路由上下文取的尾部消息条数（仅供判断指代，不是完整上下文） */
const GROUP_ROUTE_CONTEXT_MESSAGES = 4;
const FULL_CONTENT_FLUSH_INTERVAL_MS = 1000;
const FULL_CONTENT_FLUSH_CHARS = 2048;

@Injectable()
export class StreamTaskService {
  private readonly logger = new Logger(StreamTaskService.name);
  private readonly bufferTtl: number;
  private readonly lockKeyPrefix = 'stream-task:lock';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly aiService: AiService,
    private readonly commonChatAgentRunnerService: CommonChatAgentRunnerService,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
    private readonly conversationService: ConversationService,
    private readonly groupRouterService: GroupRouterService,
    private readonly conversationTraceService: ConversationTraceService,
    private readonly conversationSummaryService: ConversationSummaryService,
    private readonly conversationTitleService: ConversationTitleService,
    private readonly registry: StreamTaskRegistry,
    private readonly snapshotService: StreamTaskSnapshotService,
    private readonly mcdonaldsOrderService: McDonaldsOrderService,
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly mcdonaldsCredentialService: McDonaldsCredentialService,
    private readonly flowTaskDispatcher: FlowTaskDispatcherService,
    private readonly agentFlowApprovalService: AgentFlowApprovalService,
    private readonly agentFlowSignalOutboxService: AgentFlowSignalOutboxService,
    private readonly agentAccessService: AgentAccessService,
  ) {
    this.bufferTtl =
      this.configService.get<number>('STREAM_TASK_BUFFER_TTL') ??
      this.configService.get<number>('SSE_BUFFER_TTL', 300);
  }

  /**
   * 创建文本聊天任务
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 基于文本消息创建可恢复任务；模型选择先按 Agent 允许集合解析，再以稳定预设标识锁定到任务。
   */
  async createChatTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    agentId?: string,
    isTest = false,
  ) {
    return this.createTextTask(
      conversationId,
      content,
      userId,
      StreamTaskType.CHAT_COMPLETION,
      selectedModelPresetId,
      reasoning,
      agentId,
      isTest,
    );
  }

  /**
   * 创建文本任务并直接返回首轮流式结果
   * @param conversationId 会话ID
   * @param content 用户消息内容
   * @param userId 用户ID
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @param signal 连接中断信号
   * @returns 返回包含异步流式事件的对象
   * @description 用于聊天主入口：先创建可恢复任务，再在同一请求中直接进入首轮流式事件，同时向客户端下发 task.created 事件。
   */
  async streamChatTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    signal?: AbortSignal,
    agentId?: string,
    isTest = false,
  ): Promise<TaskStreamResult> {
    // 未显式指定回答者时按会话形态解析：单聊=绑定 agent；群聊=固定默认或自动路由
    const answering = await this.resolveAnsweringAgent(
      conversationId,
      userId,
      content,
      agentId,
    );

    const task = await this.createChatTask(
      conversationId,
      content,
      userId,
      selectedModelPresetId,
      reasoning,
      answering.agentId,
      isTest,
    );
    // 路由结果落成真事件（在开流之前写，openTaskStream 从 '0' 读全量缓冲，
    // 客户端照样收得到）。task.created 是 prependEvent 合成的、不入持久化流，
    // 只能满足实时展示；要让「谁被指派、为什么」在刷新后仍可回溯，必须走这里。
    await this.recordAgentRouted({ ...task, userId }, answering);
    const taskStream = await this.openTaskStream(
      task.taskId,
      userId,
      '0',
      signal,
    );

    return {
      stream: this.prependEvent(
        this.buildTaskSseEvent('0', StreamTaskEventType.TaskCreated, {
          taskId: task.taskId,
          streamId: task.streamId,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: task.status,
          // 告知前端本轮由哪个智能体回答（重连/回显归属）；自动路由附带理由
          payload: answering.agentId
            ? {
                agentId: answering.agentId,
                ...(answering.autoRouted
                  ? {
                      autoRouted: true,
                      routeReason: answering.routeReason,
                      routeSource: answering.routeSource,
                    }
                  : {}),
              }
            : undefined,
        }),
        taskStream.stream,
      ),
    };
  }

  /**
   * 解析本条消息的回答者
   * @param conversationId 会话ID（可空=新会话）
   * @param userId 用户ID
   * @param content 用户消息（自动路由的输入）
   * @param explicitAgentId 显式指定（@ 提及/胶囊选择），最高优先
   * @returns 返回回答者与路由标记
   * @description 单聊回落到绑定 agent；群聊按「固定默认回答者 > 自动路由」解析。
   * 会话不存在/归属异常时不在此抛错（原样透传，由后续 resolveConversationId 统一校验）。
   */
  private async resolveAnsweringAgent(
    conversationId: string | undefined,
    userId: string,
    content: string,
    explicitAgentId?: string,
  ): Promise<{
    agentId?: string;
    autoRouted?: boolean;
    routeReason?: string;
    routeSource?: GroupRouteSource;
  }> {
    if (explicitAgentId || !conversationId) {
      return { agentId: explicitAgentId };
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { type: true, agentIds: true, defaultAgentId: true },
    });
    if (!conversation) {
      return { agentId: undefined };
    }

    if (conversation.type === ConversationType.SINGLE) {
      return { agentId: conversation.defaultAgentId ?? undefined };
    }

    if (conversation.defaultAgentId) {
      return { agentId: conversation.defaultAgentId };
    }
    if (conversation.agentIds.length === 0) {
      return { agentId: undefined };
    }

    const routed = await this.groupRouterService.route(
      content,
      conversation.agentIds,
      await this.buildGroupRouteContext(conversationId),
    );
    return {
      agentId: routed.agentId,
      autoRouted: true,
      routeReason: routed.reason,
      routeSource: routed.source,
    };
  }

  /**
   * 记录回答者指派事件
   * @param task 刚创建的任务
   * @param answering 回答者解析结果
   * @description 仅在确实指派了具体回答者时记录。事件同时进 Redis 帧流（前端可见）
   * 与 conversation-trace（刷新后可回溯），与 strategy.selected 同构。
   * 失败不阻断发送链路——指派信息属于可观测性，不该让主流程为它挂掉。
   */
  private async recordAgentRouted(
    task: {
      taskId: string;
      streamId?: string | null;
      conversationId: string;
      messageId: string;
      userId: string;
    },
    answering: {
      agentId?: string;
      autoRouted?: boolean;
      routeReason?: string;
      routeSource?: GroupRouteSource;
    },
  ): Promise<void> {
    if (!answering.agentId) {
      return;
    }

    try {
      const agent = await this.prisma.agent.findUnique({
        where: { id: answering.agentId },
        select: { name: true },
      });
      // satisfies 而非类型注解：保留字面量推断，使其可直接赋给 Record<string, unknown>
      // （interface 无隐式索引签名，注解后需要断言才能传给事件载荷）
      const payload = {
        agentId: answering.agentId,
        agentName: agent?.name,
        source: answering.autoRouted
          ? (answering.routeSource ?? 'model')
          : 'explicit',
        reason: answering.routeReason,
      } satisfies AgentRoutedPayload;

      const event = await this.persistEvent(
        task.taskId,
        task.streamId,
        StreamTaskEventType.AgentRouted,
        this.serializeTaskEventData({
          type: StreamTaskEventType.AgentRouted,
          taskId: task.taskId,
          streamId: task.streamId ?? undefined,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: StreamTaskStatus.PENDING.toLowerCase(),
          payload,
        }),
      );
      await this.recordConversationTraceEvent({
        userId: task.userId,
        taskId: task.taskId,
        streamId: task.streamId ?? undefined,
        conversationId: task.conversationId,
        messageId: task.messageId,
        eventName: StreamTaskEventType.AgentRouted,
        payload,
      });
      this.registry.publish(task.taskId, event.sseEvent);
    } catch (error) {
      this.logger.warn(
        `记录回答者指派失败（不影响发送）：${(error as Error).message}`,
      );
    }
  }

  /**
   * 构建群聊路由上下文
   * @param conversationId 会话ID
   * @returns 返回上一轮回答者与最近若干轮对话（时间正序）
   * @description 只看最新一条消息时，「再来一张」「换个风格」这类指代必然路由错人。
   * 取尾部少量消息供路由判断延续关系；查询范围刻意收紧（路由是低成本前置调用，
   * 不做完整上下文，那是 chat-context 的职责）。
   */
  private async buildGroupRouteContext(
    conversationId: string,
  ): Promise<GroupRouteContext> {
    const recent = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: GROUP_ROUTE_CONTEXT_MESSAGES,
      select: { role: true, content: true, agentId: true },
    });
    if (recent.length === 0) {
      return {};
    }

    const agentNames = await this.resolveAgentNames(
      recent
        .map((message) => message.agentId)
        .filter((id): id is string => Boolean(id)),
    );

    return {
      lastAgentId:
        recent.find(
          (message) =>
            message.role === MessageRole.ASSISTANT && Boolean(message.agentId),
        )?.agentId ?? undefined,
      // 查询是倒序，转成时间正序供模型阅读
      recentTurns: recent
        .slice()
        .reverse()
        .map((message) => ({
          role:
            message.role === MessageRole.ASSISTANT
              ? ('assistant' as const)
              : ('user' as const),
          content: message.content,
          agentName: message.agentId
            ? agentNames.get(message.agentId)
            : undefined,
        })),
    };
  }

  /** 批量取 agent 名称（供路由上下文回显发言者） */
  private async resolveAgentNames(
    agentIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const agents = await this.prisma.agent.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, name: true },
    });
    return new Map(agents.map((agent) => [agent.id, agent.name]));
  }

  /**
   * 创建语音聊天任务
   * @param conversationId 会话ID
   * @param audioBuffer 音频二进制数据
   * @param filename 音频文件名
   * @param userId 用户ID
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 先将音频转写成文本，再复用文本任务创建逻辑锁定本条消息的模型选择。
   */
  async createVoiceTask(
    conversationId: string | undefined,
    audioBuffer: Buffer,
    filename: string,
    userId: string,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    agentId?: string,
  ) {
    const content = await this.aiService.transcribeAudio(audioBuffer, filename);
    return this.createTextTask(
      conversationId,
      content,
      userId,
      StreamTaskType.VOICE_COMPLETION,
      selectedModelPresetId,
      reasoning,
      agentId,
    );
  }

  /**
   * 创建文本类型的 流式任务
   * @param conversationId 会话ID
   * @param content 消息内容
   * @param userId 用户ID
   * @param type 任务类型
   * @param selectedModelPresetId 本条消息选择的 Agent 允许模型预设业务标识
   * @returns 返回任务信息，包含 taskId、messageId 和初始状态
   * @description 在一个事务内写入消息、Flow 快照与任务；只持久化解析后的稳定模型预设标识，不保存 URL、生成参数或密钥。
   */
  private async createTextTask(
    conversationId: string | undefined,
    content: string,
    userId: string,
    type: StreamTaskType,
    selectedModelPresetId?: string,
    reasoning?: ReasoningSelection,
    agentId?: string,
    isTest = false,
  ) {
    const mcdonaldsCredentialId =
      await this.mcdonaldsCredentialService.getActiveCredentialId(userId);

    const result = await this.prisma.$transaction(async (tx) => {
      const targetConversationId = await this.resolveConversationId(
        tx,
        conversationId,
        userId,
        isTest,
        agentId,
      );

      await this.enforceAgentAccess(tx, userId, agentId, isTest);

      //消息入库
      await tx.message.create({
        data: {
          role: MessageRole.USER,
          content,
          status: MessageStatus.DONE,
          conversationId: targetConversationId,
        },
      });

      //统计用户消息数量
      const userMessageCount = await tx.message.count({
        where: { conversationId: targetConversationId, role: MessageRole.USER },
      });

      if (userMessageCount === 1) {
        await tx.conversation.update({
          where: { id: targetConversationId },
          data: { title: content.slice(0, 20) },
        });
      }

      // 先锁定 Flow 快照：它会把「没指定 Agent」回落到 isDefault，而助手消息与流式任务
      // 都必须记录那个**真实执行者**。只在解析时用回落结果、不写回去的话，任务上的
      // agentId 仍是 null，Activity 读不到模型与人设，会以快照不一致失败。
      const flowSnapshot =
        await this.flowTaskDispatcher.resolveTaskFlowSnapshot(tx, {
          agentId,
          selectedModelPresetId,
          reasoning,
        });
      const requestPayload = JSON.parse(
        JSON.stringify({
          content,
          agentId: flowSnapshot.agentId,
          mcdonaldsCredentialId,
        }),
      ) as Prisma.JsonObject;

      //assistant 消息入库（agentId 记录发言者，供群聊消息归属与身份感知上下文）
      const assistantMessage = await tx.message.create({
        data: {
          role: MessageRole.ASSISTANT,
          content: '',
          status: MessageStatus.STREAMING,
          conversationId: targetConversationId,
          agentId: flowSnapshot.agentId,
        },
      });

      // 首次被 @ 的智能体自动加入群成员（仅 GROUP；幂等）。SINGLE 保持绑定语义不动。
      // 这里刻意用入参 agentId 而不是快照里的：回落到的默认 Agent 没被 @ 过，
      // 不该因为回答了一句就成为群成员。
      if (agentId) {
        await tx.conversation.updateMany({
          where: {
            id: targetConversationId,
            type: ConversationType.GROUP,
            NOT: { agentIds: { has: agentId } },
          },
          data: { agentIds: { push: agentId } },
        });
      }

      //流式任务入库
      const task = await tx.streamTask.create({
        data: {
          type,
          status: StreamTaskStatus.PENDING,
          userId,
          isTest,
          conversationId: targetConversationId,
          messageId: assistantMessage.id,
          requestPayload,
          // agentId 来自快照（可能是回落到的 isDefault Agent），不是入参
          ...flowSnapshot,
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        },
      });

      const stream = await tx.streamTaskRun.create({
        data: {
          taskId: task.id,
          sequence: 1,
          status: StreamTaskRunStatus.PENDING,
          trigger: INITIAL_STREAM_TRIGGER,
        },
      });

      await tx.streamTask.update({
        where: { id: task.id },
        data: { currentRunId: stream.id },
      });

      return {
        task,
        stream,
        assistantMessage,
        conversationId: targetConversationId,
      };
    });

    if (result.task.flowVersionId && result.task.flowDigest) {
      await this.flowTaskDispatcher.dispatch({
        taskId: result.task.id,
        flowVersionId: result.task.flowVersionId,
        flowDigest: result.task.flowDigest,
        temporalWorkflowId: result.task.temporalWorkflowId,
        temporalRunId: result.task.temporalRunId,
      });
    }

    return {
      taskId: result.task.id,
      streamId: result.stream.id,
      messageId: result.assistantMessage.id,
      conversationId: result.conversationId,
      status: result.task.status.toLowerCase(),
    } satisfies CreatedTaskResult;
  }

  /**
   * 在任务事务内强制校验智能体资格
   * @param tx 当前 StreamTask 创建事务客户端
   * @param userId 当前用户ID
   * @param agentId 显式回答智能体ID；为空时检查全局默认智能体
   * @param isTest 是否为 Admin 调试任务
   * @returns 无返回值
   * @description 任务写入前重新读取用户和智能体事实；Admin 调试仅绕过会员等级，停用智能体仍然拒绝。
   */
  private async enforceAgentAccess(
    tx: Prisma.TransactionClient,
    userId: string,
    agentId: string | undefined,
    isTest: boolean,
  ): Promise<void> {
    const agent = agentId
      ? await tx.agent.findUnique({
          where: { id: agentId },
          select: {
            id: true,
            enabled: true,
            minimumMembershipTier: true,
          },
        })
      : await tx.agent.findFirst({
          where: { isDefault: true },
          select: {
            id: true,
            enabled: true,
            minimumMembershipTier: true,
          },
        });
    if (!agent) {
      throw new BadRequestException(
        agentId ? '指定的智能体不存在或已停用' : '系统未配置默认智能体',
      );
    }
    if (isTest) {
      if (!agent.enabled) {
        throw new BadRequestException('停用的智能体不可调试');
      }
      return;
    }

    const subject = await tx.user.findUnique({
      where: { id: userId },
      select: { membershipTier: true, membershipExpiresAt: true },
    });
    if (!subject) {
      throw new NotFoundException('用户不存在');
    }

    const decision = this.agentAccessService.evaluate(subject, agent);
    if (decision.canUse) {
      return;
    }
    if (decision.reason === AgentAccessDenialReason.Disabled) {
      throw new ForbiddenException({
        code: decision.reason,
        message: '智能体已停用',
      });
    }
    throw new ForbiddenException({
      code: decision.reason,
      requiredTier: decision.requiredTier,
      effectiveTier: decision.effectiveTier,
      message:
        decision.reason === AgentAccessDenialReason.MembershipExpired
          ? `会员已到期，需要 ${decision.requiredTier} 会员`
          : `当前会员等级不足，需要 ${decision.requiredTier} 会员`,
    });
  }

  /**
   * 解析会话ID
   * @param tx Prisma 事务客户端
   * @param conversationId 会话ID
   * @param userId 用户ID
   * @returns 返回可用于本次任务的会话ID
   * @description 当请求未传会话ID时自动创建新会话；若已传，则在事务内校验该会话属于当前用户，保证首轮消息和会话创建在同一链路中闭环。
   */
  private async resolveConversationId(
    tx: Prisma.TransactionClient,
    conversationId: string | undefined,
    userId: string,
    isTest = false,
    agentId?: string,
  ): Promise<string> {
    if (!conversationId) {
      // 隐式创建一律 SINGLE：带 agentId 即绑定该智能体为默认回答者
      const conversation = await tx.conversation.create({
        data: {
          userId,
          title: '新对话',
          isTest,
          ...(agentId ? { agentIds: [agentId], defaultAgentId: agentId } : {}),
        },
      });

      return conversation.id;
    }

    const conversation = await tx.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
      },
      select: {
        id: true,
        isTest: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    // 双向防串：测试任务只能续接测试会话，真实任务只能续接真实会话。
    if (conversation.isTest !== isTest) {
      throw new BadRequestException(
        isTest
          ? '测试模式不能续接真实会话'
          : '该会话为测试会话，不能在正常聊天中使用',
      );
    }

    return conversation.id;
  }

  /**
   * 查询任务状态
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回任务详情信息，包括状态、会话ID、最后事件ID、累计内容和过期时间等
   * @description 加载指定 流式任务，并返回前端恢复流或展示状态所需的全部关键信息。
   */
  async getTaskStatus(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);
    return {
      taskId: task.id,
      streamId: task.currentRunId,
      type: task.type.toLowerCase(),
      status: task.status.toLowerCase(),
      conversationId: this.requireConversationId(task),
      messageId: this.requireMessageId(task),
      lastEventId: task.lastEventId,
      fullContent: task.fullContent,
      errorMessage: task.errorMessage,
      canResume:
        !this.isTerminalStatus(task.status) &&
        (!task.expiresAt || task.expiresAt > new Date()),
      expiresAt: task.expiresAt?.getTime() ?? null,
      updatedAt: task.updatedAt.getTime(),
    };
  }

  /**
   * 取消任务
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回任务取消结果，包含 taskId 和最新状态
   * @description 对未进入终态的任务发送取消事件并更新任务、消息状态；若任务已结束，则直接返回当前状态。
   */
  async cancelTask(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);

    if (this.isTerminalStatus(task.status)) {
      return { taskId, status: task.status.toLowerCase() };
    }

    const conversationId = this.requireConversationId(task);
    const messageId = this.requireMessageId(task);
    const event = await this.persistEvent(
      taskId,
      task.currentRunId,
      StreamTaskEventType.TaskCanceled,
      this.serializeTaskEventData({
        type: StreamTaskEventType.TaskCanceled,
        taskId,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: StreamTaskStatus.CANCELED.toLowerCase(),
      }),
      {
        status: StreamTaskStatus.CANCELED,
        fullContent: task.fullContent,
      },
    );
    const abortedRunningTask = this.registry.abortRunning(
      taskId,
      TASK_CANCELED_REASON,
    );

    if (abortedRunningTask) {
      this.logger.debug(`Abort running provider stream for task ${taskId}`);
    }

    await this.prisma.$transaction([
      this.prisma.streamTask.update({
        where: { id: taskId },
        data: {
          status: StreamTaskStatus.CANCELED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          fullContent: task.fullContent,
        },
      }),
      ...(task.currentRunId
        ? [
            this.prisma.streamTaskRun.update({
              where: { id: task.currentRunId },
              data: {
                status: StreamTaskRunStatus.CANCELED,
                endedAt: new Date(),
                closeReason: 'task_canceled',
                endEventId: event.eventId,
              },
            }),
          ]
        : []),
      this.prisma.message.update({
        where: { id: messageId },
        data: {
          content: task.fullContent || '生成已取消',
          status: MessageStatus.ERROR,
        },
      }),
    ]);

    await this.snapshotService.markCompleted(taskId);
    this.registry.publish(taskId, event.sseEvent);
    return { taskId, status: 'canceled' };
  }

  /**
   * 恢复任务流
   * @param taskId 任务ID
   * @param userId 用户ID
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回包含异步流式事件的对象
   * @description 校验任务状态并根据游标恢复事件流；若任务已过期，则返回单个过期事件流。
   */
  async openTaskStream(
    taskId: string,
    userId: string,
    lastEventId: string,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    const task = await this.loadTask(taskId, userId);

    //任务过期
    if (
      task.status === StreamTaskStatus.EXPIRED ||
      (task.expiresAt && task.expiresAt <= new Date())
    ) {
      await this.expireTask(task.id);
      return {
        stream: this.singleEventStream(
          this.buildTaskSseEvent(
            this.nextSyntheticFrameId(lastEventId),
            StreamTaskEventType.TaskExpired,
            {
              taskId,
              streamId: task.currentRunId ?? undefined,
              conversationId: this.requireConversationId(task),
              messageId: this.requireMessageId(task),
              status: StreamTaskStatus.EXPIRED.toLowerCase(),
            },
          ),
        ),
      };
    }

    const stream = this.createTaskStream(task.id, lastEventId, signal);
    return { stream };
  }

  /**
   * 提交人工审批决定并恢复流式任务（HITL）
   * @param taskId 任务ID
   * @param userId 用户ID
   * @param decision 人工审批决定（approve/reject/edit）
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回续跑的 SSE 事件流
   * @description 仅对处于 WAITING_HUMAN 的任务生效：持久化决定后复用任务执行/流式机制，
   * 由 runChatTask 检测到决定后走 Command 恢复续跑。
   */
  async resumeTaskWithDecision(
    taskId: string,
    userId: string,
    decision: ApprovalDecision,
    lastEventId: string,
    signal?: AbortSignal,
    approvalId?: string,
  ): Promise<TaskStreamResult> {
    const task = await this.loadWaitingTask(taskId, userId);

    if (task.flowVersionId) {
      return this.resumeFlowTaskWithDecision(
        task,
        userId,
        approvalId,
        AgentFlowApprovalKind.TOOL,
        this.toInputJsonValue(decision),
        lastEventId,
        signal,
      );
    }

    await this.storePendingApprovalDecision(taskId, decision);
    // 在开流之前落事件：客户端带着旧 lastEventId 续读，照样能收到。
    // 不发的话 trace 会永远停在「待人工确认」，看不出批没批、谁批的。
    await this.recordApprovalResolved(task, userId, decision);

    const stream = this.createTaskStream(task.id, lastEventId, signal);
    return { stream };
  }

  /**
   * 提交计划审批决定并恢复流式任务（plan_execute HITL）
   * @param taskId 任务ID
   * @param userId 用户ID
   * @param decision 计划审批决定（approve/edit/reject_replan/reject_terminate）
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回续跑的 SSE 事件流
   * @description 与工具审批共用 WAITING_HUMAN 状态机与续跑管道，只是决定形状与 Redis 通道不同：
   * 决定落 `hitl:plan-review:<taskId>`，由 runChatTask 读到后走计划审批恢复分支。
   */
  async resumeTaskWithPlanReview(
    taskId: string,
    userId: string,
    decision: PlanReviewDecision,
    lastEventId: string,
    signal?: AbortSignal,
    approvalId?: string,
  ): Promise<TaskStreamResult> {
    const task = await this.loadWaitingTask(taskId, userId);

    if (task.flowVersionId) {
      return this.resumeFlowTaskWithDecision(
        task,
        userId,
        approvalId,
        AgentFlowApprovalKind.PLAN_REVIEW,
        this.toInputJsonValue(decision),
        lastEventId,
        signal,
      );
    }

    await this.storePendingPlanReviewDecision(taskId, decision);
    await this.recordPlanReviewResolved(task, userId, decision);

    const stream = this.createTaskStream(task.id, lastEventId, signal);
    return { stream };
  }

  /**
   * 加载并校验处于待人工审批态的任务
   * @description 工具审批与计划审批共用：非 WAITING_HUMAN 一律拒绝。
   */
  private async loadWaitingTask(taskId: string, userId: string) {
    const task = await this.loadTask(taskId, userId);
    if (task.status !== StreamTaskStatus.WAITING_HUMAN) {
      throw new BadRequestException('任务当前不处于待人工审批状态');
    }
    return task;
  }

  /**
   * 提交 AgentFlow 审批决定并等待 Temporal 从持久化事实恢复
   * @param task 已校验且正处于 WAITING_HUMAN 的 Flow 任务
   * @param userId 当前审批用户ID
   * @param approvalId Flow 审批事实的稳定标识
   * @param kind 当前 HTTP 入口对应的审批类型
   * @param decision 已序列化的审批决定
   * @param lastEventId 客户端已收到的 Redis Stream 游标
   * @param signal 当前 SSE 请求中断信号
   * @returns 返回只订阅/回放 Flow 帧的 SSE 流
   * @description Flow 任务不再写 Redis HITL 决定键或触发进程内 LangGraph 续跑。决定、trace、语义事件与 outbox 已由审批服务原子提交，outbox 仅向 Temporal 发送 approvalId。
   */
  private async resumeFlowTaskWithDecision(
    task: Prisma.StreamTaskGetPayload<object>,
    userId: string,
    approvalId: string | undefined,
    kind: AgentFlowApprovalKind,
    decision: Prisma.InputJsonValue,
    lastEventId: string,
    signal?: AbortSignal,
  ): Promise<TaskStreamResult> {
    if (!approvalId) {
      throw new BadRequestException('Flow 任务提交审批时必须提供 approvalId');
    }
    await this.agentFlowApprovalService.decideAndQueueSignal({
      taskId: task.id,
      approvalId,
      actorId: userId,
      kind,
      decision,
    });
    await this.agentFlowSignalOutboxService.dispatchPending();

    return {
      stream: this.createTaskStream(task.id, lastEventId, signal),
    };
  }

  /**
   * 记录人工审批结果
   * @param task 任务
   * @param userId 决定人
   * @param decision 人工决定
   * @returns 无返回值
   * @description 复用待审批 trace 项的 traceKey，使这条结果收敛到同一条 trace 而非另起一条。
   * 审批属审计语义，失败只告警不阻断续跑——决定已落 Redis，链路必须继续。
   */
  private async recordApprovalResolved(
    task: Prisma.StreamTaskGetPayload<object>,
    userId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    try {
      const conversationId = this.requireConversationId(task);
      const messageId = this.requireMessageId(task);
      const pending =
        await this.conversationTraceService.findPendingApprovalItem(task.id);

      const payload = {
        decision: decision.decision,
        decidedBy: userId,
        toolName: pending?.toolName ?? undefined,
        editedArgs: decision.editedArgs
          ? JSON.stringify(decision.editedArgs)
          : undefined,
        reason: decision.reason,
        nodeKey: pending?.nodeKey ?? 'common_chat_approval',
        traceKey: pending?.traceKey ?? 'approval',
        publicStatus: APPROVAL_DECISION_LABELS[decision.decision],
      } satisfies ApprovalResolvedPayload;

      const event = await this.persistEvent(
        task.id,
        task.currentRunId,
        StreamTaskEventType.ApprovalResolved,
        this.serializeTaskEventData({
          type: StreamTaskEventType.ApprovalResolved,
          taskId: task.id,
          streamId: task.currentRunId ?? undefined,
          conversationId,
          messageId,
          status: StreamTaskStatus.WAITING_HUMAN.toLowerCase(),
          payload,
        }),
      );
      await this.recordConversationTraceEvent({
        userId: task.userId,
        taskId: task.id,
        streamId: task.currentRunId,
        conversationId,
        messageId,
        eventName: StreamTaskEventType.ApprovalResolved,
        payload,
      });
      this.registry.publish(task.id, event.sseEvent);
    } catch (error) {
      this.logger.warn(
        `记录人工审批结果失败（不影响续跑）：${(error as Error).message}`,
      );
    }
  }

  /**
   * 记录计划审批结果
   * @description 与工具审批同构：复用待审批 trace 项的 traceKey 收敛到同一条 trace。
   * 计划审批 trace 项复用 APPROVAL 类型（避免枚举迁移），靠 nodeKey=plan_review 区分。
   * 失败只告警不阻断续跑——决定已落 Redis。
   */
  private async recordPlanReviewResolved(
    task: Prisma.StreamTaskGetPayload<object>,
    userId: string,
    decision: PlanReviewDecision,
  ): Promise<void> {
    try {
      const conversationId = this.requireConversationId(task);
      const messageId = this.requireMessageId(task);
      const pending =
        await this.conversationTraceService.findPendingApprovalItem(task.id);

      const payload = {
        decision: decision.decision,
        decidedBy: userId,
        stepCount: decision.editedSteps?.length,
        feedback: decision.feedback,
        nodeKey: pending?.nodeKey ?? 'plan_review',
        traceKey: pending?.traceKey ?? 'plan-review',
        publicStatus: PLAN_REVIEW_DECISION_LABELS[decision.decision],
      } satisfies PlanReviewResolvedPayload;

      const event = await this.persistEvent(
        task.id,
        task.currentRunId,
        StreamTaskEventType.PlanReviewResolved,
        this.serializeTaskEventData({
          type: StreamTaskEventType.PlanReviewResolved,
          taskId: task.id,
          streamId: task.currentRunId ?? undefined,
          conversationId,
          messageId,
          status: StreamTaskStatus.WAITING_HUMAN.toLowerCase(),
          payload,
        }),
      );
      await this.recordConversationTraceEvent({
        userId: task.userId,
        taskId: task.id,
        streamId: task.currentRunId,
        conversationId,
        messageId,
        eventName: StreamTaskEventType.PlanReviewResolved,
        payload,
      });
      this.registry.publish(task.id, event.sseEvent);
    } catch (error) {
      this.logger.warn(
        `记录计划审批结果失败（不影响续跑）：${(error as Error).message}`,
      );
    }
  }

  /**
   * 暂存人工审批决定
   * @description 写入 Redis（TTL 复用缓冲期），供后台恢复执行读取一次后消费。
   */
  private async storePendingApprovalDecision(
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.redis.set(
      `hitl:approval:${taskId}`,
      JSON.stringify(decision),
      'EX',
      this.bufferTtl,
    );
  }

  /** 暂存计划审批决定（独立 Redis 通道，与工具审批区分） */
  private async storePendingPlanReviewDecision(
    taskId: string,
    decision: PlanReviewDecision,
  ): Promise<void> {
    await this.redis.set(
      `hitl:plan-review:${taskId}`,
      JSON.stringify(decision),
      'EX',
      this.bufferTtl,
    );
  }

  /**
   * 读取并消费待处理的人工审批决定
   * @returns 存在则返回决定并从 Redis 删除；否则返回 undefined
   */
  private async readPendingApprovalDecision(
    taskId: string,
  ): Promise<ApprovalDecision | undefined> {
    const key = `hitl:approval:${taskId}`;
    const raw = await this.redis.get(key);
    if (!raw) {
      return undefined;
    }
    await this.redis.del(key);
    try {
      return JSON.parse(raw) as ApprovalDecision;
    } catch {
      return undefined;
    }
  }

  /** 读取并消费待处理的计划审批决定 */
  private async readPendingPlanReviewDecision(
    taskId: string,
  ): Promise<PlanReviewDecision | undefined> {
    const key = `hitl:plan-review:${taskId}`;
    const raw = await this.redis.get(key);
    if (!raw) {
      return undefined;
    }
    await this.redis.del(key);
    try {
      return JSON.parse(raw) as PlanReviewDecision;
    } catch {
      return undefined;
    }
  }

  /**
   * 创建任务事件流
   * @param taskId 任务ID
   * @param lastEventId 客户端已接收的最后事件ID
   * @param signal 连接中断信号
   * @returns 返回可迭代的流式事件
   * @description 先重放 Redis 缓冲中的历史事件，再订阅内存中的实时事件，并按需触发任务执行。
   */
  private async *createTaskStream(
    taskId: string,
    lastEventId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    let lastSeenFrameId = this.normalizeFrameId(lastEventId);

    const replayed = await this.snapshotService.readBufferedFramesAfter(
      taskId,
      lastSeenFrameId,
    );
    for (const event of replayed) {
      lastSeenFrameId = event.id;
      yield event;
      if (this.isTerminalEvent(event.event)) {
        return;
      }
    }

    const currentTask = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });
    if (currentTask && this.isTerminalStatus(currentTask.status)) {
      yield* this.buildTerminalFallbackStream(currentTask, lastSeenFrameId);
      return;
    }

    await this.ensureTaskExecution(taskId);

    for await (const event of this.snapshotService.readFramesAfter(
      taskId,
      lastSeenFrameId,
      signal,
    )) {
      yield event;

      if (this.isTerminalEvent(event.event)) {
        return;
      }
    }
  }

  /**
   * 确保任务开始执行
   * @param taskId 任务ID
   * @returns 无返回值
   * @description 通过内存标记和 Redis 分布式锁保证同一个任务在同一时刻只会被一个生产者执行。
   */
  private async ensureTaskExecution(taskId: string) {
    const flowTask = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        flowVersionId: true,
        flowDigest: true,
        temporalWorkflowId: true,
        temporalRunId: true,
      },
    });
    if (flowTask?.flowVersionId && flowTask.flowDigest) {
      await this.flowTaskDispatcher.dispatch({
        taskId: flowTask.id,
        flowVersionId: flowTask.flowVersionId,
        flowDigest: flowTask.flowDigest,
        temporalWorkflowId: flowTask.temporalWorkflowId,
        temporalRunId: flowTask.temporalRunId,
      });
      return;
    }

    if (this.registry.isRunning(taskId)) {
      return;
    }

    const executionAbortController = new AbortController();
    const lockValue = randomUUID();
    const lockKey = `${this.lockKeyPrefix}:${taskId}`;
    const acquired = await this.redis.set(lockKey, lockValue, 'EX', 300, 'NX');
    if (acquired !== 'OK') {
      return;
    }

    this.registry.markRunning(taskId, executionAbortController);

    void this.runTask(
      taskId,
      lockKey,
      lockValue,
      executionAbortController.signal,
    ).finally(() => {
      this.registry.clearRunning(taskId);
    });
  }

  /**
   * 执行任务主体
   * @param taskId 任务ID
   * @param lockKey Redis 锁 Key
   * @param lockValue Redis 锁值
   * @param executionSignal 执行中断信号
   * @returns 无返回值
   * @description 加载任务、更新状态为执行中，发布 started 事件，并根据任务类型分派到实际执行逻辑。
   */
  private async runTask(
    taskId: string,
    lockKey: string,
    lockValue: string,
    executionSignal: AbortSignal,
  ) {
    try {
      const task = await this.prisma.streamTask.findUnique({
        where: { id: taskId },
      });

      if (!task || this.isTerminalStatus(task.status)) {
        return;
      }

      const stream = await this.ensureCurrentStream(task.id);

      await this.prisma.$transaction([
        this.prisma.streamTask.update({
          where: { id: taskId },
          data: {
            status: StreamTaskStatus.STREAMING,
            startedAt: task.startedAt ?? new Date(),
            currentRunId: stream.id,
            currentAgent: 'common-chat-agent',
            currentStep: 'streaming',
          },
        }),
        this.prisma.streamTaskRun.update({
          where: { id: stream.id },
          data: {
            status: StreamTaskRunStatus.STREAMING,
            startedAt: stream.startedAt ?? new Date(),
          },
        }),
      ]);

      const conversationId = this.requireConversationId(task);
      const messageId = this.requireMessageId(task);

      const startedEvent = await this.persistEvent(
        taskId,
        stream.id,
        StreamTaskEventType.TaskStarted,
        this.serializeTaskEventData({
          type: StreamTaskEventType.TaskStarted,
          taskId,
          streamId: stream.id,
          conversationId,
          messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
        }),
      );
      await this.recordConversationTraceEvent({
        userId: task.userId,
        taskId,
        streamId: stream.id,
        conversationId,
        messageId,
        eventName: StreamTaskEventType.TaskStarted,
      });
      this.registry.publish(taskId, startedEvent.sseEvent);

      if (
        task.type === StreamTaskType.CHAT_COMPLETION ||
        task.type === StreamTaskType.VOICE_COMPLETION
      ) {
        await this.runChatTask(
          {
            id: task.id,
            userId: task.userId,
            streamId: stream.id,
            conversationId,
            messageId,
            requestPayload: task.requestPayload,
            executionState: task.executionState,
          },
          executionSignal,
        );
      }
    } catch (error) {
      if (await this.shouldIgnoreAbort(taskId, error, executionSignal)) {
        return;
      }

      const classified = classifyLlmError(error);
      this.logger.error(
        `Stream task failed: ${classified.message} (category=${classified.category}, status=${classified.status ?? 'n/a'})`,
      );
      await this.failTask(taskId, classified.message, {
        category: classified.category,
        retryable: classified.retryable,
        status: classified.status,
      });
    } finally {
      await this.releaseLock(lockKey, lockValue);
    }
  }

  /**
   * 确保任务存在当前执行流片段
   * @param taskId 任务ID
   * @returns 返回当前任务流片段
   * @description 当前单 agent 任务默认只创建一个流片段；后续人机协同时可在 continue 阶段创建新的流片段。
   */
  private async ensureCurrentStream(taskId: string) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: { currentRunId: true },
    });

    if (task?.currentRunId) {
      const stream = await this.prisma.streamTaskRun.findUnique({
        where: { id: task.currentRunId },
      });

      if (stream) {
        return stream;
      }
    }

    const latestStream = await this.prisma.streamTaskRun.findFirst({
      where: { taskId },
      orderBy: { sequence: 'desc' },
    });

    if (latestStream) {
      await this.prisma.streamTask.update({
        where: { id: taskId },
        data: { currentRunId: latestStream.id },
      });
      return latestStream;
    }

    const stream = await this.prisma.streamTaskRun.create({
      data: {
        taskId,
        sequence: 1,
        trigger: INITIAL_STREAM_TRIGGER,
      },
    });
    await this.prisma.streamTask.update({
      where: { id: taskId },
      data: { currentRunId: stream.id },
    });
    return stream;
  }

  /**
   * 执行聊天任务
   * @param task 聊天任务上下文
   * @param executionSignal 执行中断信号
   * @returns 无返回值
   * @description 读取会话历史并调用大模型流式生成回复，将增量内容、完成事件和最终内容持续写入任务状态与事件流。
   */
  private async runChatTask(
    task: {
      id: string;
      userId: string;
      streamId: string;
      conversationId: string;
      messageId: string;
      requestPayload: Prisma.JsonValue;
      executionState: Prisma.JsonValue;
    },
    executionSignal: AbortSignal,
  ) {
    const payload = task.requestPayload as unknown as ChatTaskPayload;

    if (!payload.content) {
      throw new Error('Missing chat task payload');
    }

    // 新会话首轮：与主回答并行生成 AI 标题（非首轮由服务内部判定直接跳过），
    // 生成后通过本任务的 SSE 流下发 conversation.title.updated，前端在回答
    // 流式输出期间即可更新标题；失败静默保留创建时的截断兜底。
    void this.publishConversationTitle(task);

    // HITL：存在待处理决定 → 走恢复路径（Command 续跑）；否则首轮执行。
    // 计划审批与工具审批各走独立 Redis 通道，先查计划审批（它在执行任何工具之前发生）。
    const pendingDecision =
      (await this.readPendingPlanReviewDecision(task.id)) ??
      (await this.readPendingApprovalDecision(task.id));
    const agentRun = pendingDecision
      ? await this.commonChatAgentRunnerService.resumeConversationRun({
          conversationId: task.conversationId,
          pendingMessageId: task.messageId,
          agentId: payload.agentId,
          taskId: task.id,
          userId: task.userId,
          mcdonaldsCredentialId: payload.mcdonaldsCredentialId,
          decision: pendingDecision,
          strategy: this.readExecutionStrategy(task.executionState),
          strategySnapshot: this.readExecutionStrategySnapshot(
            task.executionState,
          ),
          abortSignal: executionSignal,
        })
      : await this.commonChatAgentRunnerService.prepareConversationRun({
          conversationId: task.conversationId,
          pendingMessageId: task.messageId,
          agentId: payload.agentId,
          taskId: task.id,
          userId: task.userId,
          mcdonaldsCredentialId: payload.mcdonaldsCredentialId,
          abortSignal: executionSignal,
        });

    let fullContent = '';
    let deltaCount = 0;
    let emptyDeltaCount = 0;
    let pendingApproval = false;
    let lastFullContentFlushAt = Date.now();
    let lastFlushedFullContentLength = 0;
    let modelCallCount = 0;
    let modelTokenUsage: LlmTokenUsageMetrics | undefined;
    let executionState = task.executionState;
    const persistedModelRunMetrics =
      this.readPersistedModelRunMetrics(executionState);
    const startedAt = Date.now();

    this.debugTaskLog('stream_task.chat.agent_start', {
      taskId: task.id,
      conversationId: task.conversationId,
      messageId: task.messageId,
      messageCount: agentRun.messages.length,
      hasSystemPrompt: Boolean(agentRun.systemPrompt),
      toolCount: agentRun.tools.length,
      hasSummary: Boolean(agentRun.context.summary),
      summaryMessageCount: agentRun.context.summary?.messageCount,
      recentMessageCount: agentRun.context.recentWindow.messageCount,
      recentMessageLimit: agentRun.context.recentWindow.limit,
    });

    // 在模型调用计数上下文内消费 agent 事件流：ReAct 内部多次模型往返由 chat-model.factory
    // 挂的回调在此上下文累计，循环结束后读取（trace 无法覆盖折叠在消息流里的往返）。
    await runWithModelCallContext(
      task.id,
      () =>
        runWithMcDonaldsOrderContext(
          task.id,
          task.userId,
          async () => {
            for await (const event of agentRun.events) {
              if (event.type === StreamTaskEventType.ToolCallDelta) {
                await this.handleToolCallDeltaEvent(task, event);
                continue;
              }

              if (event.type !== StreamTaskEventType.MessageDelta) {
                if (
                  event.type === StreamTaskEventType.ApprovalRequired ||
                  event.type === StreamTaskEventType.PlanReviewRequired
                ) {
                  pendingApproval = true;
                }
                if (event.type === StreamTaskEventType.StrategySelected) {
                  executionState = await this.persistExecutionStrategy(
                    task.id,
                    event.payload,
                    payload.mcdonaldsCredentialId,
                    executionState,
                  );
                }
                await this.handleAgentLoopStatusEvent(task, event);
                continue;
              }

              if (!event.delta) {
                emptyDeltaCount++;
                continue;
              }

              deltaCount++;
              fullContent += event.delta;
              const deltaEvent = await this.publishFrame(
                task.id,
                StreamTaskEventType.MessageDelta,
                this.serializeTaskEventData({
                  type: StreamTaskEventType.MessageDelta,
                  taskId: task.id,
                  streamId: task.streamId,
                  conversationId: task.conversationId,
                  messageId: task.messageId,
                  status: StreamTaskStatus.STREAMING.toLowerCase(),
                  payload: {
                    delta: event.delta,
                  },
                }),
              );
              const flushResult = await this.maybeFlushFullContent({
                taskId: task.id,
                fullContent,
                lastFlushAt: lastFullContentFlushAt,
                lastFlushedLength: lastFlushedFullContentLength,
              });
              lastFullContentFlushAt = flushResult.lastFlushAt;
              lastFlushedFullContentLength = flushResult.lastFlushedLength;
              this.registry.publish(task.id, deltaEvent);
            }

            const mergedModelRunMetrics = this.mergeModelRunMetrics(
              persistedModelRunMetrics,
              {
                modelCallCount: getModelCallCount(),
                tokenUsage: getModelCallTokenUsage(),
              },
            );
            modelCallCount = mergedModelRunMetrics.modelCallCount;
            modelTokenUsage = mergedModelRunMetrics.tokenUsage;
            executionState = this.withPersistedModelRunMetrics(
              executionState,
              mergedModelRunMetrics,
            );
          },
          {
            conversationId: task.conversationId,
            messageId: task.messageId,
          },
          { mcdonaldsCredentialId: payload.mcdonaldsCredentialId },
        ),
      task.userId,
    );

    if (executionSignal.aborted) {
      throw executionSignal.reason;
    }

    // HITL：agent 在工具执行前中断并已发出 approval.required。任务转入等待人工审批，
    // 不落 message.done / COMPLETED；由 :taskId/approval 端点带人工决定恢复续跑。
    if (pendingApproval) {
      await this.prisma.streamTask.update({
        where: { id: task.id },
        data: {
          status: StreamTaskStatus.WAITING_HUMAN,
          fullContent,
          currentStep: 'waiting_human',
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          executionState: this.toExecutionStateObject(executionState),
        },
      });
      this.debugTaskLog('stream_task.chat.waiting_human', {
        taskId: task.id,
        conversationId: task.conversationId,
        messageId: task.messageId,
        deltaCount,
        fullContentLength: fullContent.length,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const completionWarning =
      fullContent.trim().length === 0 ? EMPTY_ASSISTANT_CONTENT : undefined;
    const finalContent = completionWarning ?? fullContent;
    const toolCallCount = await this.countTaskToolCalls(task.id);
    const runMetrics = {
      ...this.buildChatRunMetrics(
        agentRun.messages,
        finalContent,
        agentRun.context,
        Date.now() - startedAt,
        modelTokenUsage,
      ),
      // 单轮调用计数：tool 从 trace 聚合（准确），model 从计数上下文累计（含 ReAct 内部往返）。
      toolCallCount,
      modelCallCount,
    };

    if (completionWarning) {
      this.logger.warn(
        this.formatTaskLog('stream_task.chat.empty_completion', {
          taskId: task.id,
          conversationId: task.conversationId,
          messageId: task.messageId,
          deltaCount,
          emptyDeltaCount,
          fullContentLength: fullContent.length,
          durationMs: Date.now() - startedAt,
        }),
      );
    } else {
      this.debugTaskLog('stream_task.chat.agent_completed', {
        taskId: task.id,
        conversationId: task.conversationId,
        messageId: task.messageId,
        deltaCount,
        emptyDeltaCount,
        fullContentLength: fullContent.length,
        durationMs: Date.now() - startedAt,
      });
    }

    const doneEvent = await this.persistEvent(
      task.id,
      task.streamId,
      StreamTaskEventType.MessageDone,
      this.serializeTaskEventData({
        type: StreamTaskEventType.MessageDone,
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.COMPLETED.toLowerCase(),
        payload: {
          content: finalContent,
          warning: completionWarning,
          metrics: runMetrics,
        },
      }),
      {
        fullContent: finalContent,
        status: StreamTaskStatus.COMPLETED,
      },
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: StreamTaskEventType.MessageDone,
      payload: {
        content: finalContent,
        warning: completionWarning,
        metrics: runMetrics,
      },
    });

    await this.prisma.$transaction([
      this.prisma.message.update({
        where: { id: task.messageId },
        data: {
          content: finalContent,
          status: MessageStatus.DONE,
        },
      }),
      this.prisma.conversation.update({
        where: { id: task.conversationId },
        data: { updatedAt: new Date() },
      }),
      this.prisma.streamTask.update({
        where: { id: task.id },
        data: {
          status: StreamTaskStatus.COMPLETED,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          fullContent: finalContent,
          resultPayload: JSON.parse(
            JSON.stringify({
              content: finalContent,
              warning: completionWarning,
              metrics: runMetrics,
            }),
          ) as Prisma.JsonObject,
          currentStep: 'completed',
        },
      }),
    ]);

    this.registry.publish(task.id, doneEvent.sseEvent);

    const completedEvent = await this.persistEvent(
      task.id,
      task.streamId,
      StreamTaskEventType.TaskCompleted,
      this.serializeTaskEventData({
        type: StreamTaskEventType.TaskCompleted,
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.COMPLETED.toLowerCase(),
        payload: {
          warning: completionWarning,
          deltaCount,
          fullContentLength: finalContent.length,
        },
      }),
      {
        fullContent: finalContent,
        status: StreamTaskStatus.COMPLETED,
      },
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: StreamTaskEventType.TaskCompleted,
      payload: {
        warning: completionWarning,
        deltaCount,
        fullContentLength: finalContent.length,
      },
    });
    this.registry.publish(task.id, completedEvent.sseEvent);
    await this.snapshotService.markCompleted(task.id);

    await this.prisma.streamTaskRun.update({
      where: { id: task.streamId },
      data: {
        status: StreamTaskRunStatus.COMPLETED,
        endedAt: new Date(),
        closeReason: 'task_completed',
        endEventId: completedEvent.eventId,
      },
    });

    void this.refreshConversationSummary(task.conversationId);
  }

  /**
   * 生成并下发新会话标题
   * @param task 聊天任务上下文
   * @returns 返回合并策略快照后的执行状态
   * @description 委托标题服务判定首轮并生成落库；成功后把标题作为语义事件写入
   * 本任务的事件流（入库 + Redis 帧，断线重放可达）。任何失败只打日志，不影响主链路。
   */
  private async publishConversationTitle(task: {
    id: string;
    streamId: string;
    conversationId: string;
    messageId: string;
  }) {
    try {
      const title =
        await this.conversationTitleService.generateTitleIfFirstTurn(
          task.conversationId,
        );
      if (!title) {
        return;
      }

      const titleEvent = await this.persistEvent(
        task.id,
        task.streamId,
        StreamTaskEventType.ConversationTitleUpdated,
        this.serializeTaskEventData({
          type: StreamTaskEventType.ConversationTitleUpdated,
          taskId: task.id,
          streamId: task.streamId,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
          payload: { conversationId: task.conversationId, title },
        }),
      );
      this.registry.publish(task.id, titleEvent.sseEvent);
    } catch (error) {
      this.logger.warn(
        `Publish conversation title failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 处理工具调用增量事件
   * @param task 聊天任务上下文
   * @param event agent 工具调用增量事件
   * @returns 无返回值
   * @description 将 agent 层的工具调用增量转发为 SSE 事件，后续工具执行和结果事件可以沿用同一通道扩展。
   */
  private async handleToolCallDeltaEvent(
    task: {
      id: string;
      userId: string;
      streamId: string;
      conversationId: string;
      messageId: string;
    },
    event: Extract<
      AgentLoopStreamEvent,
      { type: StreamTaskEventType.ToolCallDelta }
    >,
  ) {
    const toolEvent = await this.publishFrame(
      task.id,
      StreamTaskEventType.ToolCallDelta,
      this.serializeTaskEventData({
        type: StreamTaskEventType.ToolCallDelta,
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.STREAMING.toLowerCase(),
        payload: {
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          index: event.index,
        },
      }),
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: StreamTaskEventType.ToolCallDelta,
      payload: {
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        index: event.index,
      },
    });
    this.registry.publish(task.id, toolEvent);
  }

  /**
   * 处理 agent loop 状态事件
   * @param task 聊天任务上下文
   * @param event agent loop 状态事件
   * @returns 无返回值
   * @description 将策略选择、工作流步骤、模型调用等非文本事件转发为 SSE 事件，供前端展示当前 loop 正在做的事情。
   */
  /**
   * 记录本轮实际生效的执行策略
   * @param taskId 任务ID
   * @param strategy 路由决策选中的策略
   * @param executionState 当前任务的执行状态
   * @returns 无返回值
   * @description HITL 恢复必须交回**首轮那个策略图**——检查点里存的是它的图状态
   * （ReAct 存 agent 图、plan/hybrid 存编排图），换个形状就对不上。
   * 策略在路由时只决定一次，故在 strategy.selected 到达时落库。
   */
  private async persistExecutionStrategy(
    taskId: string,
    payload: Extract<
      AgentLoopStreamEvent,
      { type: StreamTaskEventType.StrategySelected }
    >['payload'],
    mcdonaldsCredentialId?: string,
    executionState: Prisma.JsonValue = {},
  ): Promise<Prisma.JsonObject> {
    const nextExecutionState: Prisma.JsonObject = {
      ...this.toExecutionStateObject(executionState),
      strategy: payload.mode,
      toolGroups: payload.toolGroups,
      skills: payload.skills,
      maxSteps: payload.maxSteps,
      ...(mcdonaldsCredentialId ? { mcdonaldsCredentialId } : {}),
    };
    await this.prisma.streamTask.update({
      where: { id: taskId },
      data: {
        executionState: nextExecutionState,
      },
    });
    return nextExecutionState;
  }

  /**
   * 读取暂停任务已累计的模型运行指标
   * @param executionState 任务持久化的执行状态
   * @returns 返回已完成执行段的模型次数与 token 用量
   * @description HITL 会把一次聊天拆成多段执行；本方法只读取本模块写入的
   * modelRunMetrics，旧任务或字段非法时按未累计处理，避免阻断人工审批恢复。
   */
  private readPersistedModelRunMetrics(
    executionState: Prisma.JsonValue,
  ): PersistedModelRunMetrics {
    const metrics = this.toExecutionStateObject(executionState).modelRunMetrics;
    const record = this.toExecutionStateObject(metrics);
    const modelCallCount = this.readNonNegativeMetricNumber(
      record.modelCallCount,
    );
    const tokenUsage = this.readPersistedTokenUsage(record.tokenUsage);

    return {
      modelCallCount: modelCallCount ?? 0,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  /**
   * 合并先前暂停段与当前执行段的模型运行指标
   * @param persisted 已持久化的历史执行段指标
   * @param current 当前执行段指标
   * @returns 返回整个任务截至当前的累计指标
   * @description 每次 HITL 恢复都会产生新的 AsyncLocalStorage 上下文，必须在任务边界
   * 显式合并，才能让最终 message.done 覆盖审批前后的全部模型调用。
   */
  private mergeModelRunMetrics(
    persisted: PersistedModelRunMetrics,
    current: PersistedModelRunMetrics,
  ): PersistedModelRunMetrics {
    const tokenUsage = this.mergeTokenUsage(
      persisted.tokenUsage,
      current.tokenUsage,
    );
    return {
      modelCallCount: persisted.modelCallCount + current.modelCallCount,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  /**
   * 将累计模型指标写入执行状态
   * @param executionState 当前任务执行状态
   * @param metrics 截至当前执行段的累计模型指标
   * @returns 返回保留策略快照后的新执行状态
   * @description 不覆盖 strategy、toolGroups、skills 等恢复所需字段，只追加本模块
   * 的 modelRunMetrics，供下一次 HITL 恢复继续累计。
   */
  private withPersistedModelRunMetrics(
    executionState: Prisma.JsonValue,
    metrics: PersistedModelRunMetrics,
  ): Prisma.JsonObject {
    return {
      ...this.toExecutionStateObject(executionState),
      modelRunMetrics: {
        modelCallCount: metrics.modelCallCount,
        ...(metrics.tokenUsage
          ? { tokenUsage: this.toPersistedTokenUsage(metrics.tokenUsage) }
          : {}),
      },
    };
  }

  /**
   * 合并两段 token 用量
   * @param persisted 已持久化的 token 用量
   * @param current 当前执行段 token 用量
   * @returns 返回累计 token 用量；两段均不存在时返回 undefined
   * @description 任一段使用估算时，累计结果必须保留 estimated=true；缓存和推理 token
   * 同样按供应商逐次返回值求和。
   */
  private mergeTokenUsage(
    persisted?: LlmTokenUsageMetrics,
    current?: LlmTokenUsageMetrics,
  ): LlmTokenUsageMetrics | undefined {
    if (!persisted) {
      return current;
    }
    if (!current) {
      return persisted;
    }

    const reasoningTokens =
      (persisted.reasoningTokens ?? 0) + (current.reasoningTokens ?? 0);
    return {
      inputTokens: (persisted.inputTokens ?? 0) + (current.inputTokens ?? 0),
      outputTokens: (persisted.outputTokens ?? 0) + (current.outputTokens ?? 0),
      totalTokens: (persisted.totalTokens ?? 0) + (current.totalTokens ?? 0),
      cachedInputTokens:
        (persisted.cachedInputTokens ?? 0) + (current.cachedInputTokens ?? 0),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      estimated: Boolean(persisted.estimated) || Boolean(current.estimated),
    };
  }

  /**
   * 将执行状态转换为 JSON 对象
   * @param executionState 待读取的 Prisma JSON 值
   * @returns 对象值；非对象或数组时返回空对象
   * @description 执行状态可能来自历史任务，读取前先收敛为对象，避免旧数据破坏
   * HITL 恢复与指标累计。
   */
  private toExecutionStateObject(
    executionState: Prisma.JsonValue | undefined,
  ): Prisma.JsonObject {
    return executionState &&
      typeof executionState === 'object' &&
      !Array.isArray(executionState)
      ? executionState
      : {};
  }

  /**
   * 解析已持久化的 token 用量
   * @param value executionState 中的 tokenUsage 字段
   * @returns 字段合法时返回 token 用量，否则返回 undefined
   * @description 数据库 JSON 不可信；只接受非负数字与布尔 estimated，避免异常
   * 历史数据被标为真实 usage。
   */
  private readPersistedTokenUsage(
    value: Prisma.JsonValue | undefined,
  ): LlmTokenUsageMetrics | undefined {
    const record = this.toExecutionStateObject(value);
    const inputTokens = this.readNonNegativeMetricNumber(record.inputTokens);
    const outputTokens = this.readNonNegativeMetricNumber(record.outputTokens);
    const totalTokens = this.readNonNegativeMetricNumber(record.totalTokens);
    const cachedInputTokens = this.readNonNegativeMetricNumber(
      record.cachedInputTokens,
    );
    const reasoningTokens = this.readNonNegativeMetricNumber(
      record.reasoningTokens,
    );
    const estimated =
      typeof record.estimated === 'boolean' ? record.estimated : undefined;

    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      totalTokens === undefined &&
      cachedInputTokens === undefined &&
      reasoningTokens === undefined &&
      estimated === undefined
    ) {
      return undefined;
    }

    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(estimated !== undefined ? { estimated } : {}),
    };
  }

  /**
   * 将 token 用量转换为可持久化 JSON
   * @param tokenUsage 待写入的 token 用量
   * @returns 返回移除 undefined 字段后的 JSON 对象
   * @description Prisma JSON 不接受 undefined，本方法只保留实际存在的指标字段。
   */
  private toPersistedTokenUsage(
    tokenUsage: LlmTokenUsageMetrics,
  ): Prisma.JsonObject {
    return {
      ...(tokenUsage.inputTokens !== undefined
        ? { inputTokens: tokenUsage.inputTokens }
        : {}),
      ...(tokenUsage.outputTokens !== undefined
        ? { outputTokens: tokenUsage.outputTokens }
        : {}),
      ...(tokenUsage.totalTokens !== undefined
        ? { totalTokens: tokenUsage.totalTokens }
        : {}),
      ...(tokenUsage.cachedInputTokens !== undefined
        ? { cachedInputTokens: tokenUsage.cachedInputTokens }
        : {}),
      ...(tokenUsage.reasoningTokens !== undefined
        ? { reasoningTokens: tokenUsage.reasoningTokens }
        : {}),
      ...(tokenUsage.estimated !== undefined
        ? { estimated: tokenUsage.estimated }
        : {}),
    };
  }

  /**
   * 读取非负指标数值
   * @param value 待解析的 JSON 字段
   * @returns 有效数字时返回数值，否则返回 undefined
   */
  private readNonNegativeMetricNumber(
    value: Prisma.JsonValue | undefined,
  ): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }

  /**
   * 读取首轮能力快照
   * @param executionState 任务的执行状态列
   * @returns 快照完整且合法时返回；旧任务或非法数据返回 undefined
   * @description `strategy` 只能保证图形状一致，`toolGroups`、`skills` 与 `maxSteps` 才能让恢复图
   * 重建同一套 MCP 工具、系统提示词和审批策略。老任务无快照时保留既有 config/default 恢复逻辑。
   */
  private readExecutionStrategySnapshot(
    executionState: Prisma.JsonValue,
  ): PersistedAgentStrategySnapshot | undefined {
    if (!executionState || typeof executionState !== 'object') {
      return undefined;
    }
    const state = executionState as {
      strategy?: unknown;
      toolGroups?: unknown;
      skills?: unknown;
      maxSteps?: unknown;
      mcdonaldsCredentialId?: unknown;
    };
    const known = Object.values(AgentStrategyMode) as string[];
    if (
      typeof state.strategy !== 'string' ||
      !known.includes(state.strategy) ||
      !Array.isArray(state.toolGroups) ||
      !state.toolGroups.every((value) => typeof value === 'string') ||
      !Array.isArray(state.skills) ||
      !state.skills.every((value) => typeof value === 'string') ||
      typeof state.maxSteps !== 'number' ||
      !Number.isFinite(state.maxSteps)
    ) {
      return undefined;
    }
    return {
      strategy: state.strategy as AgentStrategyMode,
      toolGroups: state.toolGroups,
      skills: state.skills,
      maxSteps: state.maxSteps,
      ...(typeof state.mcdonaldsCredentialId === 'string'
        ? { mcdonaldsCredentialId: state.mcdonaldsCredentialId }
        : {}),
    };
  }

  /**
   * 读取首轮生效的执行策略
   * @param executionState 任务的执行状态列
   * @returns 返回策略；缺失或非法时回退 ReAct
   * @description 回退到 ReAct 而不是抛错：老任务（本字段上线前创建）没有这条记录，
   * 而它们只可能是 ReAct 挂起的——当时只有 ReAct 支持审批。
   */
  private readExecutionStrategy(
    executionState: Prisma.JsonValue,
  ): AgentStrategyMode {
    const strategy =
      executionState && typeof executionState === 'object'
        ? (executionState as { strategy?: unknown }).strategy
        : undefined;

    const known = Object.values(AgentStrategyMode) as string[];
    if (typeof strategy === 'string' && known.includes(strategy)) {
      return strategy as AgentStrategyMode;
    }
    return AgentStrategyMode.ReAct;
  }

  private async handleAgentLoopStatusEvent(
    task: {
      id: string;
      userId: string;
      streamId: string;
      conversationId: string;
      messageId: string;
    },
    event: Exclude<
      AgentLoopStreamEvent,
      | { type: StreamTaskEventType.MessageDelta }
      | { type: StreamTaskEventType.ToolCallDelta }
    >,
  ) {
    const statusEvent = await this.persistEvent(
      task.id,
      task.streamId,
      event.type,
      this.serializeTaskEventData({
        type: event.type,
        taskId: task.id,
        streamId: task.streamId,
        conversationId: task.conversationId,
        messageId: task.messageId,
        status: StreamTaskStatus.STREAMING.toLowerCase(),
        payload: event.payload,
      }),
      {
        status: StreamTaskStatus.STREAMING,
      },
    );
    await this.recordConversationTraceEvent({
      taskId: task.id,
      userId: task.userId,
      streamId: task.streamId,
      conversationId: task.conversationId,
      messageId: task.messageId,
      eventName: event.type,
      payload: event.payload,
    });
    this.registry.publish(task.id, statusEvent.sseEvent);

    const toolName =
      event.type === StreamTaskEventType.ToolCallDone
        ? (event.payload.toolName ?? event.payload.name)
        : undefined;
    if (toolName && this.isMcDonaldsCreateOrderTool(toolName)) {
      await this.publishCreatedMcDonaldsOrders(task);
    }
  }

  /**
   * 在下单工具成功后发布本任务新建的订单卡片
   * @param task 当前流式聊天任务上下文
   * @returns 无返回值
   * @description 订单ID来自任务级 AsyncLocalStorage，避免从工具文字或 trace 摘要反解析业务事实；事件不写 conversation trace，因为工具调用审计已存在。
   */
  private async publishCreatedMcDonaldsOrders(task: {
    id: string;
    userId: string;
    streamId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const orderIds = consumeCreatedMcDonaldsOrderIds();
    const orders = await this.mcdonaldsOrderService.getCardsByIds(
      orderIds,
      task.userId,
    );
    for (const order of orders) {
      const orderEvent = await this.persistEvent(
        task.id,
        task.streamId,
        StreamTaskEventType.OrderCreated,
        this.serializeTaskEventData({
          type: StreamTaskEventType.OrderCreated,
          taskId: task.id,
          streamId: task.streamId,
          conversationId: task.conversationId,
          messageId: task.messageId,
          status: StreamTaskStatus.STREAMING.toLowerCase(),
          payload: { order },
        }),
        { status: StreamTaskStatus.STREAMING },
      );
      this.registry.publish(task.id, orderEvent.sseEvent);
    }
  }

  /**
   * 判断运行时工具是否为麦当劳下单工具
   * @param toolName Agent 内运行时工具名
   * @returns 麦当劳 create-order 返回 true
   * @description 使用稳定的 MCP 前缀后缀组合识别；实际来源审计仍由 CapabilityRegistry 元数据完成。
   */
  private isMcDonaldsCreateOrderTool(toolName: string): boolean {
    const metadata = this.capabilityRegistry.getToolMetadata(toolName);
    return (
      metadata?.mcpServer === MCDONALDS_MCP_SERVER_NAME &&
      metadata.mcpTool === 'create-order'
    );
  }

  /**
   * 刷新会话摘要
   * @param conversationId 会话ID
   * @returns 无返回值
   * @description 在回复完成后异步更新会话摘要，避免摘要生成阻塞当前 流式任务的完成事件返回。
   */
  private async refreshConversationSummary(conversationId: string) {
    try {
      await this.conversationSummaryService.refreshConversationSummary(
        conversationId,
      );
    } catch (error) {
      this.logger.warn(
        `Refresh conversation summary failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 构建单轮聊天运行指标
   * @param messages 模型输入消息
   * @param finalContent 最终回复内容
   * @param context 会话上下文包
   * @param durationMs 本轮生成耗时
   * @param modelTokenUsage 本任务内逐次模型调用汇总的 token 用量
   * @returns 返回 token 和缓存命中指标
   * @description 优先使用供应商逐调用返回的 usage；未采集到任何调用时才回退会话级估算。
   * 会话摘要只代表上下文压缩，不能被标记为供应商 Prompt Cache 命中。
   */
  private buildChatRunMetrics(
    messages: LlmMessage[],
    finalContent: string,
    context: ChatContextBundle,
    durationMs: number,
    modelTokenUsage?: LlmTokenUsageMetrics,
  ): LlmRunMetrics {
    const memorySummaryHit = Boolean(context.summary);
    const tokenUsage =
      modelTokenUsage ??
      this.llmService.buildEstimatedTokenUsage(messages, finalContent);
    const cachedInputTokens = tokenUsage.cachedInputTokens ?? 0;
    const providerPromptCacheHit = cachedInputTokens > 0;

    return {
      tokenUsage,
      cache: {
        memorySummaryHit,
        providerPromptCacheHit,
        contextCacheHit: providerPromptCacheHit,
        cachedInputTokens,
      },
      durationMs,
      messageCount: messages.length,
      summaryMessageCount: context.summary?.messageCount,
      recentMessageCount: context.recentWindow.messageCount,
    };
  }

  /**
   * 统计单轮任务的工具调用次数
   * @param taskId 任务ID
   * @returns 返回已结束（非 RUNNING）的工具调用 trace 数量
   * @description 从 conversation-trace 聚合，准确覆盖每次 tool.call.done/error；供观测面板展示。
   */
  private countTaskToolCalls(taskId: string): Promise<number> {
    return this.prisma.conversationTurnTraceItem.count({
      where: {
        taskId,
        type: ConversationTraceItemType.TOOL_CALL,
        status: { not: ConversationTraceItemStatus.RUNNING },
      },
    });
  }

  /**
   * 标记任务失败
   * @param taskId 任务ID
   * @param message 错误信息
   * @returns 无返回值
   * @description 将任务和对应消息更新为失败状态，同时写入并发布 task.error 事件。
   */
  private async failTask(
    taskId: string,
    message: string,
    errorInfo?: TaskErrorPayload,
  ) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      return;
    }

    const conversationId = this.requireConversationId(task);
    const messageId = this.requireMessageId(task);
    const errorEvent = await this.persistEvent(
      taskId,
      task.currentRunId,
      StreamTaskEventType.TaskError,
      this.serializeTaskEventData<TaskErrorPayload>({
        type: StreamTaskEventType.TaskError,
        taskId,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: StreamTaskStatus.ERROR.toLowerCase(),
        errorMessage: message,
        payload: errorInfo,
      }),
      {
        status: StreamTaskStatus.ERROR,
        errorMessage: message,
        fullContent: task.fullContent,
      },
    );
    await this.recordConversationTraceEvent({
      userId: task.userId,
      taskId,
      streamId: task.currentRunId,
      conversationId,
      messageId,
      eventName: StreamTaskEventType.TaskError,
      errorMessage: message,
    });

    await this.prisma.$transaction([
      this.prisma.streamTask.update({
        where: { id: taskId },
        data: {
          status: StreamTaskStatus.ERROR,
          errorMessage: message,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
          currentStep: 'error',
        },
      }),
      ...(task.currentRunId
        ? [
            this.prisma.streamTaskRun.update({
              where: { id: task.currentRunId },
              data: {
                status: StreamTaskRunStatus.ERROR,
                endedAt: new Date(),
                closeReason: 'task_error',
                endEventId: errorEvent.eventId,
              },
            }),
          ]
        : []),
      this.prisma.message.update({
        where: { id: messageId },
        data: {
          content: task.fullContent || '生成失败',
          status: MessageStatus.ERROR,
        },
      }),
    ]);

    await this.snapshotService.markCompleted(taskId);
    this.registry.publish(taskId, errorEvent.sseEvent);
  }

  /**
   * 持久化任务事件
   * @param taskId 任务ID
   * @param event 事件名
   * @param data 事件数据
   * @param taskUpdate 任务字段更新内容
   * @returns 返回数据库语义事件 ID 和 Redis Stream 帧
   * @description 仅用于低频语义事件：为任务分配递增事件 ID、写入事件表，并同步写入 Redis Stream 供 SSE 恢复重放。高频 message.delta 不应调用此方法。
   */
  private async persistEvent(
    taskId: string,
    streamId: string | null | undefined,
    event: StreamTaskEventType,
    data: string,
    taskUpdate?: Partial<{
      status: StreamTaskStatus;
      errorMessage: string | null;
      fullContent: string;
    }>,
  ): Promise<PersistedSemanticEvent> {
    const task = await this.prisma.streamTask.update({
      where: { id: taskId },
      data: {
        lastEventId: { increment: 1 },
        lastHeartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
        ...taskUpdate,
      },
      select: {
        lastEventId: true,
      },
    });

    const eventPayload = this.parseEventPayload(data);
    await this.prisma.streamTaskEvent.create({
      data: {
        taskId,
        streamId,
        eventId: task.lastEventId,
        eventName: event,
        payload: eventPayload,
      },
    });

    const sseEvent = await this.publishFrame(taskId, event, data);

    return {
      eventId: task.lastEventId,
      sseEvent,
    };
  }

  /**
   * 发布一帧可恢复 SSE 事件。
   * 高频内容帧只写入 Redis Stream，避免把 token 级快照写入数据库。
   */
  private async publishFrame(
    taskId: string,
    event: StreamTaskEventType,
    data: string,
  ): Promise<SseEvent> {
    return this.snapshotService.appendFrame(taskId, event, data);
  }

  /**
   * 按时间或内容长度阈值刷新任务累计文本。
   * 运行时仍在内存中拼接 fullContent，但数据库不再每个 token 都更新。
   */
  private async maybeFlushFullContent(input: {
    taskId: string;
    fullContent: string;
    lastFlushAt: number;
    lastFlushedLength: number;
  }) {
    const now = Date.now();
    const contentGrowth = input.fullContent.length - input.lastFlushedLength;
    const shouldFlush =
      contentGrowth >= FULL_CONTENT_FLUSH_CHARS ||
      now - input.lastFlushAt >= FULL_CONTENT_FLUSH_INTERVAL_MS;

    if (!shouldFlush) {
      return {
        lastFlushAt: input.lastFlushAt,
        lastFlushedLength: input.lastFlushedLength,
      };
    }

    await this.prisma.streamTask.update({
      where: { id: input.taskId },
      data: {
        fullContent: input.fullContent,
        status: StreamTaskStatus.STREAMING,
        lastHeartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + this.bufferTtl * 1000),
      },
    });

    return {
      lastFlushAt: now,
      lastFlushedLength: input.fullContent.length,
    };
  }

  /**
   * 写入单轮对话轨迹
   * @param input 任务事件和上下文
   * @returns 无返回值
   * @description 将关键 StreamTask 事件交给 ConversationTraceService 归约为历史可回显的执行轨迹；失败不影响主流式链路。
   *
   * 泛型把 `payload` 绑定到 `eventName` 对应的载荷契约：写错字段名、漏必填字段
   * 或用错事件的载荷都会在编译期报错，不再依赖下游 `readString` 猜字段。
   */
  private async recordConversationTraceEvent<
    K extends StreamTaskEventType,
  >(input: {
    userId?: string;
    taskId: string;
    streamId?: string | null;
    conversationId: string;
    messageId: string;
    eventName: K;
    payload?: StreamTaskPayloadMap[K];
    errorMessage?: string;
  }) {
    const userId = input.userId ?? (await this.resolveTaskUserId(input.taskId));
    await this.conversationTraceService.recordStreamEvent({
      userId,
      taskId: input.taskId,
      runId: input.streamId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      eventName: input.eventName,
      payload: input.payload,
      errorMessage: input.errorMessage,
    });
  }

  /**
   * 查询任务所属用户
   * @param taskId 任务ID
   * @returns 返回用户ID；任务不存在时返回 undefined
   * @description trace 写入需要 userId 作为归属字段，部分内部调用只有 taskId，因此在写入前懒查询一次。
   */
  private async resolveTaskUserId(taskId: string) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: { userId: true },
    });
    return task?.userId;
  }

  /**
   * 终态任务恢复兜底流。
   * Redis 帧缓存过期后，不再尝试还原完整增量帧，只返回最终正文和终态，避免客户端恢复请求长期挂起。
   */
  private *buildTerminalFallbackStream(
    task: {
      id: string;
      status: StreamTaskStatus;
      currentRunId: string | null;
      conversationId: string | null;
      messageId: string | null;
      fullContent: string;
      errorMessage: string | null;
      resultPayload: Prisma.JsonValue | null;
    },
    frameId: string,
  ): Generator<SseEvent> {
    const conversationId = this.requireConversationId(task);
    const messageId = this.requireMessageId(task);
    const eventId = this.normalizeFrameId(frameId);

    if (task.status === StreamTaskStatus.COMPLETED) {
      const resultPayload = this.toRecord(task.resultPayload);
      const content =
        typeof resultPayload.content === 'string'
          ? resultPayload.content
          : task.fullContent;

      yield this.buildTaskSseEvent(eventId, StreamTaskEventType.MessageDone, {
        taskId: task.id,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: task.status.toLowerCase(),
        payload: {
          content,
          warning:
            typeof resultPayload.warning === 'string'
              ? resultPayload.warning
              : undefined,
          metrics: this.toRecord(resultPayload.metrics),
        },
      });

      yield this.buildTaskSseEvent(eventId, StreamTaskEventType.TaskCompleted, {
        taskId: task.id,
        streamId: task.currentRunId ?? undefined,
        conversationId,
        messageId,
        status: task.status.toLowerCase(),
      });
      return;
    }

    const terminalEvent =
      task.status === StreamTaskStatus.CANCELED
        ? StreamTaskEventType.TaskCanceled
        : task.status === StreamTaskStatus.EXPIRED
          ? StreamTaskEventType.TaskExpired
          : StreamTaskEventType.TaskError;

    yield this.buildTaskSseEvent(eventId, terminalEvent, {
      taskId: task.id,
      streamId: task.currentRunId ?? undefined,
      conversationId,
      messageId,
      status: task.status.toLowerCase(),
      errorMessage: task.errorMessage ?? undefined,
    });
  }

  /**
   * 标记任务过期
   * @param taskId 任务ID
   * @returns 无返回值
   * @description 将指定任务更新为 EXPIRED 状态，表示其恢复窗口已失效。
   */
  private async expireTask(taskId: string) {
    await this.prisma.streamTask.update({
      where: { id: taskId },
      data: { status: StreamTaskStatus.EXPIRED },
    });
  }

  /**
   * 加载并校验任务
   * @param taskId 任务ID
   * @param userId 用户ID
   * @returns 返回已加载且权限校验通过的任务记录
   * @description 查询指定任务并校验其归属；若任务不存在或不属于当前用户，则抛出异常。
   */
  private async loadTask(taskId: string, userId: string) {
    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new NotFoundException('流式任务不存在');
    }

    if (task.userId !== userId) {
      throw new ForbiddenException('无权访问该 流式任务');
    }

    return task;
  }

  /**
   * 判断任务是否为终态
   * @param status 任务状态
   * @returns 返回布尔值，true 表示任务已结束
   * @description 用于统一判断任务是否已经进入 completed、error、expired 或 canceled 等终止状态。
   */
  private isTerminalStatus(status: StreamTaskStatus) {
    return (
      status === StreamTaskStatus.COMPLETED ||
      status === StreamTaskStatus.ERROR ||
      status === StreamTaskStatus.EXPIRED ||
      status === StreamTaskStatus.CANCELED
    );
  }

  /**
   * 判断事件是否为任务终态事件
   * @param event 事件名称
   * @returns 返回布尔值，true 表示该事件会结束当前 SSE 流
   * @description 仅 StreamTask 协议枚举中的终态事件会结束恢复流；未知字符串事件不会被当成终态处理。
   */
  private isTerminalEvent(event: string) {
    return STREAM_TASK_TERMINAL_EVENT_TYPES.has(event as StreamTaskEventType);
  }

  /**
   * 判断是否应忽略中断错误
   * @param taskId 任务ID
   * @param error 执行异常
   * @param executionSignal 执行中断信号
   * @returns 返回布尔值，true 表示该异常属于已处理的中断场景
   * @description 在任务被主动取消后，上游 provider 可能抛出中断异常；此时不应再将任务写入失败状态。
   */
  private async shouldIgnoreAbort(
    taskId: string,
    error: unknown,
    executionSignal: AbortSignal,
  ) {
    if (
      !executionSignal.aborted &&
      !this.isAbortError(error) &&
      error !== TASK_CANCELED_REASON
    ) {
      return false;
    }

    const task = await this.prisma.streamTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    });

    return task?.status === StreamTaskStatus.CANCELED;
  }

  /**
   * 判断异常是否为中断错误
   * @param error 执行异常
   * @returns 返回布尔值，true 表示该异常属于 AbortError
   * @description 用于识别 provider 在接收到 AbortSignal 后抛出的标准中断异常。
   */
  private isAbortError(error: unknown) {
    return (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.toLowerCase().includes('aborted'))
    );
  }

  /**
   * 释放任务执行锁
   * @param lockKey Redis 锁 Key
   * @param lockValue Redis 锁值
   * @returns 无返回值
   * @description 仅当当前实例仍持有该锁时才删除 Redis 锁，避免误删其他执行者的锁。
   */
  private async releaseLock(lockKey: string, lockValue: string) {
    const currentValue = await this.redis.get(lockKey);
    if (currentValue === lockValue) {
      await this.redis.del(lockKey);
    }
  }

  /**
   * 序列化任务事件数据
   * @param eventData 任务事件业务数据
   * @returns 返回可直接写入 SSE data 字段的 JSON 字符串
   * @description 为任务相关事件统一输出固定数据结构，避免不同事件的 payload 形状漂移。
   */
  private serializeTaskEventData<TPayload>(
    eventData: StreamTaskEventData<TPayload>,
  ) {
    return JSON.stringify(eventData);
  }

  private parseEventPayload(data: string): Prisma.InputJsonValue {
    try {
      return JSON.parse(data) as Prisma.InputJsonValue;
    } catch {
      return { raw: data };
    }
  }

  /**
   * 将审批决定转换为 Prisma Json 输入值
   * @param value 已由 HTTP DTO 验证的审批决定
   * @returns 返回可安全写入审批事实的普通 JSON 值
   * @description JSON 往返移除 undefined 和类实例，确保决定比较、审计与 outbox 链路使用同一份稳定结构。
   */
  private toInputJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private normalizeFrameId(frameId: string | undefined) {
    const trimmed = frameId?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : '0';
  }

  private nextSyntheticFrameId(frameId: string | undefined) {
    return this.normalizeFrameId(frameId);
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private formatTaskLog(event: string, payload: Record<string, unknown>) {
    return JSON.stringify({ event, ...payload });
  }

  private debugTaskLog(event: string, payload: Record<string, unknown>) {
    if (!this.isDebugEnabled()) {
      return;
    }

    this.logger.log(this.formatTaskLog(event, payload));
  }

  private isDebugEnabled() {
    const value = this.configService.get<string>('LLM_DEBUG');
    return value === 'true' || value === '1';
  }

  /**
   * 构建任务流式事件对象
   * @param eventId 事件ID
   * @param eventName 流式事件名称
   * @param eventData 任务事件业务数据
   * @returns 返回包含标准 data JSON 的流式事件对象
   * @description 用于生成首包事件或单次事件流中的任务事件，确保 event 名和业务 type 字段保持一致。
   */
  private buildTaskSseEvent<TPayload>(
    eventId: string,
    eventName: StreamTaskEventType,
    eventData: Omit<StreamTaskEventData<TPayload>, 'type'>,
  ): SseEvent {
    return {
      id: eventId,
      event: eventName,
      data: this.serializeTaskEventData({
        type: eventName,
        ...eventData,
      }),
    };
  }

  private requireConversationId(task: { conversationId: string | null }) {
    if (!task.conversationId) {
      throw new Error('Agent task is not bound to a conversation');
    }

    return task.conversationId;
  }

  private requireMessageId(task: { messageId: string | null }) {
    if (!task.messageId) {
      throw new Error('Agent task is not bound to a message');
    }

    return task.messageId;
  }

  /**
   * 包装单事件异步流
   * @param event 流式事件对象
   * @returns 返回只会产出单个事件的异步流
   * @description 用于过期等场景，将单个事件包装成符合流式输出约定的异步迭代器。
   */
  private singleEventStream(event: SseEvent): AsyncGenerator<SseEvent> {
    return (async function* () {
      await Promise.resolve();
      yield event;
    })();
  }

  /**
   * 在事件流前插入单个事件
   * @param initialEvent 首个需要插入的流式事件
   * @param stream 原始事件流
   * @returns 返回新的流式事件流
   * @description 用于在首轮聊天建链时先向客户端发送 task.created 事件，再继续产出任务自身的流式事件。
   */
  private async *prependEvent(
    initialEvent: SseEvent,
    stream: AsyncGenerator<SseEvent>,
  ): AsyncGenerator<SseEvent> {
    yield initialEvent;

    for await (const event of stream) {
      yield event;
    }
  }
}

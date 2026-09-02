import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { McDonaldsOrderService } from '../mcdonalds-order/mcdonalds-order.service';
import {
  AgentAccessDenialReason,
  AgentAccessService,
} from '../agent-access/agent-access.service';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mcdonaldsOrderService: McDonaldsOrderService,
    private readonly agentAccessService: AgentAccessService,
  ) {}

  /**
   * 查询指定用户的全部会话列表
   * @param userId 用户ID
   * @returns 返回会话列表，包含会话基础信息及已按时间正序排列的消息列表
   * @description 根据用户ID查询其全部会话，并按会话更新时间倒序返回，便于前端直接渲染历史聊天记录。
   */
  async findAllByUser(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      // 过滤掉 admin 测试会话：测试记录只在 admin 测试工作台可见，不进端侧列表。
      where: { userId, isTest: false },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            turnTraceItems: {
              orderBy: { sequence: 'asc' },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 批量映射发言者名字（群聊消息归属展示；agent 被删后回退 id 兜底）
    const agentIds = [
      ...new Set(
        conversations
          .flatMap((c) => c.messages.map((m) => m.agentId))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const agentNameById = new Map(
      agentIds.length > 0
        ? (
            await this.prisma.agent.findMany({
              where: { id: { in: agentIds } },
              select: { id: true, name: true },
            })
          ).map((a) => [a.id, a.name])
        : [],
    );

    const orders = await this.prisma.mcDonaldsOrder.findMany({
      where: { userId, messageId: { not: null } },
      select: {
        id: true,
        messageId: true,
        externalOrderId: true,
        status: true,
        statusLabel: true,
        storeName: true,
        fulfillmentType: true,
        totalAmount: true,
        discountAmount: true,
        currency: true,
        items: true,
        estimatedFulfillmentAt: true,
        lastRefreshedAt: true,
        createdAt: true,
      },
    });
    const ordersByMessageId = new Map<
      string,
      ReturnType<McDonaldsOrderService['toOrderCard']>[]
    >();
    for (const order of orders) {
      if (!order.messageId) {
        continue;
      }
      const messageOrders = ordersByMessageId.get(order.messageId) ?? [];
      messageOrders.push(this.mcdonaldsOrderService.toOrderCard(order));
      ordersByMessageId.set(order.messageId, messageOrders);
    }

    return conversations.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      agentIds: c.agentIds,
      defaultAgentId: c.defaultAgentId,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role.toLowerCase(),
        content: m.content,
        agentId: m.agentId,
        agentName: m.agentId ? (agentNameById.get(m.agentId) ?? null) : null,
        status: m.status.toLowerCase(),
        createdAt: m.createdAt.getTime(),
        trace: m.turnTraceItems.map((item) => ({
          id: item.id,
          type: item.type,
          status: item.status,
          title: item.title,
          summary: item.summary,
          durationMs: item.durationMs,
          depth: item.depth,
          sequence: item.sequence,
          metrics: item.metrics,
          toolName: item.toolName,
          parentId: item.parentId,
          inputSummary: item.inputSummary,
          outputSummary: item.outputSummary,
        })),
        orders: ordersByMessageId.get(m.id) ?? [],
      })),
      createdAt: c.createdAt.getTime(),
      updatedAt: c.updatedAt.getTime(),
    }));
  }

  /**
   * 创建会话（单聊/群聊）
   * @param userId 用户ID
   * @param input 标题、形态与初始智能体
   * @returns 返回会话基础信息；单聊重复创建时幂等返回既有会话
   * @description SINGLE：绑定单个智能体（agentIds 取第一个；同绑定的既有单聊直接复用，
   * 通讯录「单聊」按钮天然幂等）。GROUP：初始成员 ≥2，defaultAgentId 留空 = 自动路由。
   * 智能体 id 会校验存在且启用。
   */
  async create(
    userId: string,
    input: {
      title?: string;
      type?: ConversationType;
      agentIds?: string[];
    } = {},
  ) {
    const type = input.type ?? ConversationType.SINGLE;
    const agentIds = [...new Set(input.agentIds ?? [])];

    if (type === ConversationType.GROUP && agentIds.length < 2) {
      throw new BadRequestException('群聊至少需要 2 个智能体成员');
    }
    if (type === ConversationType.SINGLE && agentIds.length > 1) {
      throw new BadRequestException('单聊只能绑定 1 个智能体');
    }
    if (agentIds.length > 0) {
      await this.ensureAgentsUsable(userId, agentIds);
    }

    // 单聊幂等：同绑定（含默认助手单聊）的既有会话直接复用
    if (type === ConversationType.SINGLE) {
      const existing = await this.prisma.conversation.findFirst({
        where: {
          userId,
          isTest: false,
          type: ConversationType.SINGLE,
          agentIds: { equals: agentIds },
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (existing) {
        return this.toBrief(existing);
      }
    }

    const memberNames =
      agentIds.length > 0
        ? (
            await this.prisma.agent.findMany({
              where: { id: { in: agentIds } },
              select: { name: true },
            })
          ).map((a) => a.name)
        : [];

    const conversation = await this.prisma.conversation.create({
      data: {
        userId,
        type,
        agentIds,
        // 单聊绑定即默认回答者；群聊留空走自动路由
        defaultAgentId:
          type === ConversationType.SINGLE ? (agentIds[0] ?? null) : null,
        title:
          input.title ||
          (type === ConversationType.GROUP
            ? memberNames.slice(0, 3).join('、') || '群聊'
            : memberNames[0] || '新对话'),
      },
    });

    return this.toBrief(conversation);
  }

  /**
   * 更新会话（群名/默认回答者）
   * @description defaultAgentId 传空串恢复自动路由；传具体 id 时必须是群成员。
   */
  async update(
    id: string,
    userId: string,
    input: { title?: string; defaultAgentId?: string },
  ) {
    const conversation = await this.ensureOwnership(id, userId);

    let defaultAgentId: string | null | undefined;
    if (input.defaultAgentId !== undefined) {
      defaultAgentId = input.defaultAgentId.trim() || null;
      if (defaultAgentId && !conversation.agentIds.includes(defaultAgentId)) {
        throw new BadRequestException('默认回答者必须是会话成员');
      }
    }

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        title: input.title?.trim() || undefined,
        defaultAgentId,
      },
    });
    return this.toBrief(updated);
  }

  /**
   * 群聊添加成员
   * @description 仅 GROUP 会话可用；幂等（已在成员表则原样返回）。
   */
  async addAgent(id: string, userId: string, agentId: string) {
    const conversation = await this.ensureOwnership(id, userId);
    if (conversation.type !== ConversationType.GROUP) {
      throw new BadRequestException('只有群聊可以管理成员');
    }
    if (conversation.agentIds.includes(agentId)) {
      return this.toBrief(conversation);
    }
    await this.ensureAgentsUsable(userId, [agentId]);

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: { agentIds: { push: agentId } },
    });
    return this.toBrief(updated);
  }

  /**
   * 群聊移除成员
   * @description 仅影响可 @ 列表与路由候选：历史消息及其归属完整保留。
   * 至少保留 1 个成员；被移除者若是默认回答者则恢复自动路由。
   */
  async removeAgent(id: string, userId: string, agentId: string) {
    const conversation = await this.ensureOwnership(id, userId);
    if (conversation.type !== ConversationType.GROUP) {
      throw new BadRequestException('只有群聊可以管理成员');
    }
    const nextAgentIds = conversation.agentIds.filter((x) => x !== agentId);
    if (nextAgentIds.length === conversation.agentIds.length) {
      throw new NotFoundException('该智能体不在群成员中');
    }
    if (nextAgentIds.length === 0) {
      throw new BadRequestException('群聊至少保留 1 个成员');
    }

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        agentIds: nextAgentIds,
        defaultAgentId:
          conversation.defaultAgentId === agentId
            ? null
            : conversation.defaultAgentId,
      },
    });
    return this.toBrief(updated);
  }

  /** 校验智能体存在、启用且满足当前用户会员资格 */
  private async ensureAgentsUsable(userId: string, agentIds: string[]) {
    const [subject, agents] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { membershipTier: true, membershipExpiresAt: true },
      }),
      this.prisma.agent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, enabled: true, minimumMembershipTier: true },
      }),
    ]);
    if (!subject) {
      throw new NotFoundException('用户不存在');
    }

    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    for (const agentId of agentIds) {
      const agent = agentById.get(agentId);
      if (!agent) {
        throw new NotFoundException('智能体不存在');
      }
      const decision = this.agentAccessService.evaluate(subject, agent);
      if (!decision.canUse) {
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
    }
  }

  /** 会话基础信息投影（创建/更新/成员操作的统一响应） */
  private toBrief(conversation: {
    id: string;
    title: string;
    type: ConversationType;
    agentIds: string[];
    defaultAgentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: conversation.id,
      title: conversation.title,
      type: conversation.type,
      agentIds: conversation.agentIds,
      defaultAgentId: conversation.defaultAgentId,
      messages: [],
      createdAt: conversation.createdAt.getTime(),
      updatedAt: conversation.updatedAt.getTime(),
    };
  }

  /**
   * 删除指定会话
   * @param id 会话ID
   * @param userId 用户ID
   * @returns 无返回值
   * @description 仅允许删除属于当前用户的会话；若会话不存在或不属于当前用户，则抛出异常。
   */
  async delete(id: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    await this.prisma.conversation.delete({ where: { id } });
  }

  /**
   * 校验会话归属关系
   * @param conversationId 会话ID
   * @param userId 用户ID
   * @returns 返回已确认归属的会话记录
   * @description 查询指定会话并确认其属于当前用户；若不存在或无权限访问，则抛出异常。
   */
  async ensureOwnership(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    });

    if (!conversation) {
      throw new NotFoundException('会话不存在');
    }

    return conversation;
  }
}

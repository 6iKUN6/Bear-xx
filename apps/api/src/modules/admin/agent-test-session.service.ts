import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  TestSessionDetailDto,
  TestSessionDto,
} from './dto/agent-test.dto';

/**
 * admin 测试会话管理（只操作 isTest=true 的会话）
 * @description 按 userId + isTest 双重隔离：每个 admin 只见自己的测试会话，
 * 端侧列表已过滤 isTest，测试记录不污染任何用户的正常聊天。
 */
@Injectable()
export class AgentTestSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 测试会话列表（按更新时间倒序，带最后消息预览与消息数） */
  async list(userId: string): Promise<TestSessionDto[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { userId, isTest: true },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true },
        },
        _count: { select: { messages: true } },
      },
    });

    return conversations.map((c) => ({
      id: c.id,
      title: c.title,
      lastMessage:
        c.messages[0]?.content.replace(/\s+/g, ' ').slice(0, 50) ?? '',
      messageCount: c._count.messages,
      updatedAt: c.updatedAt.getTime(),
    }));
  }

  /** 测试会话详情：消息 + 每条消息的执行轨迹（复用 conversation-trace 已落库数据） */
  async detail(userId: string, id: string): Promise<TestSessionDetailDto> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId, isTest: true },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            turnTraceItems: { orderBy: { sequence: 'asc' } },
          },
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('测试会话不存在');
    }

    return {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt.getTime(),
      messages: conversation.messages.map((m) => ({
        id: m.id,
        role: m.role.toLowerCase(),
        content: m.content,
        agentId: m.agentId,
        status: m.status.toLowerCase(),
        createdAt: m.createdAt.getTime(),
        trace: m.turnTraceItems.map((item) => ({
          id: item.id,
          type: item.type,
          status: item.status,
          title: item.title,
          summary: item.summary,
          detail: item.detail,
          toolName: item.toolName,
          parentId: item.parentId,
          depth: item.depth,
          nodeKey: item.nodeKey,
          mcpServer: item.mcpServer,
          mcpTool: item.mcpTool,
          inputSummary: this.readJsonObject(item.inputSummary),
          outputSummary: this.readJsonObject(item.outputSummary),
          error: this.readJsonObject(item.error),
          metrics: this.readJsonObject(item.metrics),
          startedAt: item.startedAt?.getTime() ?? null,
          endedAt: item.endedAt?.getTime() ?? null,
          createdAt: item.createdAt.getTime(),
          durationMs: item.durationMs,
          sequence: item.sequence,
        })),
      })),
    };
  }

  /** 删除测试会话（消息/任务/trace 由 schema 级联清理） */
  async remove(userId: string, id: string): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId, isTest: true },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundException('测试会话不存在');
    }
    await this.prisma.conversation.delete({ where: { id } });
  }

  /**
   * 将 Prisma JSON 值收敛为可安全透出的对象
   * @param value trace 字段中持久化的 Prisma JSON 值
   * @returns 返回浅拷贝后的对象；标量、数组和空值返回 null
   * @description 测试台与任务详情共享 trace 语义，只允许对象结构进入详情面板。
   */
  private readJsonObject(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return Object.fromEntries(Object.entries(value));
  }
}

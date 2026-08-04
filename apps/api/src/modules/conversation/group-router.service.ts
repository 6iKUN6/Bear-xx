import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { groupRouterPrompt } from '../../prompts';

const ROUTER_TEMPERATURE = 0;
const ROUTER_MAX_OUTPUT_TOKENS = 100;

export interface GroupRouteResult {
  agentId: string;
  /** 路由理由（透出到 task.created payload 供前端/trace 展示） */
  reason?: string;
}

/**
 * 群聊回答者路由器
 * @description 群聊消息未显式指定回答者（无 @、无固定默认回答者）时，
 * 用一次低成本结构化分类调用从成员中选人——不是「主持人 agent」：
 * 选中者以自己的身份走完整回答管道，路由只占几百毫秒。
 * 任何失败（模型不可用/输出不合法）回退第一个成员，绝不阻塞发送链路。
 */
@Injectable()
export class GroupRouterService {
  private readonly logger = new Logger(GroupRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  /**
   * 为群聊消息选择回答者
   * @param content 用户消息
   * @param memberIds 群成员 agent id 列表（非空）
   * @returns 返回选中的成员与理由；成员唯一时直接短路
   */
  async route(content: string, memberIds: string[]): Promise<GroupRouteResult> {
    const fallback: GroupRouteResult = { agentId: memberIds[0] };
    if (memberIds.length === 1) {
      return fallback;
    }

    try {
      const members = await this.prisma.agent.findMany({
        where: { id: { in: memberIds }, enabled: true },
        select: {
          id: true,
          name: true,
          description: true,
          toolGroups: true,
          isDefault: true,
        },
      });
      if (members.length === 0) {
        return fallback;
      }
      if (members.length === 1) {
        return { agentId: members[0].id };
      }

      const memberLines = members
        .map(
          (m) =>
            `- id: ${m.id} | 名称: ${m.name}${m.isDefault ? '（默认）' : ''} | 简介: ${m.description || '无'} | 能力: ${m.toolGroups.join(',') || '通用对话'}`,
        )
        .join('\n');

      const raw = await this.llmService.generateChatText(
        [
          { role: 'system', content: groupRouterPrompt },
          {
            role: 'user',
            content: `群成员：\n${memberLines}\n\n用户消息：${content.slice(0, 500)}`,
          },
        ],
        {
          generation: {
            temperature: ROUTER_TEMPERATURE,
            maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
          },
        },
      );

      const parsed = this.parseRoute(raw);
      if (parsed && members.some((m) => m.id === parsed.agentId)) {
        return parsed;
      }
      this.logger.warn(
        `Group route output invalid, fallback: ${raw.slice(0, 100)}`,
      );
      return fallback;
    } catch (error) {
      this.logger.warn(
        `Group route failed, fallback to first member: ${(error as Error).message}`,
      );
      return fallback;
    }
  }

  /** 解析模型输出：容忍代码块包裹/前后杂文，提取首个 JSON 对象 */
  private parseRoute(raw: string): GroupRouteResult | null {
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]) as {
        agentId?: unknown;
        reason?: unknown;
      };
      if (typeof parsed.agentId !== 'string' || !parsed.agentId) {
        return null;
      }
      return {
        agentId: parsed.agentId,
        reason:
          typeof parsed.reason === 'string'
            ? parsed.reason.slice(0, 50)
            : undefined,
      };
    } catch {
      return null;
    }
  }
}

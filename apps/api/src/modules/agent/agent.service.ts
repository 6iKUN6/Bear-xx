import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Agent, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentDefinitionService } from './agent-definition.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentResponseDto } from './dto/agent-response.dto';

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

/**
 * 智能体 CRUD
 * @description 管理数据化的智能体定义。写操作后失效 AgentDefinitionService 缓存。
 * 策略枚举合法性由 DTO @IsEnum 保证；工具组/技能的闭集成员性由运行时装配阶段优雅过滤，此处不硬失败。
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentDefinitionService: AgentDefinitionService,
  ) {}

  async list(): Promise<AgentResponseDto[]> {
    const agents = await this.prisma.agent.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return agents.map((agent) => this.toResponse(agent));
  }

  async get(id: string): Promise<AgentResponseDto> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return this.toResponse(agent);
  }

  async create(dto: CreateAgentDto, userId: string): Promise<AgentResponseDto> {
    const agent = await this.prisma.agent.create({
      data: {
        name: dto.name,
        description: dto.description ?? '',
        avatar: dto.avatar?.trim() || null,
        systemPrompt: dto.systemPrompt ?? null,
        modelPreset: dto.modelPreset ?? null,
        defaultStrategy: dto.defaultStrategy ?? undefined,
        allowedStrategies: dto.allowedStrategies ?? [],
        toolGroups: dto.toolGroups ?? [],
        skills: dto.skills ?? [],
        maxSteps: dto.maxSteps ?? null,
        enabled: dto.enabled ?? true,
        createdById: userId,
      },
    });
    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  async update(id: string, dto: UpdateAgentDto): Promise<AgentResponseDto> {
    const data = {
      name: dto.name,
      description: dto.description,
      // undefined=不改；null/空串=清空，客户端显示名称首字
      avatar: dto.avatar === undefined ? undefined : dto.avatar?.trim() || null,
      systemPrompt: dto.systemPrompt,
      modelPreset: dto.modelPreset,
      defaultStrategy: dto.defaultStrategy,
      allowedStrategies: dto.allowedStrategies,
      toolGroups: dto.toolGroups,
      skills: dto.skills,
      maxSteps: dto.maxSteps,
      enabled: dto.enabled,
    };

    if (dto.enabled === false) {
      const agent = await this.runSerializableTransaction(async (tx) => {
        const currentAgent = await tx.agent.findUnique({ where: { id } });
        if (!currentAgent) {
          throw new NotFoundException('智能体不存在');
        }
        if (currentAgent.isDefault) {
          throw new BadRequestException('默认智能体不可停用');
        }
        return tx.agent.update({ where: { id }, data });
      });

      this.agentDefinitionService.invalidate();
      return this.toResponse(agent);
    }

    await this.ensureExists(id);
    const agent = await this.prisma.agent.update({ where: { id }, data });
    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  /**
   * 将指定的已启用智能体设为全局默认智能体
   * @param id 要设为默认智能体的智能体 ID
   * @returns 返回更新后的默认智能体响应数据
   * @description 先确认目标存在且已启用，再在同一事务内清除其他默认标记并设置目标标记；
   * 事务成功后失效智能体定义缓存，使未指定 agentId 的普通聊天使用新的默认智能体。
   */
  async setDefault(id: string): Promise<AgentResponseDto> {
    const agent = await this.runSerializableTransaction(async (tx) => {
      const targetAgent = await tx.agent.findUnique({ where: { id } });
      if (!targetAgent) {
        throw new NotFoundException('智能体不存在');
      }
      if (!targetAgent.enabled) {
        throw new BadRequestException('停用的智能体不可设为默认');
      }
      await tx.agent.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      return tx.agent.update({
        where: { id },
        data: { isDefault: true },
      });
    });

    this.agentDefinitionService.invalidate();
    return this.toResponse(agent);
  }

  async remove(id: string): Promise<void> {
    await this.runSerializableTransaction(async (tx) => {
      const agent = await tx.agent.findUnique({ where: { id } });
      if (!agent) {
        throw new NotFoundException('智能体不存在');
      }
      if (agent.isDefault) {
        throw new BadRequestException('默认智能体不可删除');
      }
      return tx.agent.delete({ where: { id } });
    });
    this.agentDefinitionService.invalidate();
  }

  /**
   * 在可串行化事务中执行操作，并有限重试序列化冲突
   * @param operation 接收事务客户端并执行数据库读写的异步操作
   * @returns 返回操作在成功提交后产生的结果
   * @description 使用 Serializable 隔离级别将读取决策与写入合并为原子操作；仅对可重试的
   * Prisma P2034 序列化冲突重试，达到最大次数后继续抛出原始异常。
   */
  private async runSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const canRetry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS - 1;
        if (!canRetry) {
          throw error;
        }
      }
    }

    throw new Error('可串行化事务重试状态异常');
  }

  private async ensureExists(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('智能体不存在');
    }
    return agent;
  }

  private toResponse(agent: Agent): AgentResponseDto {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      avatar: agent.avatar,
      systemPrompt: agent.systemPrompt,
      modelPreset: agent.modelPreset,
      defaultStrategy: agent.defaultStrategy,
      allowedStrategies: agent.allowedStrategies,
      toolGroups: agent.toolGroups,
      skills: agent.skills,
      maxSteps: agent.maxSteps,
      enabled: agent.enabled,
      isDefault: agent.isDefault,
      createdAt: agent.createdAt.getTime(),
      updatedAt: agent.updatedAt.getTime(),
    };
  }
}

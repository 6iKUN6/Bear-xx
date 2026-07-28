import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { StreamTaskService } from '../stream-task/stream-task.service';
import { AgentTestDto } from './dto/agent-test.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Sse, SseInterceptor, type SseRequest } from '../../common/sse';
import type { LlmTextRequest } from '../llm/llm.types';

/**
 * 管理端智能体流式测试
 * @description 复用 StreamTask 链路发起一次流式对话，实时回传 strategy/tool/model/message
 * 事件供 admin 观察 agent 调用情况。任务落库但打 isTest 标记，不进真实观测统计。
 */
@ApiTags('管理-智能体测试')
@ApiBearerAuth()
@Controller('admin/agent-tests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminAgentTestController {
  constructor(private readonly streamTaskService: StreamTaskService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: '测试流式响应',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiOperation({
    summary: '发起一次智能体流式测试（管理员）',
    description:
      '每次新建独立会话跑一轮，实时回传执行事件；任务标记 isTest，不计入观测统计',
    operationId: 'runAgentTest',
  })
  async runAgentTest(
    @Body() dto: AgentTestDto,
    @CurrentUser('id') userId: string,
    @Req() req: SseRequest,
  ) {
    if (!userId) {
      throw new UnauthorizedException('请先登录');
    }
    const llmRequest: LlmTextRequest | undefined = dto.modelPreset
      ? { model: { modelId: dto.modelPreset } }
      : undefined;

    return this.streamTaskService.streamChatTask(
      undefined, // 每次测试新建会话，不复用历史
      dto.content,
      userId,
      llmRequest,
      req.__sseAbortSignal,
      dto.agentId,
      true, // isTest
    );
  }
}

import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Body,
  Req,
  UseGuards,
  UseInterceptors,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Sse, SseInterceptor, type SseRequest } from '../../common/sse';
import { ResumeStreamTaskDto } from './dto/resume-stream-task.dto';
import { SubmitApprovalDto } from './dto/submit-approval.dto';
import {
  CancelStreamTaskResultDto,
  StreamTaskEventPayloadDto,
  StreamTaskStatusDto,
} from './dto/stream-task-response.dto';
import { StreamTaskEventType } from './stream-task-event.types';
import { StreamTaskService } from './stream-task.service';

@ApiTags('流式任务')
@ApiBearerAuth()
@ApiExtraModels(StreamTaskEventPayloadDto)
@Controller('stream-tasks')
@UseGuards(JwtAuthGuard)
export class StreamTaskController {
  constructor(private readonly streamTaskService: StreamTaskService) {}

  @Get(':taskId')
  @ApiOperation({ summary: '查询流式任务状态' })
  @ApiOkResponse({ description: '流式任务状态', type: StreamTaskStatusDto })
  async getTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.streamTaskService.getTaskStatus(taskId, userId);
  }

  @Get(':taskId/stream')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: '浏览器流式任务建链/恢复' })
  @ApiOkResponse({
    description: '流式事件响应，data 为序列化后的任务事件载荷',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example: `id: 1751450000000-0\nevent: ${StreamTaskEventType.MessageDelta}\ndata: {"type":"${StreamTaskEventType.MessageDelta}","taskId":"cmf_task_123","streamId":"cmf_stream_123","conversationId":"cmf_conv_123","messageId":"cmf_msg_123","status":"streaming","payload":{"delta":"你好"}}\n\n`,
        },
      },
    },
  })
  async streamTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Query('cursor', new DefaultValuePipe('0')) cursor: string,
    @Req() req: SseRequest,
  ) {
    const lastEventId =
      req.__sseLastEventId !== undefined ? req.__sseLastEventId : cursor;
    return this.streamTaskService.openTaskStream(
      taskId,
      userId,
      lastEventId,
      req.__sseAbortSignal,
    );
  }

  @Post(':taskId/resume')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: '微信小程序/通用客户端恢复流式任务' })
  @ApiOkResponse({
    description: '流式事件响应，data 为序列化后的任务事件载荷',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example: `id: 1751450000000-0\nevent: ${StreamTaskEventType.MessageDelta}\ndata: {"type":"${StreamTaskEventType.MessageDelta}","taskId":"cmf_task_123","streamId":"cmf_stream_123","conversationId":"cmf_conv_123","messageId":"cmf_msg_123","status":"streaming","payload":{"delta":"你好"}}\n\n`,
        },
      },
    },
  })
  async resumeTask(
    @Param('taskId') taskId: string,
    @Body() dto: ResumeStreamTaskDto,
    @CurrentUser('id') userId: string,
    @Req() req: SseRequest,
  ) {
    const lastEventId = dto.lastEventId ?? req.__sseLastEventId ?? '0';
    return this.streamTaskService.openTaskStream(
      taskId,
      userId,
      lastEventId,
      req.__sseAbortSignal,
    );
  }

  @Post(':taskId/approval')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: '提交人工审批决定并恢复流式任务（HITL）',
    description:
      '对处于 WAITING_HUMAN 的任务提交 approve/reject/edit 决定，并从中断处继续流式返回。',
  })
  @ApiOkResponse({
    description: '恢复后的流式事件响应',
    content: {
      'text/event-stream': {
        schema: { type: 'string' },
      },
    },
  })
  async submitApproval(
    @Param('taskId') taskId: string,
    @Body() dto: SubmitApprovalDto,
    @CurrentUser('id') userId: string,
    @Req() req: SseRequest,
  ) {
    const lastEventId = dto.lastEventId ?? req.__sseLastEventId ?? '0';
    return this.streamTaskService.resumeTaskWithDecision(
      taskId,
      userId,
      {
        decision: dto.decision,
        editedArgs: dto.editedArgs,
        reason: dto.reason,
      },
      lastEventId,
      req.__sseAbortSignal,
    );
  }

  @Post(':taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '取消流式任务' })
  @ApiOkResponse({
    description: '取消后的任务状态',
    type: CancelStreamTaskResultDto,
  })
  async cancelTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.streamTaskService.cancelTask(taskId, userId);
  }
}

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
  ParseIntPipe,
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
import { ResumeSseDto } from './dto/resume-sse.dto';
import {
  CancelSseTaskResultDto,
  SseTaskEventPayloadDto,
  SseTaskStatusDto,
} from './dto/sse-task-response.dto';
import { SseTaskService } from './sse-task.service';

@ApiTags('SSE 任务')
@ApiBearerAuth()
@ApiExtraModels(SseTaskEventPayloadDto)
@Controller('sse-tasks')
@UseGuards(JwtAuthGuard)
export class SseTaskController {
  constructor(private readonly sseTaskService: SseTaskService) {}

  @Get(':taskId')
  @ApiOperation({ summary: '查询 SSE 任务状态' })
  @ApiOkResponse({ description: 'SSE 任务状态', type: SseTaskStatusDto })
  async getTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sseTaskService.getTaskStatus(taskId, userId);
  }

  @Get(':taskId/stream')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Sse()
  @UseInterceptors(SseInterceptor)
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: '浏览器 SSE 建链/恢复' })
  @ApiOkResponse({
    description: 'SSE 事件流，data 为序列化后的任务事件载荷',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'id: 1\nevent: message.delta\ndata: {"type":"message.delta","taskId":"cmf_task_123","conversationId":"cmf_conv_123","messageId":"cmf_msg_123","status":"streaming","payload":{"delta":"你好"}}\n\n',
        },
      },
    },
  })
  async streamTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Query('cursor', new DefaultValuePipe('0'), ParseIntPipe) cursor: number,
    @Req() req: SseRequest,
  ) {
    const lastEventId =
      req.__sseLastEventId !== undefined ? req.__sseLastEventId : cursor;
    return this.sseTaskService.resumeTaskStream(
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
  @ApiOperation({ summary: '微信小程序/通用客户端恢复 SSE' })
  @ApiOkResponse({
    description: 'SSE 事件流，data 为序列化后的任务事件载荷',
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'id: 1\nevent: message.delta\ndata: {"type":"message.delta","taskId":"cmf_task_123","conversationId":"cmf_conv_123","messageId":"cmf_msg_123","status":"streaming","payload":{"delta":"你好"}}\n\n',
        },
      },
    },
  })
  async resumeTask(
    @Param('taskId') taskId: string,
    @Body() dto: ResumeSseDto,
    @CurrentUser('id') userId: string,
    @Req() req: SseRequest,
  ) {
    const lastEventId = dto.lastEventId ?? req.__sseLastEventId ?? 0;
    return this.sseTaskService.resumeTaskStream(
      taskId,
      userId,
      lastEventId,
      req.__sseAbortSignal,
    );
  }

  @Post(':taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '取消 SSE 任务' })
  @ApiOkResponse({
    description: '取消后的任务状态',
    type: CancelSseTaskResultDto,
  })
  async cancelTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sseTaskService.cancelTask(taskId, userId);
  }
}

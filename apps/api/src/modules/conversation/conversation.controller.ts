import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ConversationService } from './conversation.service';
import {
  AddConversationAgentDto,
  CreateConversationDto,
  UpdateConversationDto,
} from './dto/create-conversation.dto';
import { ConversationDto } from './dto/conversation-response.dto';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('会话')
@ApiBearerAuth()
@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  @ApiOperation({
    summary: '获取所有会话',
    description: '返回当前用户的所有会话及消息列表',
  })
  @ApiOkResponse({
    description: '会话列表',
    type: ConversationDto,
    isArray: true,
  })
  async findAll(@CurrentUser('id') userId: string) {
    return this.conversationService.findAllByUser(userId);
  }

  @Post()
  @ApiOperation({
    summary: '创建会话（单聊/群聊）',
    description:
      'SINGLE 绑定单个智能体（重复创建幂等返回既有单聊）；GROUP 需 agentIds ≥2 初始成员。',
  })
  @ApiOkResponse({ description: '会话信息', type: ConversationDto })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationService.create(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新会话（群名/默认回答者）' })
  @ApiOkResponse({ type: ConversationDto })
  async update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversationService.update(id, userId, dto);
  }

  @Post(':id/agents')
  @ApiOperation({ summary: '群聊添加智能体成员（幂等）' })
  @ApiOkResponse({ type: ConversationDto })
  async addAgent(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddConversationAgentDto,
  ) {
    return this.conversationService.addAgent(id, userId, dto.agentId);
  }

  @Delete(':id/agents/:agentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '群聊移除智能体成员',
    description: '仅影响可 @ 列表与路由候选，历史消息完整保留。',
  })
  @ApiOkResponse({ type: ConversationDto })
  async removeAgent(
    @Param('id') id: string,
    @Param('agentId') agentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.conversationService.removeAgent(id, userId, agentId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '删除会话',
    description: '删除指定会话及其所有消息',
  })
  @ApiOkResponse({
    description: '删除成功',
    type: EmptyResultDto,
  })
  async delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.conversationService.delete(id, userId);
    return { success: true };
  }
}

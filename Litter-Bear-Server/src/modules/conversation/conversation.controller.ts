import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConversationService } from './conversation.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
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
  async findAll(@CurrentUser('id') userId: string) {
    return this.conversationService.findAllByUser(userId);
  }

  @Post()
  @ApiOperation({ summary: '创建新会话' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationService.create(userId, dto.title);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '删除会话',
    description: '删除指定会话及其所有消息',
  })
  async delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.conversationService.delete(id, userId);
    return null;
  }
}

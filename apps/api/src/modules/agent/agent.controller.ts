import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { AgentResponseDto } from './dto/agent-response.dto';
import { AgentModelOptionsDto } from './dto/agent-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('智能体')
@ApiBearerAuth()
@Controller('agents')
@UseGuards(JwtAuthGuard)
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get()
  @ApiOperation({
    summary: '获取智能体列表',
    description: '供客户端选择智能体',
  })
  @ApiOkResponse({ type: AgentResponseDto, isArray: true })
  async list(@CurrentUser('id') userId: string) {
    return this.agentService.list(userId);
  }

  /**
   * 获取指定智能体允许终端选择的模型
   * @param id 智能体 ID
   * @param userId 当前登录用户 ID
   * @returns 返回不含连接凭据与后台探测细节的模型选项
   * @description 按可使用权限校验而不是 visible 过滤；只有有效 Flow 使用 agent-default 时才返回选项。
   */
  @Get(':id/models')
  @ApiOperation({ summary: '获取智能体可选模型' })
  @ApiOkResponse({ type: AgentModelOptionsDto })
  async models(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.agentService.listModelOptions(id, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取智能体详情' })
  @ApiOkResponse({ type: AgentResponseDto })
  async get(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.agentService.get(id, userId);
  }
}

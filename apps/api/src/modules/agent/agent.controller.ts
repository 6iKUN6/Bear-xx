import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { AgentResponseDto } from './dto/agent-response.dto';
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

  @Get(':id')
  @ApiOperation({ summary: '获取智能体详情' })
  @ApiOkResponse({ type: AgentResponseDto })
  async get(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.agentService.get(id, userId);
  }
}

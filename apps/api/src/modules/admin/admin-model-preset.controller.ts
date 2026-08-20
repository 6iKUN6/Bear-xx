import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ModelPresetService } from './model-preset.service';
import {
  CreateModelPresetDto,
  ModelPresetProbeResultDto,
  ModelPresetResponseDto,
  ProbeModelPresetDto,
  UpdateModelPresetDto,
} from './dto/model-preset.dto';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('管理-模型预设')
@ApiBearerAuth()
@Controller('admin/model-presets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminModelPresetController {
  constructor(private readonly service: ModelPresetService) {}

  @Get()
  @ApiOperation({ summary: '模型预设列表（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto, isArray: true })
  list() {
    return this.service.list();
  }

  @Get(':id')
  @ApiOperation({ summary: '模型预设详情（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post()
  @ApiOperation({ summary: '新建模型预设（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto })
  create(@Body() dto: CreateModelPresetDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新模型预设（管理员）' })
  @ApiOkResponse({ type: ModelPresetResponseDto })
  update(@Param('id') id: string, @Body() dto: UpdateModelPresetDto) {
    return this.service.update(id, dto);
  }

  @Post('probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '探测尚未保存的模型连接（管理员）',
    description:
      '两级探测：L1 验证连通性，L2 验证工具往返闭环。不落库、不改动任何预设。',
  })
  @ApiOkResponse({ type: ModelPresetProbeResultDto })
  probeDraft(@Body() dto: ProbeModelPresetDto) {
    return this.service.probeDraft(dto);
  }

  @Post(':id/probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '探测已保存的模型预设并写回能力档位（管理员）',
    description:
      '使用已落库的密文密钥；结论写入 capability 与 lastCheck* 字段。',
  })
  @ApiOkResponse({ type: ModelPresetProbeResultDto })
  probeExisting(@Param('id') id: string) {
    return this.service.probeExisting(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除模型预设（管理员）' })
  @ApiOkResponse({ type: EmptyResultDto })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { success: true };
  }
}

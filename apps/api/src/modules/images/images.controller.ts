import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ImageGenerationService } from './image-generation.service';
import {
  CreateImageDto,
  EditImageDto,
  GeneratedImageDto,
} from './dto/create-image.dto';

@ApiTags('AI 生图')
@ApiBearerAuth()
@Controller('images')
@UseGuards(JwtAuthGuard)
export class ImagesController {
  constructor(
    private readonly imageGenerationService: ImageGenerationService,
  ) {}

  @Post('generations')
  @ApiOperation({
    summary: '直调生图',
    description:
      '同步生成一张图并转存七牛（生图可能耗时数十秒，客户端需放宽超时）。生图模型未配置时返回 503。后续量大可升级为 StreamTask 异步任务。',
  })
  @ApiOkResponse({ type: GeneratedImageDto })
  generate(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateImageDto,
  ): Promise<GeneratedImageDto> {
    return this.imageGenerationService.generate(userId, dto.prompt, dto.size);
  }

  @Post('edits')
  @ApiOperation({
    summary: '参考图生图（图生图/改图）',
    description:
      '基于 1-4 张参考图（七牛 key 或完整 URL）+ prompt 出新图并转存。生图模型未配置时返回 503。',
  })
  @ApiOkResponse({ type: GeneratedImageDto })
  edit(
    @CurrentUser('id') userId: string,
    @Body() dto: EditImageDto,
  ): Promise<GeneratedImageDto> {
    return this.imageGenerationService.edit(userId, {
      prompt: dto.prompt,
      sourceKeys: dto.sourceKeys,
      sourceUrls: dto.sourceUrls,
      size: dto.size,
    });
  }
}

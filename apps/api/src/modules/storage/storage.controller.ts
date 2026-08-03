import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { QiniuStorageService } from './qiniu-storage.service';
import { StorageAssetService } from './storage-asset.service';
import {
  AccessUrlResponseDto,
  UploadCredentialDto,
  UploadCredentialResponseDto,
} from './dto/upload-credential.dto';
import {
  ListAssetsQueryDto,
  RegisterAssetDto,
  StorageAssetDto,
  UpdateAssetStatusDto,
} from './dto/storage-asset.dto';

@ApiTags('对象存储')
@ApiBearerAuth()
@Controller('storage')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(
    private readonly qiniuStorageService: QiniuStorageService,
    private readonly storageAssetService: StorageAssetService,
  ) {}

  @Post('upload-credential')
  @ApiOperation({
    summary: '签发直传凭证',
    description:
      '客户端拿 token/key 直传七牛（表单带 token、key），文件不经过本服务；上传成功后调 POST /storage/assets 登记。',
  })
  @ApiOkResponse({ type: UploadCredentialResponseDto })
  createUploadCredential(
    @CurrentUser('id') userId: string,
    @Body() dto: UploadCredentialDto,
  ): UploadCredentialResponseDto {
    return this.qiniuStorageService.createUploadCredential(
      userId,
      dto.type,
      dto.ext,
      dto.usage,
    );
  }

  @Get('access-url')
  @ApiOperation({
    summary: '获取对象访问 URL',
    description: '私有空间返回带签名的临时 URL；公开空间返回固定 URL。',
  })
  @ApiOkResponse({ type: AccessUrlResponseDto })
  resolveAccessUrl(@Query('key') key: string): AccessUrlResponseDto {
    if (!key?.trim()) {
      throw new BadRequestException('缺少对象 key');
    }
    return { url: this.qiniuStorageService.resolveAccessUrl(key.trim()) };
  }

  @Post('assets')
  @ApiOperation({
    summary: '登记直传成功的资产',
    description: '幂等：同 key 重复登记返回既有记录并补全元数据。',
  })
  @ApiOkResponse({ type: StorageAssetDto })
  registerAsset(
    @CurrentUser('id') userId: string,
    @Body() dto: RegisterAssetDto,
  ): Promise<StorageAssetDto> {
    return this.storageAssetService.register(userId, dto);
  }

  @Get('assets')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({
    summary: '资产列表（管理员）',
    description: '复用选择器数据源；默认只列 ACTIVE，按创建时间倒序。',
  })
  @ApiOkResponse({ type: StorageAssetDto, isArray: true })
  listAssets(@Query() query: ListAssetsQueryDto): Promise<StorageAssetDto[]> {
    return this.storageAssetService.list(query);
  }

  @Patch('assets/:id/status')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: '标记资产状态（管理员）：BROKEN/DELETED/ACTIVE' })
  @ApiOkResponse({ type: StorageAssetDto })
  updateAssetStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAssetStatusDto,
  ): Promise<StorageAssetDto> {
    return this.storageAssetService.updateStatus(id, dto.status);
  }
}

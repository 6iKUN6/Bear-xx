import {
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
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CosStorageService } from './cos-storage.service';
import { StorageAssetService } from './storage-asset.service';
import {
  CosUploadCredentialDto,
  CosUploadCredentialResponseDto,
} from './dto/cos-upload-credential.dto';
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
    private readonly storageAssetService: StorageAssetService,
    private readonly cosStorageService: CosStorageService,
  ) {}

  /**
   * 签发腾讯云 COS 单对象直传凭证
   * @param userId 当前认证用户ID
   * @param dto COS 上传媒体类型与文件扩展名
   * @returns 返回单对象 PUT 地址、访问地址、请求头与过期时间
   * @description 仅向 COS 服务传递用户 ID、type 与 ext，签发短期 PUT URL，文件二进制不经过 API 服务。
   */
  @Post('cos/upload-credential')
  @ApiOperation({
    summary: '签发腾讯云 COS 小程序直传凭证',
    description: '单对象、短期 PUT 直传，不经过 API 服务。',
  })
  @ApiOkResponse({ type: CosUploadCredentialResponseDto })
  createCosUploadCredential(
    @CurrentUser('id') userId: string,
    @Body() dto: CosUploadCredentialDto,
  ): Promise<CosUploadCredentialResponseDto> {
    return this.cosStorageService.createUploadCredential(
      userId,
      dto.type,
      dto.ext,
    );
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
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
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
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: '标记资产状态（管理员）：BROKEN/DELETED/ACTIVE' })
  @ApiOkResponse({ type: StorageAssetDto })
  updateAssetStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAssetStatusDto,
  ): Promise<StorageAssetDto> {
    return this.storageAssetService.updateStatus(id, dto.status);
  }
}

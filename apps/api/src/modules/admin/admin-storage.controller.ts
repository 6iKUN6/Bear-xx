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
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  AdminImageUploadCredentialDto,
  AdminImageUploadCredentialResponseDto,
  AdminRegisterImageAssetDto,
  AdminStorageAssetDto,
  AdminStorageAssetListQueryDto,
  AdminStorageAssetPageDto,
  AdminUpdateStorageAssetStatusDto,
} from '../storage/dto/admin-storage.dto';
import { StorageAssetService } from '../storage/storage-asset.service';

@ApiTags('管理-图片资源')
@ApiBearerAuth()
@Controller('admin/storage')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminStorageController {
  constructor(private readonly service: StorageAssetService) {}

  /**
   * 签发后台图片直传凭证
   * @param userId 当前管理员用户ID
   * @param dto 图片扩展名、用途和声明大小
   * @returns 返回单对象 COS PUT 地址、访问 URL、请求头和过期时间
   * @description 服务层先执行后台格式与用途大小限制，再为随机图片 key 签发短期凭证。
   */
  @Post('upload-credential')
  @ApiOperation({ summary: '签发后台图片直传凭证' })
  @ApiOkResponse({ type: AdminImageUploadCredentialResponseDto })
  createUploadCredential(
    @CurrentUser('id') userId: string,
    @Body() dto: AdminImageUploadCredentialDto,
  ) {
    return this.service.createAdminImageUploadCredential(userId, dto);
  }

  /**
   * 登记后台直传成功的图片
   * @param userId 当前管理员用户ID
   * @param dto 对象 key、用途、文件元数据与原文件名
   * @returns 返回已登记图片的管理投影
   * @description 复用资产登记的归属校验与幂等 upsert，原文件名只用于管理展示和搜索。
   */
  @Post('assets')
  @ApiOperation({ summary: '登记后台上传图片' })
  @ApiOkResponse({ type: AdminStorageAssetDto })
  registerAsset(
    @CurrentUser('id') userId: string,
    @Body() dto: AdminRegisterImageAssetDto,
  ) {
    return this.service.registerAdminImage(userId, dto);
  }

  /**
   * 分页查询图片资源库
   * @param query 页码、搜索、用途和状态过滤
   * @returns 返回图片资源分页结果
   * @description 只查询已登记图片；不读取 COS 对象清单，也不把接口失败伪装成空列表。
   */
  @Get('assets')
  @ApiOperation({ summary: '分页查询图片资源库' })
  @ApiOkResponse({ type: AdminStorageAssetPageDto })
  listAssets(@Query() query: AdminStorageAssetListQueryDto) {
    return this.service.listAdminImages(query);
  }

  /**
   * 软删除或恢复图片资源
   * @param id 资产ID
   * @param dto 目标 ACTIVE 或 DELETED 状态
   * @returns 返回更新后的图片资源
   * @description 只更新登记簿状态，不删除 COS 对象；BROKEN 与 DELETED 均可恢复为 ACTIVE。
   */
  @Patch('assets/:id/status')
  @ApiOperation({ summary: '软删除或恢复图片资源' })
  @ApiOkResponse({ type: AdminStorageAssetDto })
  updateAssetStatus(
    @Param('id') id: string,
    @Body() dto: AdminUpdateStorageAssetStatusDto,
  ) {
    return this.service.updateAdminImageStatus(id, dto.status);
  }
}

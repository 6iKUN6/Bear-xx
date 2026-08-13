import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BindMcDonaldsCredentialDto } from './dto/bind-mcdonalds-credential.dto';
import { McDonaldsCredentialResponseDto } from './dto/mcdonalds-credential-response.dto';
import { McDonaldsCredentialService } from './mcdonalds-credential.service';

/** 用户麦当劳 MCP Token 绑定接口。 */
@ApiTags('麦当劳账号')
@ApiBearerAuth()
@ApiExtraModels(McDonaldsCredentialResponseDto)
@Controller('mcdonalds-credential')
@UseGuards(JwtAuthGuard)
export class McDonaldsCredentialController {
  constructor(
    private readonly mcdonaldsCredentialService: McDonaldsCredentialService,
  ) {}

  /**
   * 查询当前麦当劳 MCP Token 绑定状态
   * @param userId 当前认证用户ID
   * @returns 返回安全凭据摘要；未绑定时返回 null
   * @description 响应中不包含 Token、密文、完整指纹或远端 MCP 响应。
   */
  @Get()
  @ApiOperation({ summary: '获取我的麦当劳账号绑定状态' })
  @ApiOkResponse({
    description: '已绑定时返回安全凭据摘要，未绑定时 data 为 null',
    schema: {
      allOf: [{ $ref: getSchemaPath(McDonaldsCredentialResponseDto) }],
      nullable: true,
    },
  })
  getActive(
    @CurrentUser('id') userId: string,
  ): Promise<McDonaldsCredentialResponseDto | null> {
    return this.mcdonaldsCredentialService.getActive(userId);
  }

  /**
   * 绑定或替换当前用户的麦当劳 MCP Token
   * @param userId 当前认证用户ID
   * @param body 包含本次提交 Token 的请求体
   * @returns 返回新活跃凭据的安全摘要
   * @description 绑定前执行 MCP tools/list 校验，成功后撤销此前活跃凭据；历史订单不会被删除。
   */
  @Put()
  @ApiOperation({ summary: '绑定麦当劳 MCP Token' })
  @ApiOkResponse({ type: McDonaldsCredentialResponseDto })
  bind(
    @CurrentUser('id') userId: string,
    @Body() body: BindMcDonaldsCredentialDto,
  ): Promise<McDonaldsCredentialResponseDto> {
    return this.mcdonaldsCredentialService.bind(userId, body.token);
  }

  /**
   * 解绑当前用户的麦当劳 MCP Token
   * @param userId 当前认证用户ID
   * @returns 无返回值
   * @description 凭据撤销后订单仅保留只读展示，不能继续刷新、支付或创建新订单。
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '解绑麦当劳 MCP Token' })
  @ApiNoContentResponse({ description: '已解绑或当前未绑定' })
  async unbind(@CurrentUser('id') userId: string): Promise<void> {
    await this.mcdonaldsCredentialService.unbind(userId);
  }
}

import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AccountLoginDto } from './dto/account-login.dto';
import { WechatBindDto } from './dto/wechat-bind.dto';
import { WechatLoginDto } from './dto/wechat-login.dto';
import { SendCodeDto, PhoneLoginDto } from './dto/phone-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LoginResultDto } from './dto/auth-response.dto';
import { EmptyResultDto } from '../../common/dto/empty-result.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '微信登录',
    description:
      '使用已绑定账号的微信 code 换取 JWT Token；未绑定时需先使用手机号登录并绑定微信',
  })
  @ApiOkResponse({ description: '登录成功', type: LoginResultDto })
  async wechatLogin(@Body() dto: WechatLoginDto) {
    return this.authService.wechatLogin(dto.code);
  }

  @Post('wechat/bind')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '绑定微信账号',
    description: '将微信 code 对应的微信身份绑定到当前已登录账号',
  })
  @ApiOkResponse({ description: '绑定成功', type: LoginResultDto })
  async bindWechat(
    @Body() dto: WechatBindDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.authService.bindWechat(userId, dto.code);
  }

  @Post('phone/send-code')
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送手机验证码',
    description: '向指定手机号发送短信验证码，60秒内不可重复发送',
  })
  @ApiOkResponse({
    description: '验证码发送成功',
    type: EmptyResultDto,
  })
  async sendCode(@Body() dto: SendCodeDto) {
    await this.authService.sendPhoneCode(dto.phone);
    return { success: true };
  }

  @Post('account/login')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '账号密码登录或自动注册',
    description: '使用账号名和密码登录；若账号不存在，则自动注册后返回登录态',
  })
  @ApiOkResponse({ description: '登录成功', type: LoginResultDto })
  async accountLogin(@Body() dto: AccountLoginDto) {
    return this.authService.accountLogin(
      dto.username,
      dto.password,
      dto.nickname,
    );
  }

  @Post('phone/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手机号密码登录或自动注册',
    description: '使用手机号和密码登录；若手机号不存在，则自动注册后返回登录态',
  })
  @ApiOkResponse({ description: '登录成功', type: LoginResultDto })
  async phoneLogin(@Body() dto: PhoneLoginDto) {
    return this.authService.phonePasswordLogin(dto.phone, dto.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '刷新令牌',
    description: '使用 Refresh Token 换取新的 Access Token',
  })
  @ApiOkResponse({ description: '刷新成功', type: LoginResultDto })
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '登出',
    description: '将当前 Access Token 加入黑名单',
  })
  @ApiOkResponse({
    description: '登出成功',
    type: EmptyResultDto,
  })
  async logout(@CurrentUser('jti') jti: string) {
    await this.authService.logout(jti);
    return { success: true };
  }
}

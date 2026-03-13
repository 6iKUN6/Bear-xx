import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { WechatLoginDto } from './dto/wechat-login.dto';
import { SendCodeDto, PhoneLoginDto } from './dto/phone-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
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
    description: '使用微信 code 换取 JWT Token',
  })
  async wechatLogin(@Body() dto: WechatLoginDto) {
    return this.authService.wechatLogin(dto.code);
  }

  @Post('phone/send-code')
  @Throttle({ default: { limit: 1, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送手机验证码',
    description: '向指定手机号发送短信验证码，60秒内不可重复发送',
  })
  async sendCode(@Body() dto: SendCodeDto) {
    await this.authService.sendPhoneCode(dto.phone);
    return null;
  }

  @Post('phone/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手机号登录',
    description: '使用手机号 + 验证码登录，自动注册新用户',
  })
  async phoneLogin(@Body() dto: PhoneLoginDto) {
    return this.authService.phoneLogin(dto.phone, dto.code);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '刷新令牌',
    description: '使用 Refresh Token 换取新的 Access Token',
  })
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
  async logout(@CurrentUser('jti') jti: string) {
    await this.authService.logout(jti);
    return null;
  }
}

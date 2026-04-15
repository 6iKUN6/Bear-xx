import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { v4 as uuidv4 } from 'uuid';
import type { StringValue } from 'ms';
import { User } from '@prisma/client';
import { UserService } from '../user/user.service';
import { SmsService } from '../sms/sms.service';
import { RedisService } from '../../redis/redis.service';
import { JwtPayload } from './strategies/jwt.strategy';

interface WechatSessionResponse {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  user: { id: string; nickname: string; avatarUrl: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly smsService: SmsService,
    private readonly redis: RedisService,
  ) {}

  // ─── WeChat Login ───

  async wechatLogin(code: string): Promise<LoginResult> {
    const { openid, unionid } = await this.code2Session(code);
    const user = await this.userService.findOrCreateByOpenId(openid, unionid);
    return this.buildLoginResult(user);
  }

  private async code2Session(
    code: string,
  ): Promise<{ openid: string; unionid?: string }> {
    const appId = this.configService.get<string>('WECHAT_APP_ID');
    const appSecret = this.configService.get<string>('WECHAT_APP_SECRET');

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;

    const res = await fetch(url);
    const data = (await res.json()) as WechatSessionResponse;

    if (data.errcode) {
      this.logger.warn(`WeChat code2Session failed: ${data.errmsg}`);
      throw new UnauthorizedException(
        `微信登录失败: ${data.errmsg || 'unknown error'}`,
      );
    }

    return { openid: data.openid!, unionid: data.unionid };
  }

  // ─── Phone Login ───

  async sendPhoneCode(phone: string): Promise<void> {
    await this.smsService.sendCode(phone);
  }

  async phoneLogin(phone: string, code: string): Promise<LoginResult> {
    const valid = await this.smsService.verifyCode(phone, code);
    if (!valid) {
      throw new BadRequestException('验证码错误或已过期');
    }

    const user = await this.userService.findOrCreateByPhone(phone);
    return this.buildLoginResult(user);
  }

  // ─── Token Refresh ───

  async refreshToken(refreshToken: string): Promise<LoginResult> {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token 无效或已过期');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    // Check blacklist
    const blacklisted = await this.redis.get(`token:blacklist:${payload.jti}`);
    if (blacklisted) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const user = await this.userService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    // Blacklist old refresh token
    await this.blacklistToken(payload.jti, 7 * 24 * 3600);

    return this.buildLoginResult(user);
  }

  // ─── Logout ───

  async logout(jti: string): Promise<void> {
    // Blacklist access token (TTL = 2h max)
    await this.blacklistToken(jti, 2 * 3600);
  }

  // ─── Helpers ───

  private async generateTokens(userId: string): Promise<TokenPair> {
    const accessJti = uuidv4();
    const refreshJti = uuidv4();

    const accessPayload: JwtPayload = {
      sub: userId,
      jti: accessJti,
      type: 'access',
    };
    const refreshPayload: JwtPayload = {
      sub: userId,
      jti: refreshJti,
      type: 'refresh',
    };

    const accessExpiresIn = (this.configService.get<string>(
      'JWT_ACCESS_EXPIRES_IN',
    ) || '2h') as StringValue;
    const refreshExpiresIn = (this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
    ) || '7d') as StringValue;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        accessPayload as unknown as Record<string, unknown>,
        {
          secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
          expiresIn: accessExpiresIn,
        },
      ),
      this.jwtService.signAsync(
        refreshPayload as unknown as Record<string, unknown>,
        {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
          expiresIn: refreshExpiresIn,
        },
      ),
    ]);

    return { accessToken, refreshToken };
  }

  private async buildLoginResult(user: User): Promise<LoginResult> {
    const tokens = await this.generateTokens(user.id);
    return {
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  private async blacklistToken(jti: string, ttl: number): Promise<void> {
    await this.redis.set(`token:blacklist:${jti}`, '1', 'EX', ttl);
  }
}

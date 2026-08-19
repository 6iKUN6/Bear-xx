import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'crypto';
import type { StringValue } from 'ms';
import { User } from '@prisma/client';
import { UserService } from '../user/user.service';
import { SmsService } from '../sms/sms.service';
import { RedisService } from '../../redis/redis.service';
import { JwtPayload } from './strategies/jwt.strategy';
import { promisify } from 'util';

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

const PASSWORD_SALT_LENGTH = 16;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_HASH_PREFIX = 'scrypt';
const scrypt = promisify(scryptCallback);

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

  /**
   * 使用微信登录凭证完成登录
   * @param code 微信登录 code
   * @returns 返回登录结果，包含 access token、refresh token 和用户信息
   * @description 调用微信换取身份信息接口，查询或创建本地用户后，签发系统登录态。
   */
  async wechatLogin(code: string): Promise<LoginResult> {
    const { openid, unionid } = await this.code2Session(code);
    const user =
      (await this.userService.findByOpenId(openid)) ??
      (unionid ? await this.userService.findByUnionId(unionid) : null);

    if (!user) {
      throw new UnauthorizedException('微信未绑定账号，请先使用手机号登录');
    }

    return this.buildLoginResult(user);
  }

  /**
   * 绑定微信身份到当前登录用户
   * @param userId 当前登录用户ID
   * @param code 微信登录 code
   * @returns 返回登录结果，包含 access token、refresh token 和用户信息
   * @description 将微信 code 换取的 OpenID/UnionID 绑定到当前用户；如果微信身份已绑定其他账号，则拒绝绑定。
   */
  async bindWechat(userId: string, code: string): Promise<LoginResult> {
    const { openid, unionid } = await this.code2Session(code);
    const currentUser = await this.userService.findById(userId);

    if (!currentUser) {
      throw new UnauthorizedException('用户不存在');
    }

    if (currentUser.wechatOpenId && currentUser.wechatOpenId !== openid) {
      throw new ConflictException('当前账号已绑定其他微信');
    }

    if (
      unionid &&
      currentUser.wechatUnionId &&
      currentUser.wechatUnionId !== unionid
    ) {
      throw new ConflictException('当前账号已绑定其他微信');
    }

    const userByOpenId = await this.userService.findByOpenId(openid);
    if (userByOpenId && userByOpenId.id !== userId) {
      throw new ConflictException('该微信已绑定其他账号');
    }

    if (unionid) {
      const userByUnionId = await this.userService.findByUnionId(unionid);
      if (userByUnionId && userByUnionId.id !== userId) {
        throw new ConflictException('该微信已绑定其他账号');
      }
    }

    if (
      currentUser.wechatOpenId === openid &&
      (!unionid || currentUser.wechatUnionId === unionid)
    ) {
      return this.buildLoginResult(currentUser);
    }

    const user = await this.userService.bindWechatIdentity(
      userId,
      openid,
      unionid,
    );
    return this.buildLoginResult(user);
  }

  /**
   * 调用微信 code2Session 接口
   * @param code 微信登录 code
   * @returns 返回微信身份信息，包含 openid 和可选的 unionid
   * @description 向微信服务端换取用户会话标识；如果微信接口返回错误，则抛出未授权异常。
   */
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

  /**
   * 发送手机验证码
   * @param phone 手机号
   * @returns 无返回值
   * @description 调用短信服务为指定手机号发送登录验证码。
   */
  async sendPhoneCode(phone: string): Promise<void> {
    await this.smsService.sendCode(phone);
  }

  /**
   * 使用账号密码登录或自动注册
   * @param username 账号名
   * @param password 登录密码
   * @param nickname 首次自动注册时使用的昵称
   * @returns 返回登录结果，包含 access token、refresh token 和用户信息
   * @description 若账号已存在则校验密码并登录；若账号不存在，则使用当前密码自动注册新用户后直接登录。
   */
  async accountLogin(
    username: string,
    password: string,
    nickname?: string,
  ): Promise<LoginResult> {
    const normalizedUsername = username.trim().toLowerCase();
    const existingUser =
      await this.userService.findByUsername(normalizedUsername);

    if (!existingUser) {
      const passwordHash = await this.hashPassword(password);
      const createdUser = await this.userService.createWithPassword({
        username: normalizedUsername,
        passwordHash,
        nickname,
      });
      return this.buildLoginResult(createdUser);
    }

    if (!existingUser.passwordHash) {
      throw new UnauthorizedException('该账号暂不支持密码登录');
    }

    const passwordMatched = await this.verifyPassword(
      password,
      existingUser.passwordHash,
    );
    if (!passwordMatched) {
      throw new UnauthorizedException('账号或密码错误');
    }

    return this.buildLoginResult(existingUser);
  }

  /**
   * 使用手机号密码登录或自动注册
   * @param phone 手机号
   * @param password 登录密码
   * @returns 返回登录结果，包含 access token、refresh token 和用户信息
   * @description 若手机号已存在则校验密码并登录；若手机号不存在，则使用当前密码自动注册新用户后直接登录。
   */
  async phonePasswordLogin(
    phone: string,
    password: string,
  ): Promise<LoginResult> {
    const normalizedPhone = phone.trim();
    const existingUser = await this.userService.findByPhone(normalizedPhone);

    if (!existingUser) {
      const passwordHash = await this.hashPassword(password);
      const createdUser = await this.userService.createWithPhonePassword({
        phone: normalizedPhone,
        passwordHash,
      });
      return this.buildLoginResult(createdUser);
    }

    if (!existingUser.passwordHash) {
      throw new UnauthorizedException('该手机号暂不支持密码登录');
    }

    const passwordMatched = await this.verifyPassword(
      password,
      existingUser.passwordHash,
    );
    if (!passwordMatched) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    return this.buildLoginResult(existingUser);
  }

  /**
   * 刷新登录令牌
   * @param refreshToken 刷新令牌
   * @returns 返回新的登录结果，包含新 access token、refresh token 和用户信息
   * @description 校验 refresh token 的合法性、类型和黑名单状态，通过后重新签发一组令牌。
   */
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

  /**
   * 执行登出
   * @param jti 当前访问令牌的唯一标识
   * @returns 无返回值
   * @description 将当前 access token 的 jti 加入黑名单，使该令牌在过期前立即失效。
   */
  async logout(jti: string): Promise<void> {
    // Blacklist access token (TTL = 2h max)
    await this.blacklistToken(jti, 2 * 3600);
  }

  /**
   * 生成一组登录令牌
   * @param userId 用户ID
   * @returns 返回 access token 和 refresh token
   * @description 为指定用户分别生成访问令牌和刷新令牌，并附带独立的 jti 与过期时间。
   */
  private async generateTokens(userId: string): Promise<TokenPair> {
    const accessJti = randomUUID();
    const refreshJti = randomUUID();

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

  /**
   * 组装登录返回结果
   * @param user 用户实体
   * @returns 返回统一的登录响应结构
   * @description 基于用户信息和新签发的令牌构建前端登录接口需要的响应体。
   */
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

  /**
   * 将令牌加入黑名单
   * @param jti 令牌唯一标识
   * @param ttl 黑名单过期时间，单位为秒
   * @returns 无返回值
   * @description 把指定 jti 写入 Redis 黑名单，直到 ttl 过期前都视为不可用。
   */
  private async blacklistToken(jti: string, ttl: number): Promise<void> {
    await this.redis.set(`token:blacklist:${jti}`, '1', 'EX', ttl);
  }

  /**
   * 生成密码哈希
   * @param password 明文密码
   * @returns 返回可持久化存储的密码哈希字符串
   * @description 使用随机盐和 scrypt 生成密码哈希，避免在数据库中存储明文密码。
   */
  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(PASSWORD_SALT_LENGTH).toString('hex');
    const derivedKey = (await scrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
    )) as Buffer;

    return [PASSWORD_HASH_PREFIX, salt, derivedKey.toString('hex')].join('$');
  }

  /**
   * 校验密码是否匹配
   * @param password 明文密码
   * @param storedPasswordHash 已存储的密码哈希
   * @returns 返回布尔值，true 表示密码匹配
   * @description 解析已存储的 scrypt 哈希并重新计算派生密钥，通过常量时间比较判断密码是否正确。
   */
  private async verifyPassword(
    password: string,
    storedPasswordHash: string,
  ): Promise<boolean> {
    const [prefix, salt, hashHex] = storedPasswordHash.split('$');
    if (!prefix || !salt || !hashHex || prefix !== PASSWORD_HASH_PREFIX) {
      return false;
    }

    const expectedBuffer = Buffer.from(hashHex, 'hex');
    const actualBuffer = (await scrypt(
      password,
      salt,
      expectedBuffer.length,
    )) as Buffer;

    return timingSafeEqual(expectedBuffer, actualBuffer);
  }
}

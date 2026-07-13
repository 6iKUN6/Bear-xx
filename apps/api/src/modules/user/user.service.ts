import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '@prisma/client';

const DEFAULT_NICKNAME_PREFIX = '用户';
const DEFAULT_NICKNAME_RANDOM_LENGTH = 6;

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 根据用户ID查询用户
   * @param id 用户ID
   * @returns 返回用户记录；若不存在则返回 null
   * @description 通过主键查询单个用户信息，常用于鉴权后加载用户资料。
   */
  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * 根据微信OpenID查询用户
   * @param wechatOpenId 微信OpenID
   * @returns 返回用户记录；若不存在则返回 null
   * @description 用于微信登录流程中定位已绑定 OpenID 的本地用户。
   */
  async findByOpenId(wechatOpenId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { wechatOpenId } });
  }

  /**
   * 根据微信UnionID查询用户
   * @param wechatUnionId 微信UnionID
   * @returns 返回用户记录；若不存在则返回 null
   * @description 当微信返回 unionid 时，用于判断该微信身份是否已经绑定到其他本地用户。
   */
  async findByUnionId(wechatUnionId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { wechatUnionId } });
  }

  /**
   * 根据手机号查询用户
   * @param phone 手机号
   * @returns 返回用户记录；若不存在则返回 null
   * @description 用于手机号登录、资料绑定等场景查询本地用户。
   */
  async findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  /**
   * 根据账号名查询用户
   * @param username 账号名
   * @returns 返回用户记录；若不存在则返回 null
   * @description 用于账号密码登录流程中按唯一账号名定位本地用户。
   */
  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  /**
   * 根据微信身份查询或创建用户
   * @param wechatOpenId 微信OpenID
   * @param wechatUnionId 微信UnionID
   * @returns 返回已存在或新创建的用户记录
   * @description 优先按 OpenID 查询本地用户；若不存在，则基于微信身份信息创建新用户。
   */
  async findOrCreateByOpenId(
    wechatOpenId: string,
    wechatUnionId?: string,
  ): Promise<User> {
    const existing = await this.findByOpenId(wechatOpenId);
    if (existing) return existing;

    return this.prisma.user.create({
      data: {
        wechatOpenId,
        wechatUnionId,
        nickname: this.generateDefaultNickname(),
      },
    });
  }

  /**
   * 根据手机号查询或创建用户
   * @param phone 手机号
   * @returns 返回已存在或新创建的用户记录
   * @description 优先按手机号查询本地用户；若不存在，则以该手机号创建新用户。
   */
  async findOrCreateByPhone(phone: string): Promise<User> {
    const existing = await this.findByPhone(phone);
    if (existing) return existing;

    return this.prisma.user.create({
      data: {
        phone,
        nickname: this.generateDefaultNickname(),
      },
    });
  }

  /**
   * 创建账号密码用户
   * @param data 账号密码用户创建数据
   * @returns 返回新创建的用户记录
   * @description 使用账号名、密码哈希和可选昵称创建本地用户，供账号密码登录入口在首登时自动注册。
   */
  async createWithPassword(data: {
    username: string;
    passwordHash: string;
    nickname?: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        username: data.username,
        passwordHash: data.passwordHash,
        passwordUpdatedAt: new Date(),
        nickname: data.nickname?.trim() || this.generateDefaultNickname(),
      },
    });
  }

  /**
   * 创建手机号密码用户
   * @param data 手机号密码用户创建数据
   * @returns 返回新创建的用户记录
   * @description 使用手机号和密码哈希创建本地用户，供手机号密码登录入口在首登时自动注册。
   */
  async createWithPhonePassword(data: {
    phone: string;
    passwordHash: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        phone: data.phone,
        passwordHash: data.passwordHash,
        passwordUpdatedAt: new Date(),
        nickname: this.generateDefaultNickname(),
      },
    });
  }

  /**
   * 生成默认用户昵称
   * @returns 返回形如“用户a1b2c3”的默认昵称
   * @description 用于自动注册场景，避免新账号都显示同一个“用户”或暴露手机号、账号名。
   */
  private generateDefaultNickname() {
    const randomText = Math.random()
      .toString(36)
      .slice(2, 2 + DEFAULT_NICKNAME_RANDOM_LENGTH);
    return `${DEFAULT_NICKNAME_PREFIX}${randomText}`;
  }

  /**
   * 更新用户密码
   * @param userId 用户ID
   * @param passwordHash 新密码哈希
   * @returns 返回更新后的用户记录
   * @description 为指定用户写入新的密码哈希，并刷新密码更新时间，供后续密码修改场景复用。
   */
  async updatePassword(userId: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordUpdatedAt: new Date(),
      },
    });
  }

  /**
   * 绑定微信身份到指定用户
   * @param userId 用户ID
   * @param wechatOpenId 微信OpenID
   * @param wechatUnionId 微信UnionID
   * @returns 返回更新后的用户记录
   * @description 将微信 OpenID 和可选 UnionID 写入当前用户，用于手机号账号和微信身份打通。
   */
  async bindWechatIdentity(
    userId: string,
    wechatOpenId: string,
    wechatUnionId?: string,
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        wechatOpenId,
        wechatUnionId,
      },
    });
  }

  /**
   * 更新用户资料
   * @param id 用户ID
   * @param data 用户资料更新内容
   * @returns 返回更新后的用户记录
   * @description 更新用户昵称、头像等基础资料字段。
   */
  async updateProfile(
    id: string,
    data: { nickname?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }
}

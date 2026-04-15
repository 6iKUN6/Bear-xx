import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '@prisma/client';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByOpenId(wechatOpenId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { wechatOpenId } });
  }

  async findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async findOrCreateByOpenId(
    wechatOpenId: string,
    wechatUnionId?: string,
  ): Promise<User> {
    const existing = await this.findByOpenId(wechatOpenId);
    if (existing) return existing;

    return this.prisma.user.create({
      data: { wechatOpenId, wechatUnionId },
    });
  }

  async findOrCreateByPhone(phone: string): Promise<User> {
    const existing = await this.findByPhone(phone);
    if (existing) return existing;

    return this.prisma.user.create({
      data: { phone },
    });
  }

  async updateProfile(
    id: string,
    data: { nickname?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }
}

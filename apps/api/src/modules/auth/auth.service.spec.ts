import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { scrypt as scryptCallback } from 'crypto';
import { promisify } from 'util';
import { AuthService } from './auth.service';
import { AgentAccessService } from '../agent-access/agent-access.service';

const scrypt = promisify(scryptCallback);

async function createPasswordHash(password: string): Promise<string> {
  const salt = '0123456789abcdef0123456789abcdef';
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

describe('AuthService.adminLogin', () => {
  const jwtService = {
    signAsync: jest
      .fn()
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('refresh-token'),
  };
  const configService = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        JWT_ACCESS_SECRET: 'access-secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
      };
      return values[key];
    }),
  };
  const userService = {
    findByUsername: jest.fn(),
    findByPhone: jest.fn(),
    findById: jest.fn(),
    createWithPassword: jest.fn(),
  };
  const smsService = {};
  const redis = {};

  const createService = () =>
    new AuthService(
      jwtService as never,
      configService as never,
      userService as never,
      smsService as never,
      redis as never,
      new AgentAccessService(),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    jwtService.signAsync
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('refresh-token');
  });

  it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])(
    'allows an existing %s account and returns its current role',
    async (role) => {
      userService.findByUsername.mockResolvedValue({
        id: 'admin-1',
        username: 'admin',
        passwordHash: await createPasswordHash('correct-password'),
        nickname: '管理员',
        avatarUrl: '',
        role,
      });

      await expect(
        createService().adminLogin(' ADMIN ', 'correct-password'),
      ).resolves.toMatchObject({
        token: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'admin-1',
          nickname: '管理员',
          avatarUrl: '',
          adminRole: role,
        },
      });
      expect(userService.findByUsername).toHaveBeenCalledWith('admin');
      expect(userService.createWithPassword).not.toHaveBeenCalled();
    },
  );

  it('allows an existing phone-password admin to log in with their phone', async () => {
    userService.findByPhone.mockResolvedValue({
      id: 'admin-phone-1',
      username: null,
      phone: '13800000000',
      passwordHash: await createPasswordHash('correct-password'),
      nickname: '手机管理员',
      avatarUrl: '',
      role: UserRole.ADMIN,
    });

    await expect(
      createService().adminLogin(' 13800000000 ', 'correct-password'),
    ).resolves.toMatchObject({
      user: {
        id: 'admin-phone-1',
        adminRole: UserRole.ADMIN,
      },
    });
    expect(userService.findByPhone).toHaveBeenCalledWith('13800000000');
    expect(userService.findByUsername).not.toHaveBeenCalled();
  });

  it('returns the current database role for an authenticated admin session', async () => {
    userService.findById.mockResolvedValue({
      id: 'admin-1',
      nickname: '管理员',
      avatarUrl: '',
      role: UserRole.SUPER_ADMIN,
    });

    await expect(createService().getAdminAuthUser('admin-1')).resolves.toEqual({
      id: 'admin-1',
      nickname: '管理员',
      avatarUrl: '',
      adminRole: UserRole.SUPER_ADMIN,
    });
  });

  it('rejects an admin session after its role is revoked', async () => {
    userService.findById.mockResolvedValue({
      id: 'user-1',
      nickname: '普通用户',
      avatarUrl: '',
      role: UserRole.USER,
    });

    await expect(
      createService().getAdminAuthUser('user-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['an unknown account', null, 'correct-password'],
    [
      'a normal user',
      {
        id: 'user-1',
        username: 'normal',
        passwordHash: 'unused',
        nickname: '普通用户',
        avatarUrl: '',
        role: UserRole.USER,
      },
      'correct-password',
    ],
    [
      'a wrong password',
      {
        id: 'admin-1',
        username: 'admin',
        passwordHash: 'scrypt$invalid$00',
        nickname: '管理员',
        avatarUrl: '',
        role: UserRole.ADMIN,
      },
      'wrong-password',
    ],
  ])('rejects %s without auto-registration', async (_label, user, password) => {
    userService.findByUsername.mockResolvedValue(user);

    await expect(
      createService().adminLogin('admin', password),
    ).rejects.toMatchObject<UnauthorizedException>({
      message: '后台账号或密码错误',
    });
    expect(userService.createWithPassword).not.toHaveBeenCalled();
  });
});

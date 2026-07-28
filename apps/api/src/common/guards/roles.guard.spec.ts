import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function buildContext(userId?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: userId ? { id: userId } : undefined }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

describe('RolesGuard', () => {
  const createGuard = (
    roles: string[] | undefined,
    userRole: string | null,
  ) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    } as unknown as Reflector;
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue(userRole ? { role: userRole } : null),
      },
    };
    return new RolesGuard(reflector, prisma as never);
  };

  it('passes through when no roles are required', async () => {
    const guard = createGuard(undefined, null);
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('allows a user whose role matches', async () => {
    const guard = createGuard(['ADMIN'], 'ADMIN');
    await expect(guard.canActivate(buildContext('u1'))).resolves.toBe(true);
  });

  it('rejects a user whose role does not match', async () => {
    const guard = createGuard(['ADMIN'], 'USER');
    await expect(guard.canActivate(buildContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects when the user is missing from the request', async () => {
    const guard = createGuard(['ADMIN'], 'ADMIN');
    await expect(guard.canActivate(buildContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the user no longer exists', async () => {
    const guard = createGuard(['ADMIN'], null);
    await expect(guard.canActivate(buildContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

import { PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AdminStorageController } from './admin-storage.controller';

describe('AdminStorageController', () => {
  it('挂载在 Admin 路由并同时允许两级管理员', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminStorageController)).toBe(
      'admin/storage',
    );
    expect(Reflect.getMetadata(ROLES_KEY, AdminStorageController)).toEqual([
      UserRole.ADMIN,
      UserRole.SUPER_ADMIN,
    ]);
  });

  it('分页列表委托给统一资产服务', async () => {
    const page = {
      items: [],
      page: 1,
      pageSize: 24,
      total: 0,
      totalPages: 0,
    };
    const service = {
      listAdminImages: jest.fn().mockResolvedValue(page),
    };
    const controller = new AdminStorageController(service as never);
    const query = { page: 1, pageSize: 24 };

    await expect(controller.listAssets(query)).resolves.toEqual(page);
    expect(service.listAdminImages).toHaveBeenCalledWith(query);
  });
});

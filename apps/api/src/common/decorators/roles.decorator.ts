import { SetMetadata } from '@nestjs/common';

/** @Roles 元数据 key */
export const ROLES_KEY = 'roles';

/**
 * 声明访问某端点所需的角色
 * @param roles 允许的角色列表（满足其一即可）
 * @description 与 RolesGuard 搭配使用；未标注则不做角色校验。
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

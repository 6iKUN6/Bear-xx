import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { StorageController } from './storage.controller';

describe('StorageController', () => {
  /**
   * 创建存储控制器测试依赖
   * @returns 返回七牛、COS 与资产服务 mock，以及测试控制器实例
   * @description 通过独立 mock 验证两条上传凭证路由不会互相调用对方的存储服务。
   */
  const createController = () => {
    const qiniuStorageService = {
      createUploadCredential: jest.fn(),
    };
    const cosStorageService = {
      createUploadCredential: jest.fn(),
    };
    const storageAssetService = {};
    const controller = new StorageController(
      qiniuStorageService as never,
      storageAssetService as never,
      cosStorageService as never,
    );

    return {
      controller,
      qiniuStorageService,
      cosStorageService,
    };
  };

  it('COS 凭证路由仅向 COS 服务签发单对象 PUT 凭证', async () => {
    const { controller, cosStorageService, qiniuStorageService } =
      createController();
    const credential = {
      key: 'image/202608/user-1/0123456789abcdef0123456789abcdef.png',
      uploadUrl: 'https://example.cos.ap-guangzhou.myqcloud.com/object',
      accessUrl: 'https://cdn.example.com/object',
      headers: { 'Content-Type': 'image/png' },
      expiresAt: 1_786_000_000_000,
    };
    cosStorageService.createUploadCredential.mockResolvedValue(credential);

    // Nest 将路由元数据附着在原始函数上，测试通过属性描述符读取而不解绑定实例方法。
    const handler = Object.getOwnPropertyDescriptor(
      StorageController.prototype,
      'createCosUploadCredential',
    )?.value as object;

    expect(handler).toEqual(expect.any(Function));
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'cos/upload-credential',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );

    await expect(
      controller.createCosUploadCredential('user-1', {
        type: 'image',
        ext: 'png',
      }),
    ).resolves.toEqual(credential);
    expect(cosStorageService.createUploadCredential).toHaveBeenCalledWith(
      'user-1',
      'image',
      'png',
    );
    expect(qiniuStorageService.createUploadCredential).not.toHaveBeenCalled();
  });

  it('既有七牛凭证路由仍仅调用七牛服务', () => {
    const { controller, cosStorageService, qiniuStorageService } =
      createController();
    const credential = {
      token: 'qiniu-token',
      key: 'audio/202608/user-1/0123456789abcdef0123456789abcdef.mp3',
      uploadUrl: 'https://up-z2.qiniup.com',
      accessUrl: 'https://cdn.example.com/object',
      expiresAt: 1_786_000_000_000,
    };
    qiniuStorageService.createUploadCredential.mockReturnValue(credential);

    expect(
      controller.createUploadCredential('user-1', {
        type: 'audio',
        ext: 'mp3',
        usage: 'voice-input',
      }),
    ).toEqual(credential);
    expect(qiniuStorageService.createUploadCredential).toHaveBeenCalledWith(
      'user-1',
      'audio',
      'mp3',
      'voice-input',
    );
    expect(cosStorageService.createUploadCredential).not.toHaveBeenCalled();
  });
});

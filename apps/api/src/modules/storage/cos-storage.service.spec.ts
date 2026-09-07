import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CosStorageService } from './cos-storage.service';

interface CosGetObjectUrlParams {
  Key: string;
}

type CosGetObjectUrlCallback = (
  error: Error | null,
  data: { Url: string },
) => void;

type CosGetObjectUrl = (
  params: CosGetObjectUrlParams,
  callback: CosGetObjectUrlCallback,
) => void;

const mockGetObjectUrl = jest.fn<CosGetObjectUrl>();
const mockHeadObject = jest.fn();
const mockGetObject = jest.fn();

// 不能加 { virtual: true }：cos-nodejs-sdk-v5 是真实依赖，虚拟 mock 按模块名注册而非解析路径；
// 同一 worker 内若有别的 spec 先解析过该模块，mock 会失效，本 spec 会打到真实 COS SDK 并签出真签名。
jest.mock('cos-nodejs-sdk-v5', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getObjectUrl: mockGetObjectUrl,
    headObject: mockHeadObject,
    getObject: mockGetObject,
  })),
}));

describe('CosStorageService', () => {
  /**
   * 创建 COS 存储服务测试实例
   * @param overrides 要覆盖的 COS 环境配置
   * @returns 返回使用内存配置表创建的 COS 存储服务
   * @description 通过 ConfigService 的最小替身隔离环境变量，避免测试访问真实云端或凭据。
   */
  const createService = (
    overrides: Record<string, string | undefined> = {},
  ) => {
    const config: Record<string, string | undefined> = {
      COS_SECRET_ID: 'test-secret-id',
      COS_SECRET_KEY: 'test-secret-key',
      COS_BUCKET: 'litter-bear-1250000000',
      COS_REGION: 'ap-guangzhou',
      COS_BUCKET_DOMAIN: 'https://cdn.example.com/',
      ...overrides,
    };
    const configService = {
      get: (key: string) => config[key],
    };
    return new CosStorageService(configService as unknown as ConfigService);
  };

  beforeEach(() => {
    mockGetObjectUrl.mockReset();
    mockHeadObject.mockReset();
    mockGetObject.mockReset();
  });

  it('从 COS HEAD 读取真实对象大小与 MIME', async () => {
    mockHeadObject.mockResolvedValue({
      headers: {
        'content-length': '2048',
        'content-type': 'image/webp; charset=binary',
      },
    });
    const service = createService();

    await expect(
      service.getObjectMetadata('image/path/a.webp'),
    ).resolves.toEqual({
      contentLength: 2048,
      contentType: 'image/webp',
    });
  });

  it('下载图片时使用 maxBytes Range 并拒绝超限响应体', async () => {
    mockHeadObject.mockResolvedValue({
      headers: {
        'content-length': '4',
        'content-type': 'image/png',
      },
    });
    mockGetObject.mockResolvedValue({ Body: Buffer.alloc(5) });
    const service = createService();

    await expect(service.downloadObject('image/path/a.png', 4)).rejects.toThrow(
      '不能超过 4 字节',
    );
    expect(mockGetObject).toHaveBeenCalledWith(
      expect.objectContaining({ Range: 'bytes=0-4' }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('为图片对象签发固定 key 的 HTTPS PUT URL 与确定的 Content-Type', async () => {
    mockGetObjectUrl.mockImplementation(
      (params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: `https://litter-bear-1250000000.cos.ap-guangzhou.myqcloud.com/${params.Key}?signature=test`,
        });
      },
    );
    const service = createService();

    const credential = await service.createUploadCredential(
      'user-1',
      'image',
      'PNG',
    );

    expect(credential.key).toMatch(/^image\/\d{6}\/user-1\/[0-9a-f]{32}\.png$/);
    expect(mockGetObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'litter-bear-1250000000',
        Region: 'ap-guangzhou',
        Key: credential.key,
        Method: 'PUT',
        Sign: true,
        Expires: 600,
        Protocol: 'https:',
        Headers: { 'Content-Type': 'image/png' },
      }),
      expect.any(Function),
    );
    expect(credential.uploadUrl).toBe(
      `https://litter-bear-1250000000.cos.ap-guangzhou.myqcloud.com/${credential.key}?signature=test`,
    );
    expect(credential.accessUrl).toBe(
      `https://cdn.example.com/${credential.key}`,
    );
    expect(credential.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
  });

  it('COS SDK 回调错误时拒绝签发上传凭证', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(new Error('签名服务不可用'), { Url: '' });
      },
    );
    const service = createService();

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('腾讯云 COS 上传凭证签发失败');
  });

  it('COS SDK 返回非 HTTPS URL 时拒绝签发上传凭证', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, { Url: 'http://upload.example.com/key?signature=test' });
      },
    );
    const service = createService();

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('腾讯云 COS 未返回 HTTPS 上传地址');
  });

  it.each([
    ['image', 'mp3'],
    ['audio', 'png'],
    ['image', 'exe'],
  ] as const)(
    '%s 类型不支持 .%s 扩展名时拒绝签发上传凭证',
    async (type, ext) => {
      mockGetObjectUrl.mockImplementation(
        (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
          callback(null, {
            Url: 'https://upload.example.com/key?signature=test',
          });
        },
      );
      const service = createService();

      await expect(
        service.createUploadCredential('user-1', type, ext),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createUploadCredential('user-1', type, ext),
      ).rejects.toThrow('不支持的媒体扩展名');
      expect(mockGetObjectUrl).not.toHaveBeenCalled();
    },
  );

  it.each([
    'COS_SECRET_ID',
    'COS_SECRET_KEY',
    'COS_BUCKET',
    'COS_REGION',
    'COS_BUCKET_DOMAIN',
  ])('缺少 %s 时只在签发 COS 凭证时抛出明确的 503', async (key) => {
    const service = createService({ [key]: undefined });

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('COS 对象存储未配置');
  });

  it.each([
    ['COS_BUCKET', 'litter-bear'],
    ['COS_REGION', 'na-toronto'],
  ])('%s 格式非法时拒绝签发 COS 上传 URL', async (key, value) => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/key?signature=test',
        });
      },
    );
    const service = createService({ [key]: value });

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('COS 对象存储配置无效');
    expect(mockGetObjectUrl).not.toHaveBeenCalled();
  });

  it('将无协议的 COS 访问域名规范化为 HTTPS 基址', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/key?signature=test',
        });
      },
    );
    const service = createService({
      COS_BUCKET_DOMAIN: 'cdn.example.com////',
    });

    const credential = await service.createUploadCredential(
      'user-1',
      'audio',
      'mp3',
    );

    expect(credential.accessUrl).toBe(
      `https://cdn.example.com/${credential.key}`,
    );
    expect(credential.headers).toEqual({ 'Content-Type': 'audio/mpeg' });
  });

  it('使用公有读域名生成访问 URL，并对 key 中的特殊字符逐段编码', () => {
    const service = createService();

    expect(service.resolveAccessUrl('image/202609/user-1/a b#c.png')).toBe(
      'https://cdn.example.com/image/202609/user-1/a%20b%23c.png',
    );
  });

  it.each(['', '../secret.png', '/absolute.png', 'https://evil.example/a.png'])(
    '对象 key %p 不安全时拒绝生成访问 URL',
    (key) => {
      const service = createService();

      expect(() => service.resolveAccessUrl(key)).toThrow(BadRequestException);
    },
  );

  it('服务端二进制通过预签名 PUT 上传成功后返回对象 key', async () => {
    mockGetObjectUrl.mockImplementation(
      (params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: `https://upload.example.com/${params.Key}?signature=test`,
        });
      },
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const service = createService();
    const data = Buffer.from('image-data');

    const key = await service.uploadBuffer({
      data,
      ownerId: 'user-1',
      type: 'image',
      ext: 'png',
    });

    expect(key).toMatch(/^image\/\d{6}\/user-1\/[0-9a-f]{32}\.png$/);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/${key}?signature=test`),
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
      }),
    );
  });

  it('服务端二进制上传失败时抛出 COS 响应状态与摘要', async () => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/object?signature=test',
        });
      },
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('AccessDenied', { status: 403 }));
    const service = createService();

    await expect(
      service.uploadBuffer({
        data: Buffer.from('image-data'),
        ownerId: 'user-1',
        type: 'image',
        ext: 'png',
      }),
    ).rejects.toThrow('腾讯云 COS 服务端上传失败(403)：AccessDenied');
  });

  it.each([
    ['路径', 'https://cdn.example.com/media'],
    ['查询参数', 'https://cdn.example.com?version=1'],
    ['用户信息', 'https://user:password@cdn.example.com'],
  ])('COS_BUCKET_DOMAIN 含%s时拒绝签发上传凭证', async (_kind, domain) => {
    mockGetObjectUrl.mockImplementation(
      (_params: CosGetObjectUrlParams, callback: CosGetObjectUrlCallback) => {
        callback(null, {
          Url: 'https://upload.example.com/key?signature=test',
        });
      },
    );
    const service = createService({ COS_BUCKET_DOMAIN: domain });

    await expect(
      service.createUploadCredential('user-1', 'image', 'png'),
    ).rejects.toThrow('COS 对象存储配置无效');
    expect(mockGetObjectUrl).not.toHaveBeenCalled();
  });
});

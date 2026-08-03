import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { QiniuStorageService } from './qiniu-storage.service';

describe('QiniuStorageService', () => {
  /**
   * 创建存储服务测试实例
   * @returns 返回服务实例与可覆盖的配置表
   * @description 用内存配置表替代 ConfigService，验证签名结构与配置缺失兜底。
   */
  const createService = (
    overrides: Record<string, string | undefined> = {},
  ) => {
    const config: Record<string, string | undefined> = {
      QINIU_ACCESS_KEY: 'test-ak',
      QINIU_SECRET_KEY: 'test-sk',
      QINIU_BUCKET: 'litter-bear',
      QINIU_BUCKET_DOMAIN: 'https://cdn.example.com/',
      QINIU_REGION: 'z2',
      ...overrides,
    };
    const configService = {
      get: (key: string, fallback?: string) => config[key] ?? fallback,
    };
    return new QiniuStorageService(configService as unknown as ConfigService);
  };

  it('签发的直传凭证包含 AK:sign:policy 结构且 policy 字段正确', () => {
    const service = createService();
    const credential = service.createUploadCredential('user-1', 'image', 'PNG');

    const [ak, sign, encodedPolicy] = credential.token.split(':');
    expect(ak).toBe('test-ak');
    expect(sign).toBeTruthy();

    const policy = JSON.parse(
      Buffer.from(
        encodedPolicy.replaceAll('-', '+').replaceAll('_', '/'),
        'base64',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    expect(policy.scope).toBe(`litter-bear:${credential.key}`);
    expect(policy.insertOnly).toBe(1);
    expect(policy.mimeLimit).toBe('image/*');

    expect(credential.key).toMatch(/^image\/\d{6}\/user-1\/[0-9a-f]{32}\.png$/);
    expect(credential.uploadUrl).toBe('https://up-z2.qiniup.com');
    expect(credential.accessUrl).toBe(
      `https://cdn.example.com/${credential.key}`,
    );
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
  });

  it('agent-avatar 用途把大小硬限制收紧到 2MB', () => {
    const service = createService();
    const credential = service.createUploadCredential(
      'user-1',
      'image',
      'png',
      'agent-avatar',
    );
    const encodedPolicy = credential.token.split(':')[2];
    const policy = JSON.parse(
      Buffer.from(
        encodedPolicy.replaceAll('-', '+').replaceAll('_', '/'),
        'base64',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    expect(policy.fsizeLimit).toBe(2 * 1024 * 1024);
  });

  it('音频类型使用 audio 目录与 audio/* MIME 限制', () => {
    const service = createService();
    const credential = service.createUploadCredential('user-1', 'audio', 'mp3');
    expect(credential.key.startsWith('audio/')).toBe(true);
    expect(credential.token).toContain(':');
  });

  it('私有空间访问 URL 附带 e/token 签名参数', () => {
    const service = createService({ QINIU_BUCKET_PRIVATE: 'true' });
    const url = service.resolveAccessUrl('audio/202608/u1/abc.mp3');
    expect(url).toMatch(
      /^https:\/\/cdn\.example\.com\/audio\/202608\/u1\/abc\.mp3\?e=\d+&token=test-ak:.+$/,
    );
  });

  it('域名缺少协议头时自动补 http://，不产生相对路径 URL', () => {
    const service = createService({
      QINIU_BUCKET_DOMAIN: 'tj6l5fk2g.hn-bkt.clouddn.com/',
    });
    const url = service.resolveAccessUrl('image/202608/u1/abc.jpg');
    expect(url).toBe(
      'http://tj6l5fk2g.hn-bkt.clouddn.com/image/202608/u1/abc.jpg',
    );
  });

  it('配置缺失时抛出可操作的 503 而非静默失败', () => {
    const service = createService({ QINIU_ACCESS_KEY: undefined });
    expect(() =>
      service.createUploadCredential('user-1', 'image', 'png'),
    ).toThrow(ServiceUnavailableException);
  });

  it('非法 key（路径穿越）被拒绝', () => {
    const service = createService();
    expect(() => service.resolveAccessUrl('../etc/passwd')).toThrow(
      '非法的对象 key',
    );
  });
});

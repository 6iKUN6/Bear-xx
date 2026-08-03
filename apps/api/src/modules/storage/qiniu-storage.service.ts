import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import type {
  StorageUsage,
  UploadMediaType,
} from './dto/upload-credential.dto';

/** 直传凭证有效期（秒）：够客户端完成一次上传即可 */
const UPLOAD_TOKEN_TTL_SECONDS = 600;
/** 私有空间下载签名有效期（秒） */
const DOWNLOAD_URL_TTL_SECONDS = 3600;

/** 各媒体类型的上传约束：目录前缀 / 大小上限 / MIME 白名单 */
const MEDIA_RULES: Record<
  UploadMediaType,
  { prefix: string; fsizeLimit: number; mimeLimit: string }
> = {
  image: {
    prefix: 'image',
    fsizeLimit: 10 * 1024 * 1024,
    mimeLimit: 'image/*',
  },
  audio: {
    prefix: 'audio',
    fsizeLimit: 20 * 1024 * 1024,
    mimeLimit: 'audio/*',
  },
};

/** 按业务用途收紧的大小上限（字节）；未列出的用途沿用媒体类型默认值 */
const USAGE_SIZE_LIMITS: Partial<Record<StorageUsage, number>> = {
  'agent-avatar': 2 * 1024 * 1024,
};

/** 存储区域 → 直传入口（https://developer.qiniu.com/kodo/1671/region-endpoint-fq） */
const REGION_UPLOAD_HOSTS: Record<string, string> = {
  z0: 'https://up.qiniup.com',
  z1: 'https://up-z1.qiniup.com',
  z2: 'https://up-z2.qiniup.com',
  na0: 'https://up-na0.qiniup.com',
  as0: 'https://up-as0.qiniup.com',
};

export interface UploadCredential {
  token: string;
  key: string;
  uploadUrl: string;
  accessUrl: string;
  expiresAt: number;
}

/**
 * 七牛云 Kodo 对象存储
 * @description 只做两件事：签发客户端直传凭证、生成访问 URL（私有空间带签名）。
 * 文件本体不经过 api 服务器（预签名直传），业务表只落 object key。
 * 签名算法为七牛公开规范（HMAC-SHA1 + urlsafe base64），用 Node 原生 crypto
 * 实现，不引 SDK 依赖。密钥仅来自 env，不落库。
 */
@Injectable()
export class QiniuStorageService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 签发直传凭证
   * @param userId 上传者（进入 key 路径，便于溯源与配额治理）
   * @param type 媒体类型（决定目录/大小/MIME 约束）
   * @param ext 文件扩展名（已由 DTO 校验为字母数字）
   * @returns 返回 token/key/直传入口/访问 URL/过期时间
   * @description key 形如 image/202608/{userId}/{uuid}.png；putPolicy 限定
   * scope 到具体 key 且 insertOnly，凭证泄漏也无法覆盖既有对象。
   */
  createUploadCredential(
    userId: string,
    type: UploadMediaType,
    ext: string,
    usage?: StorageUsage,
  ): UploadCredential {
    const { accessKey, secretKey, bucket } = this.requireConfig();
    const rule = MEDIA_RULES[type];
    const key = this.buildObjectKey(rule.prefix, userId, ext);
    const deadline = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
    // 用途级上限优先（如头像 2MB），putPolicy 服务端硬限制，前端校验只是体验
    const fsizeLimit = (usage && USAGE_SIZE_LIMITS[usage]) || rule.fsizeLimit;

    const putPolicy = JSON.stringify({
      scope: `${bucket}:${key}`,
      deadline,
      insertOnly: 1,
      fsizeLimit,
      mimeLimit: rule.mimeLimit,
    });
    const encodedPolicy = this.urlsafeBase64(Buffer.from(putPolicy, 'utf8'));
    const sign = this.hmacSha1(encodedPolicy, secretKey);
    const token = `${accessKey}:${sign}:${encodedPolicy}`;

    return {
      token,
      key,
      uploadUrl: this.resolveUploadHost(),
      accessUrl: this.resolveAccessUrl(key),
      expiresAt: deadline * 1000,
    };
  }

  /**
   * 生成对象访问 URL
   * @param key 对象 key
   * @param ttlSeconds 私有空间签名有效期（公开空间忽略）
   * @returns 返回可直接访问的 URL；私有空间附带 e/token 签名参数
   */
  resolveAccessUrl(key: string, ttlSeconds = DOWNLOAD_URL_TTL_SECONDS): string {
    const { accessKey, secretKey, domain, isPrivate } = this.requireConfig();
    this.assertSafeKey(key);
    const baseUrl = `${domain}/${encodeURI(key)}`;

    if (!isPrivate) {
      return baseUrl;
    }

    const deadline = Math.floor(Date.now() / 1000) + ttlSeconds;
    const urlToSign = `${baseUrl}?e=${deadline}`;
    const sign = this.hmacSha1(urlToSign, secretKey);
    return `${urlToSign}&token=${accessKey}:${sign}`;
  }

  /** 对象 key：{type}/{yyyyMM}/{userId}/{uuid}.{ext}（按月分目录，方便生命周期治理） */
  private buildObjectKey(prefix: string, userId: string, ext: string): string {
    const now = new Date();
    const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const id = randomUUID().replaceAll('-', '');
    return `${prefix}/${month}/${userId}/${id}.${ext.toLowerCase()}`;
  }

  private resolveUploadHost(): string {
    const region = this.configService.get<string>('QINIU_REGION', 'z0');
    const host = REGION_UPLOAD_HOSTS[region];
    if (!host) {
      throw new ServiceUnavailableException(
        `不支持的七牛存储区域：${region}（可选 ${Object.keys(REGION_UPLOAD_HOSTS).join('/')}）`,
      );
    }
    return host;
  }

  /** 读取并校验配置；缺失时给出可操作的报错而不是启动期崩溃 */
  private requireConfig() {
    const accessKey = this.configService.get<string>('QINIU_ACCESS_KEY');
    const secretKey = this.configService.get<string>('QINIU_SECRET_KEY');
    const bucket = this.configService.get<string>('QINIU_BUCKET');
    const rawDomain = this.configService.get<string>('QINIU_BUCKET_DOMAIN');

    if (!accessKey || !secretKey || !bucket || !rawDomain) {
      throw new ServiceUnavailableException(
        '对象存储未配置：请在 env 中填写 QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET / QINIU_BUCKET_DOMAIN',
      );
    }

    return {
      accessKey,
      secretKey,
      bucket,
      domain: this.normalizeDomain(rawDomain),
      isPrivate:
        this.configService.get<string>('QINIU_BUCKET_PRIVATE') === 'true',
    };
  }

  /**
   * 归一化访问域名
   * @description env 里少写协议头时自动补 http://（七牛测试域名仅支持 HTTP）。
   * 无协议的裸域名拼进 <img src> 会被浏览器当相对路径解析，产生
   * localhost/页面路由 前缀的坏 URL。正式 CDN 域名建议显式写 https://。
   */
  private normalizeDomain(rawDomain: string): string {
    const trimmed = rawDomain.trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  /** 防路径注入：key 不允许出现相对路径与协议片段 */
  private assertSafeKey(key: string) {
    if (
      !key ||
      key.includes('..') ||
      key.includes('://') ||
      key.startsWith('/')
    ) {
      throw new BadRequestException('非法的对象 key');
    }
  }

  private hmacSha1(data: string, secretKey: string): string {
    return this.urlsafeBase64(
      createHmac('sha1', secretKey).update(data, 'utf8').digest(),
    );
  }

  /** 七牛 urlsafe base64：标准 base64 后替换 + / 为 - _ */
  private urlsafeBase64(input: Buffer): string {
    return input.toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  }
}

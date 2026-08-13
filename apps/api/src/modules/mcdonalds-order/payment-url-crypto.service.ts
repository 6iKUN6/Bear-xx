import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const INITIALIZATION_VECTOR_LENGTH = 12;

/**
 * 官方支付链接加密服务
 * @description 仅对数据库中的短期支付 URL 做 AEAD 加密；调用方不得把明文传入日志、SSE、模型或普通 DTO。
 */
@Injectable()
export class PaymentUrlCryptoService {
  private encryptionKey?: Buffer;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 校验支付链接加密密钥是否可用
   * @returns 无返回值
   * @description 仅在麦当劳 MCP 已完整启用时由能力注册阶段调用，避免未配置的可选集成阻断整个 API 启动。
   */
  assertConfigured(): void {
    this.getEncryptionKey();
  }

  /**
   * 加密官方支付链接
   * @param url 麦当劳返回的 HTTP(S) 支付链接
   * @returns 返回可安全持久化的版本化 AES-GCM 密文
   * @description 密文格式为 `v1.iv.tag.ciphertext`，每段均为 base64url；每次调用使用新的随机 IV。
   */
  encrypt(url: string): string {
    this.assertHttpUrl(url);
    const iv = randomBytes(INITIALIZATION_VECTOR_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(url, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      FORMAT_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * 解密官方支付链接
   * @param ciphertext 数据库中的版本化 AES-GCM 密文
   * @returns 返回仅供当前请求使用的官方支付链接明文
   * @description 密文格式、认证标签或 URL 校验失败时统一抛业务异常，不泄露原始加密错误与任何部分明文。
   */
  decrypt(ciphertext: string): string {
    try {
      const [version, ivText, tagText, encryptedText, ...extra] =
        ciphertext.split('.');
      if (
        version !== FORMAT_VERSION ||
        extra.length > 0 ||
        !ivText ||
        !tagText ||
        !encryptedText
      ) {
        throw new Error('invalid format');
      }

      const iv = Buffer.from(ivText, 'base64url');
      const tag = Buffer.from(tagText, 'base64url');
      const encrypted = Buffer.from(encryptedText, 'base64url');
      if (iv.length !== INITIALIZATION_VECTOR_LENGTH || tag.length !== 16) {
        throw new Error('invalid encryption parts');
      }

      const decipher = createDecipheriv(ALGORITHM, this.getEncryptionKey(), iv);
      decipher.setAuthTag(tag);
      const url = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf8');
      this.assertHttpUrl(url);
      return url;
    } catch {
      throw new BadRequestException('支付链接无效或已损坏');
    }
  }

  /**
   * 校验支付链接是否仍在有效期内
   * @param expiresAt 支付链接的到期时间
   * @returns 无返回值
   * @description 到期时间等于或早于当前时间时拒绝继续获取链接或生成二维码。
   */
  assertNotExpired(expiresAt: Date): void {
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        '支付链接已过期，请刷新订单状态或在官方渠道继续支付',
      );
    }
  }

  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const configured = this.configService
      .get<string>('MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY')
      ?.trim();
    if (!configured || !/^[A-Za-z0-9+/]+={0,2}$/.test(configured)) {
      throw new Error(
        'MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥',
      );
    }

    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32 || key.toString('base64') !== configured) {
      throw new Error(
        'MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥',
      );
    }
    this.encryptionKey = key;
    return key;
  }

  private assertHttpUrl(value: string): void {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new BadRequestException('官方支付链接格式无效');
    }
  }
}

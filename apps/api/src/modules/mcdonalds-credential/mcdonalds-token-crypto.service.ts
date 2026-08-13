import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** 麦当劳 MCP Token 的静态加密服务。 */
@Injectable()
export class McDonaldsTokenCryptoService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 加密用户绑定的麦当劳 MCP Token
   * @param token 待加密的 MCP Token 明文
   * @returns 返回版本化 AES-256-GCM 密文
   * @description Token 仅在绑定、校验和 MCP 请求期间以明文存在；落库时必须使用独立于支付链接的密钥加密。
   */
  encrypt(token: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const ciphertext = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * 解密已保存的麦当劳 MCP Token
   * @param ciphertext 已保存的版本化密文
   * @returns 返回仅供当前 MCP 请求使用的 Token 明文
   * @description 密文格式或认证标签无效时直接拒绝，避免使用损坏凭据访问外部账号。
   */
  decrypt(ciphertext: string): string {
    const [version, ivText, authTagText, encryptedText, ...rest] =
      ciphertext.split('.');
    if (
      version !== VERSION ||
      !ivText ||
      !authTagText ||
      !encryptedText ||
      rest.length > 0
    ) {
      throw new BadRequestException('麦当劳账号凭据已损坏，请重新绑定');
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.requireKey(),
        Buffer.from(ivText, 'base64url'),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException('麦当劳账号凭据已损坏，请重新绑定');
    }
  }

  /**
   * 生成 Token 不可逆指纹
   * @param token MCP Token 明文
   * @returns 返回 SHA-256 十六进制摘要
   * @description 指纹仅用于同一用户重复绑定的幂等判断和脱敏展示，不能用于恢复 Token。
   */
  fingerprint(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * 返回可安全展示的 Token 标识
   * @param fingerprint Token SHA-256 指纹
   * @returns 返回取自指纹尾部的脱敏标识
   * @description 前端不回显 Token 原文，仅用不可逆指纹尾部辅助用户识别当前绑定记录。
   */
  toDisplayHint(fingerprint: string): string {
    return `Token ...${fingerprint.slice(-6)}`;
  }

  /**
   * 校验并读取 Token 加密主密钥
   * @returns 返回长度为 32 字节的 AES 密钥
   * @description 该密钥独立于支付 URL 加密密钥；未配置或格式不正确时拒绝所有绑定与点餐操作。
   */
  private requireKey(): Buffer {
    const encoded = this.configService
      .get<string>('MCDONALDS_CREDENTIAL_ENCRYPTION_KEY')
      ?.trim();
    if (!encoded) {
      throw new Error(
        'MCDONALDS_CREDENTIAL_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥',
      );
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) {
      throw new Error(
        'MCDONALDS_CREDENTIAL_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥',
      );
    }
    return key;
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { McpClientManager } from '../ai/mcp/mcp-client-manager.service';
import { McDonaldsTokenCryptoService } from './mcdonalds-token-crypto.service';
import type { McDonaldsCredentialResponseDto } from './dto/mcdonalds-credential-response.dto';

/** 仅供 MCP 管理器和能力解析链路使用的解密凭据。 */
export interface McDonaldsCredentialAccess {
  credentialId: string;
  token: string;
}

interface CredentialRecord {
  id: string;
  status: 'ACTIVE' | 'INVALID' | 'REVOKED';
  tokenCiphertext: string;
  tokenFingerprint: string;
  verifiedAt: Date | null;
  updatedAt: Date;
}

/** 用户级麦当劳 MCP 凭据服务。 */
@Injectable()
export class McDonaldsCredentialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCryptoService: McDonaldsTokenCryptoService,
    private readonly mcpClientManager: McpClientManager,
  ) {}

  /**
   * 读取当前用户的活跃麦当劳凭据状态
   * @param userId 当前认证用户ID
   * @returns 返回活跃凭据的安全摘要；未绑定时返回 null
   * @description 只返回一条活跃凭据，绝不把密文、指纹全文或 Token 原文输出到 REST 响应。
   */
  async getActive(
    userId: string,
  ): Promise<McDonaldsCredentialResponseDto | null> {
    const credential = await this.prisma.mcDonaldsCredential.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      select: credentialSelect,
    });
    return credential ? this.toResponse(credential) : null;
  }

  /**
   * 获取当前用户活跃凭据ID
   * @param userId 当前认证用户ID
   * @returns 返回活跃凭据 ID；未绑定时返回 undefined
   * @description 聊天任务创建时捕获该 ID，以便 HITL 恢复时仍使用本轮起始的麦当劳账号。
   */
  async getActiveCredentialId(userId: string): Promise<string | undefined> {
    const credential = await this.prisma.mcDonaldsCredential.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    return credential?.id;
  }

  /**
   * 验证并绑定一个新的麦当劳 MCP Token
   * @param userId 当前认证用户ID
   * @param rawToken 用户本次请求提交的 Token
   * @returns 返回新活跃凭据的安全摘要
   * @description 先以 tools/list 验证 Token 和审核工具清单，再原子撤销旧活跃凭据并创建新记录；Token 不写日志、不进入 trace。
   */
  async bind(
    userId: string,
    rawToken: string,
  ): Promise<McDonaldsCredentialResponseDto> {
    const token = rawToken.trim();
    if (!token) {
      throw new BadRequestException('请填写麦当劳 MCP Token');
    }

    const verificationStartedAt = Date.now();
    try {
      await this.mcpClientManager.verifyMcDonaldsToken(token);
    } catch {
      await this.recordBindVerificationAudit({
        userId,
        status: 'ERROR',
        durationMs: Date.now() - verificationStartedAt,
        errorMessage: '认证或工具清单校验失败',
      });
      throw new BadRequestException(
        '麦当劳 MCP Token 无效或暂时无法验证，请确认后重试',
      );
    }

    const encryptedToken = this.tokenCryptoService.encrypt(token);
    const fingerprint = this.tokenCryptoService.fingerprint(token);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.mcDonaldsCredential.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      await tx.mcDonaldsCredential.updateMany({
        where: { userId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now },
      });
      const created = await tx.mcDonaldsCredential.create({
        data: {
          userId,
          tokenCiphertext: encryptedToken,
          tokenFingerprint: fingerprint,
          status: 'ACTIVE',
          verifiedAt: now,
        },
        select: credentialSelect,
      });
      return { created, previousCredentialId: current?.id };
    });

    await this.recordBindVerificationAudit({
      userId,
      credentialId: result.created.id,
      status: 'SUCCESS',
      durationMs: Date.now() - verificationStartedAt,
      errorMessage: null,
    });

    if (result.previousCredentialId) {
      await this.mcpClientManager.evictCredentialClients([
        result.previousCredentialId,
      ]);
    }
    return this.toResponse(result.created);
  }

  /**
   * 撤销当前用户的活跃麦当劳凭据
   * @param userId 当前认证用户ID
   * @returns 无返回值
   * @description 历史订单保留其凭据外键和只读展示；撤销后不允许用该凭据继续下单、刷新或读取支付链接。
   */
  async unbind(userId: string): Promise<void> {
    const credential = await this.prisma.mcDonaldsCredential.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!credential) {
      return;
    }
    await this.prisma.mcDonaldsCredential.update({
      where: { id: credential.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await this.mcpClientManager.evictCredentialClients([credential.id]);
  }

  /**
   * 读取指定活跃凭据的解密访问材料
   * @param userId 当前认证用户ID
   * @param credentialId 首轮任务或订单锁定的凭据ID
   * @returns 返回仅限服务端 MCP 调用使用的凭据 ID 和 Token
   * @description 始终校验用户归属和 ACTIVE 状态；已解绑或失效的历史凭据不能因订单记录存在而被重新激活。
   */
  async requireActiveAccess(
    userId: string,
    credentialId: string | undefined,
  ): Promise<McDonaldsCredentialAccess> {
    if (!credentialId) {
      throw new ForbiddenException(
        '该历史订单未关联麦当劳凭据，仅支持只读查看',
      );
    }
    const credential = await this.prisma.mcDonaldsCredential.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        id: credentialId,
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tokenCiphertext: true },
    });
    if (!credential) {
      throw new ForbiddenException('请先绑定有效的麦当劳 MCP Token');
    }
    return {
      credentialId: credential.id,
      token: this.tokenCryptoService.decrypt(credential.tokenCiphertext),
    };
  }

  /**
   * 将凭据标记为失效
   * @param credentialId 需要标记的凭据ID
   * @param reason 不含 Token 的失败摘要
   * @returns 无返回值
   * @description 供已确认的认证失败使用；网络故障不应调用本方法，避免把临时不可用误判成 Token 失效。
   */
  async markInvalid(credentialId: string, reason: string): Promise<void> {
    await this.prisma.mcDonaldsCredential.updateMany({
      where: { id: credentialId, status: 'ACTIVE' },
      data: { status: 'INVALID', lastError: reason.slice(0, 500) },
    });
    await this.mcpClientManager.evictCredentialClients([credentialId]);
  }

  /**
   * 记录绑定前 MCP 连通性校验的安全审计
   * @param input 审计归属、执行结果、耗时与安全错误摘要
   * @returns 无返回值
   * @description 此调用没有会话任务上下文，不能写入 conversation trace；只记录 tools/list 的结果元数据，绝不记录 Token、密文或远端响应体。审计写入失败不影响用户的绑定结果。
   */
  private async recordBindVerificationAudit(input: {
    userId: string;
    credentialId?: string;
    status: 'SUCCESS' | 'ERROR';
    durationMs: number;
    errorMessage: string | null;
  }): Promise<void> {
    try {
      await this.prisma.mcpConnectionAudit.create({
        data: {
          userId: input.userId,
          credentialId: input.credentialId ?? null,
          mcpServer: 'mcdonalds',
          operation: 'CREDENTIAL_BIND_VERIFICATION',
          mcpTool: 'tools/list',
          status: input.status,
          durationMs: Math.max(0, input.durationMs),
          errorMessage: input.errorMessage,
        },
      });
    } catch {
      // 审计不可阻塞授权流程，且错误可能包含底层数据库细节，不应写回用户响应或日志。
    }
  }

  /**
   * 转换为安全凭据 DTO
   * @param credential 已查询的凭据安全字段
   * @returns 返回不含 Token 和密文的响应对象
   * @description 指纹仅用于本地生成脱敏提示，完整指纹不会传给客户端。
   */
  private toResponse(
    credential: CredentialRecord,
  ): McDonaldsCredentialResponseDto {
    return {
      id: credential.id,
      status: credential.status,
      hint: this.tokenCryptoService.toDisplayHint(credential.tokenFingerprint),
      verifiedAt: credential.verifiedAt?.toISOString() ?? null,
      updatedAt: credential.updatedAt.toISOString(),
    };
  }
}

const credentialSelect = {
  id: true,
  status: true,
  tokenCiphertext: true,
  tokenFingerprint: true,
  verifiedAt: true,
  updatedAt: true,
} as const;

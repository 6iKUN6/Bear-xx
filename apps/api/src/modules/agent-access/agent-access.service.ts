import { Injectable } from '@nestjs/common';
import { MembershipTier } from '@prisma/client';

/** 智能体不可使用的稳定原因；客户端按该闭集展示，不解析中文错误。 */
export enum AgentAccessDenialReason {
  Disabled = 'DISABLED',
  MembershipExpired = 'MEMBERSHIP_EXPIRED',
  MembershipRequired = 'MEMBERSHIP_REQUIRED',
}

/** 资格判断所需的最小用户会员事实。 */
export interface MembershipAccessSubject {
  membershipTier: MembershipTier;
  membershipExpiresAt: Date | null;
}

/** 资格判断所需的最小智能体开放事实。 */
export interface AgentAccessPolicy {
  enabled: boolean;
  minimumMembershipTier: MembershipTier;
}

/** 服务端给终端入口和客户端投影复用的智能体资格结论。 */
export type AgentAccessDecision =
  | {
      canUse: true;
      effectiveTier: MembershipTier;
    }
  | {
      canUse: false;
      effectiveTier: MembershipTier;
      reason: AgentAccessDenialReason.Disabled;
    }
  | {
      canUse: false;
      effectiveTier: MembershipTier;
      reason:
        | AgentAccessDenialReason.MembershipExpired
        | AgentAccessDenialReason.MembershipRequired;
      requiredTier: Extract<MembershipTier, 'PLUS' | 'PRO'>;
    };

const MEMBERSHIP_RANK: Readonly<Record<MembershipTier, number>> = {
  [MembershipTier.FREE]: 0,
  [MembershipTier.PLUS]: 1,
  [MembershipTier.PRO]: 2,
};

/**
 * 统一计算会员有效等级与智能体使用资格
 * @description 该模块的接口只接收判定所需的最小事实，不访问数据库。数据库读取、事务和 HTTP
 * 错误由各业务入口负责；等级顺序、到期边界和拒绝原因只在此维护，避免多条执行链路漂移。
 */
@Injectable()
export class AgentAccessService {
  /**
   * 计算当前有效会员等级
   * @param subject 用户配置的会员等级和到期时间
   * @param now 服务端判定时刻
   * @returns 返回请求时刻真正生效的会员等级
   * @description 到期边界为 `membershipExpiresAt <= now`；到期后按 FREE 处理，但不改写配置事实。
   */
  effectiveTier(
    subject: MembershipAccessSubject,
    now: Date = new Date(),
  ): MembershipTier {
    return this.isExpired(subject, now)
      ? MembershipTier.FREE
      : subject.membershipTier;
  }

  /**
   * 判断用户当前是否可以执行指定智能体
   * @param subject 用户配置的会员事实
   * @param policy 智能体启用状态与最低会员门槛
   * @param now 服务端判定时刻
   * @returns 返回可用结论、有效等级及结构化拒绝原因
   * @description 停用优先于会员门槛；只有用户原配置足以满足门槛但因到期降级时，才返回
   * MEMBERSHIP_EXPIRED，普通等级不足返回 MEMBERSHIP_REQUIRED。
   */
  evaluate(
    subject: MembershipAccessSubject,
    policy: AgentAccessPolicy,
    now: Date = new Date(),
  ): AgentAccessDecision {
    const effectiveTier = this.effectiveTier(subject, now);
    if (!policy.enabled) {
      return {
        canUse: false,
        effectiveTier,
        reason: AgentAccessDenialReason.Disabled,
      };
    }

    if (
      MEMBERSHIP_RANK[effectiveTier] >=
      MEMBERSHIP_RANK[policy.minimumMembershipTier]
    ) {
      return { canUse: true, effectiveTier };
    }

    const requiredTier = this.requiredPaidTier(policy.minimumMembershipTier);
    return {
      canUse: false,
      effectiveTier,
      reason:
        this.isExpired(subject, now) &&
        MEMBERSHIP_RANK[subject.membershipTier] >=
          MEMBERSHIP_RANK[policy.minimumMembershipTier]
          ? AgentAccessDenialReason.MembershipExpired
          : AgentAccessDenialReason.MembershipRequired,
      requiredTier,
    };
  }

  /**
   * 判断会员配置是否已经到期
   * @param subject 用户配置的会员事实
   * @param now 服务端判定时刻
   * @returns 到期时间存在且不晚于判定时刻时返回 true
   * @description 统一使用服务端时间，避免不同客户端时钟改变权限结论。
   */
  isExpired(subject: MembershipAccessSubject, now: Date = new Date()): boolean {
    return Boolean(
      subject.membershipExpiresAt && subject.membershipExpiresAt <= now,
    );
  }

  /**
   * 收窄需要升级提示的付费会员等级
   * @param tier 智能体声明的最低会员等级
   * @returns 返回 PLUS 或 PRO
   * @description 只有有效等级不足时才调用；FREE 门槛理论上不可到达，保留明确异常防止错误配置
   * 被投影为误导性的升级提示。
   */
  private requiredPaidTier(
    tier: MembershipTier,
  ): Extract<MembershipTier, 'PLUS' | 'PRO'> {
    if (tier === MembershipTier.FREE) {
      throw new Error('FREE 门槛不应产生会员不足结论');
    }
    return tier;
  }
}

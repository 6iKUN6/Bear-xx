import { MembershipTier } from '@prisma/client';
import {
  AgentAccessDenialReason,
  AgentAccessService,
} from './agent-access.service';

describe('AgentAccessService', () => {
  const now = new Date('2026-09-01T08:00:00.000Z');
  const service = new AgentAccessService();

  it('会员到期后按 FREE 判定，并明确区分到期与普通等级不足', () => {
    const expired = service.evaluate(
      {
        membershipTier: MembershipTier.PRO,
        membershipExpiresAt: new Date('2026-09-01T08:00:00.000Z'),
      },
      { enabled: true, minimumMembershipTier: MembershipTier.PLUS },
      now,
    );
    const insufficient = service.evaluate(
      { membershipTier: MembershipTier.FREE, membershipExpiresAt: null },
      { enabled: true, minimumMembershipTier: MembershipTier.PLUS },
      now,
    );

    expect(expired).toEqual({
      canUse: false,
      effectiveTier: MembershipTier.FREE,
      reason: AgentAccessDenialReason.MembershipExpired,
      requiredTier: MembershipTier.PLUS,
    });
    expect(insufficient).toEqual({
      canUse: false,
      effectiveTier: MembershipTier.FREE,
      reason: AgentAccessDenialReason.MembershipRequired,
      requiredTier: MembershipTier.PLUS,
    });
  });

  it('停用优先于会员门槛，避免把下架问题提示成升级会员', () => {
    const result = service.evaluate(
      { membershipTier: MembershipTier.PRO, membershipExpiresAt: null },
      { enabled: false, minimumMembershipTier: MembershipTier.FREE },
      now,
    );

    expect(result).toEqual({
      canUse: false,
      effectiveTier: MembershipTier.PRO,
      reason: AgentAccessDenialReason.Disabled,
    });
  });

  it.each([
    [MembershipTier.FREE, MembershipTier.FREE, true],
    [MembershipTier.FREE, MembershipTier.PLUS, false],
    [MembershipTier.PLUS, MembershipTier.PLUS, true],
    [MembershipTier.PLUS, MembershipTier.PRO, false],
    [MembershipTier.PRO, MembershipTier.PRO, true],
  ])(
    '%s 用户访问 %s 门槛的结果为 %s',
    (membershipTier, minimumMembershipTier, canUse) => {
      expect(
        service.evaluate(
          { membershipTier, membershipExpiresAt: null },
          { enabled: true, minimumMembershipTier },
          now,
        ).canUse,
      ).toBe(canUse);
    },
  );
});

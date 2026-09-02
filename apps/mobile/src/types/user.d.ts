interface User {
  id: string;
  nickname: string;
  avatarUrl: string;
  membershipTier: "FREE" | "PLUS" | "PRO";
  effectiveMembershipTier: "FREE" | "PLUS" | "PRO";
  membershipExpiresAt: string | null;
  membershipExpired: boolean;
}

interface LoginResult {
  token: string;
  refreshToken: string;
  user: User;
}

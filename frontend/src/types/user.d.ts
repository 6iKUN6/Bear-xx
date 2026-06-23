interface User {
  id: string;
  nickname: string;
  avatarUrl: string;
}

interface LoginResult {
  token: string;
  refreshToken: string;
  user: User;
}

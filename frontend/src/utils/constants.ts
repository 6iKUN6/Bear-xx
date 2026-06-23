export const STORAGE_KEYS = {
  TOKEN: "litter_bear_token",
  USER_INFO: "litter_bear_user_info",
  CONVERSATIONS: "litter_bear_conversations",
} as const;

const apiBaseUrl = __API_BASE_URL__ || "";

export const API_BASE_URL = apiBaseUrl.replace(/\/+$/, "");

export const USE_MOCK = false; // mock 开关

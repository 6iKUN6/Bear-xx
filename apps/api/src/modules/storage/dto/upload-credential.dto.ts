export const UPLOAD_MEDIA_TYPES = ['image', 'audio'] as const;
export type UploadMediaType = (typeof UPLOAD_MEDIA_TYPES)[number];

/** 业务用途闭集：决定上传约束（如头像 2MB）与复用选择器的过滤维度 */
export const STORAGE_USAGES = [
  'agent-avatar',
  'chat-image',
  'voice-input',
  'ai-image',
] as const;
export type StorageUsage = (typeof STORAGE_USAGES)[number];

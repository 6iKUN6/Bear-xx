import {
  authControllerAccountLogin,
  authControllerLogout,
  authControllerPhoneLogin,
  authControllerRefresh,
  authControllerSendCode,
  authControllerWechatLogin,
  chatControllerImageGenerations,
  conversationControllerCreate,
  conversationControllerDelete,
  conversationControllerFindAll,
  healthControllerCheck,
  streamTaskControllerCancelTask,
  streamTaskControllerGetTask,
  streamTaskControllerResumeTask,
  streamTaskControllerStreamTask,
  userControllerGetProfile,
  userControllerUpdateProfile,
} from "./generated/client";
import type {
  AccountLoginDto,
  ChatCompletionsDto,
  CreateConversationDto,
  ImageGenerationDto,
  PhoneLoginDto,
  RefreshTokenDto,
  ResumeStreamTaskDto,
  SendCodeDto,
  StreamTaskControllerStreamTaskParams,
  UpdateProfileDto,
  VoiceCompletionsFormDataDto,
  WechatLoginDto,
} from "./generated/models";
import { BaseApiClient, type StreamHandlers, type StreamRequestHandle } from "./request";

export type VoiceCompletionsDto = Omit<VoiceCompletionsFormDataDto, "audio">;

export type {
  AccountLoginDto,
  ChatCompletionsDto,
  CreateConversationDto,
  ImageGenerationDto,
  PhoneLoginDto,
  RefreshTokenDto,
  ResumeStreamTaskDto,
  SendCodeDto,
  StreamTaskControllerStreamTaskParams,
  UpdateProfileDto,
  VoiceCompletionsFormDataDto,
  WechatLoginDto,
};

export * from "./generated/client";
export * from "./generated/models";

export class Api extends BaseApiClient {
  accountLogin(body: AccountLoginDto): Promise<unknown> {
    return authControllerAccountLogin(body) as Promise<unknown>;
  }

  logout(): Promise<unknown> {
    return authControllerLogout() as Promise<unknown>;
  }

  phoneLogin(body: PhoneLoginDto): Promise<unknown> {
    return authControllerPhoneLogin(body) as Promise<unknown>;
  }

  sendCode(body: SendCodeDto): Promise<unknown> {
    return authControllerSendCode(body) as Promise<unknown>;
  }

  refresh(body: RefreshTokenDto): Promise<unknown> {
    return authControllerRefresh(body) as Promise<unknown>;
  }

  wechatLogin(body: WechatLoginDto): Promise<unknown> {
    return authControllerWechatLogin(body) as Promise<unknown>;
  }

  getProfile(): Promise<unknown> {
    return userControllerGetProfile() as Promise<unknown>;
  }

  updateProfile(body: UpdateProfileDto): Promise<unknown> {
    return userControllerUpdateProfile(body) as Promise<unknown>;
  }

  findAll(): Promise<unknown> {
    return conversationControllerFindAll() as Promise<unknown>;
  }

  create(body: CreateConversationDto): Promise<unknown> {
    return conversationControllerCreate(body) as Promise<unknown>;
  }

  delete(args: { id: string }): Promise<unknown> {
    return conversationControllerDelete(args.id) as Promise<unknown>;
  }

  imageGenerations(body: ImageGenerationDto): Promise<unknown> {
    return chatControllerImageGenerations(body) as Promise<unknown>;
  }

  sendMessage(
    body: ChatCompletionsDto,
    handlers: StreamHandlers<unknown> = {},
  ): StreamRequestHandle {
    return this.stream<unknown, ChatCompletionsDto>(
      {
        url: "/api/chat/message",
        method: "POST",
        data: body,
      },
      handlers,
    );
  }

  voiceCompletions(args: {
    body?: VoiceCompletionsDto;
    filePath: string;
    fileFieldName?: string;
  }): Promise<unknown> {
    return this.upload<unknown, VoiceCompletionsDto>({
      url: "/api/chat/voice-messages",
      method: "POST",
      filePath: args.filePath,
      name: args.fileFieldName || "audio",
      formData: args.body,
    });
  }

  getTask(args: { taskId: string }): Promise<unknown> {
    return streamTaskControllerGetTask(args.taskId) as Promise<unknown>;
  }

  streamTask(args: {
    taskId: string;
    cursor?: string;
  }): Promise<unknown> {
    const params: StreamTaskControllerStreamTaskParams = {
      cursor: args.cursor ?? "0",
    };

    return streamTaskControllerStreamTask(args.taskId, params) as Promise<unknown>;
  }

  resumeTask(args: {
    taskId: string;
    body: ResumeStreamTaskDto;
  }): Promise<unknown> {
    return streamTaskControllerResumeTask(args.taskId, args.body) as Promise<unknown>;
  }

  cancelTask(args: { taskId: string }): Promise<unknown> {
    return streamTaskControllerCancelTask(args.taskId) as Promise<unknown>;
  }

  check() {
    return healthControllerCheck();
  }
}

export const api = new Api();

export default api;

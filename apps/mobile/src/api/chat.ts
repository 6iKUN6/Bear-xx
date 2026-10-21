import { api } from "./generated";

/** 会话目录：只含基础信息，消息经 getConversationMessages 分页读取 */
export async function getConversations(): Promise<ConversationSummary[]> {
  return (await api.findAll()) as ConversationSummary[];
}

/**
 * 分页读取会话消息
 * @param before 只取早于该消息的一页；缺省取最新一页
 * @returns 本页消息（时间正序）与是否还有更早消息
 */
export async function getConversationMessages(
  conversationId: string,
  before?: string,
): Promise<ConversationMessagePage> {
  return (await api.findMessages({
    id: conversationId,
    params: before ? { before } : undefined,
  })) as ConversationMessagePage;
}

export async function createConversation(
  input: {
    title?: string;
    type?: ConversationType;
    agentIds?: string[];
  } = {},
): Promise<ConversationSummary> {
  return (await api.create(input)) as ConversationSummary;
}

export async function deleteConversation(id: string): Promise<void> {
  await api.delete({ id });
}

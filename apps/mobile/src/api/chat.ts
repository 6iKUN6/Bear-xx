import { api } from "./generated";

export async function getConversations(): Promise<Conversation[]> {
  return (await api.findAll()) as Conversation[];
}

export async function createConversation(
  input: {
    title?: string;
    type?: ConversationType;
    agentIds?: string[];
  } = {},
): Promise<Conversation> {
  return (await api.create(input)) as Conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  await api.delete({ id });
}

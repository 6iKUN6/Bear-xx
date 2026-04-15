type MessageRole = "user" | "assistant";
type MessageStatus = "sending" | "streaming" | "done" | "error";

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

type MessageRole = "user" | "assistant";
type MessageStatus = "sending" | "streaming" | "done" | "error";
type MessageStreamEventTone = "info" | "success" | "warning" | "error";
type MessageStreamEventDisplay = "panel" | "text";

interface MessageStreamEventFeedback {
  id: string;
  type: string;
  title: string;
  detail?: string;
  tone: MessageStreamEventTone;
  display: MessageStreamEventDisplay;
  updatedAt: number;
}

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
  currentStreamEvent?: MessageStreamEventFeedback;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

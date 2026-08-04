import { groupConversationsByTime } from "./conversation";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-08-04T12:00:00+08:00").getTime();

const conversations: Conversation[] = [
  { id: "today", title: "今天", messages: [], createdAt: now, updatedAt: now },
  {
    id: "yesterday",
    title: "昨天",
    messages: [],
    createdAt: now,
    updatedAt: now - DAY_MS,
  },
  {
    id: "three-days",
    title: "三天内",
    messages: [],
    createdAt: now,
    updatedAt: now - 2 * DAY_MS,
  },
  {
    id: "seven-days",
    title: "七天内",
    messages: [],
    createdAt: now,
    updatedAt: now - 4 * DAY_MS,
  },
  {
    id: "thirty-days",
    title: "30天内",
    messages: [],
    createdAt: now,
    updatedAt: now - 12 * DAY_MS,
  },
];

const groups = groupConversationsByTime(conversations, now);
const labels = groups.map((group) => group.label);

if (labels.join(",") !== "今天,昨天,三天内,七天内,30天内") {
  throw new Error(`历史分组不符合抽屉设计：${labels.join(",")}`);
}

for (const group of groups) {
  if (group.items.length !== 1 || group.items[0].title !== group.label) {
    throw new Error(`分组“${group.label}”没有保留正确会话`);
  }
}

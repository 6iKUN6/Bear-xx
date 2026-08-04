export interface ConversationGroup {
  label: string;
  items: Conversation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 按时间维度分组会话
 * @param conversations 会话列表（任意顺序）
 * @returns 返回非空分组：今天 / 昨天 / 三天内 / 七天内 / 30天内 / 更早，组内按更新时间倒序
 * @description 边界按自然日（本地时区 0 点）计算而非滚动 24h，
 * 「昨天 23:59 的会话」在 0 点后立刻归入昨天，符合日历直觉。
 */
export function groupConversationsByTime(
  conversations: Conversation[],
  now = Date.now(),
): ConversationGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  const yesterdayStart = todayStart - DAY_MS;
  const threeDaysStart = todayStart - 3 * DAY_MS;
  const sevenDaysStart = todayStart - 7 * DAY_MS;
  const thirtyDaysStart = todayStart - 30 * DAY_MS;

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: ConversationGroup[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "三天内", items: [] },
    { label: "七天内", items: [] },
    { label: "30天内", items: [] },
    { label: "更早", items: [] },
  ];

  for (const conversation of sorted) {
    const time = conversation.updatedAt;
    if (time >= todayStart) {
      groups[0].items.push(conversation);
    } else if (time >= yesterdayStart) {
      groups[1].items.push(conversation);
    } else if (time >= threeDaysStart) {
      groups[2].items.push(conversation);
    } else if (time >= sevenDaysStart) {
      groups[3].items.push(conversation);
    } else if (time >= thirtyDaysStart) {
      groups[4].items.push(conversation);
    } else {
      groups[5].items.push(conversation);
    }
  }

  return groups.filter((group) => group.items.length > 0);
}

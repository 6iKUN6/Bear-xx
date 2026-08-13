const AWAITING_PAYMENT_STATUSES = new Set([
  "UNPAID",
  "PENDING_PAYMENT",
  "WAIT_PAY",
  "WAITING_PAYMENT",
  "TO_BE_PAID",
]);

/**
 * 是否可以展示官方支付入口。
 * @description 与后端支付链接接口使用相同的明确状态白名单；未知状态一律不能显示支付入口。
 */
export function isMcDonaldsOrderAwaitingPayment(
  status: string | null | undefined,
): boolean {
  return Boolean(
    status && AWAITING_PAYMENT_STATUSES.has(status.trim().toUpperCase()),
  );
}

/** 格式化订单金额，缺失金额不伪造为零。 */
export function formatMcDonaldsOrderAmount(
  amount: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (!amount) {
    return "金额待官方同步";
  }

  if (!currency || currency.toUpperCase() === "CNY") {
    return `¥${amount}`;
  }

  return `${currency.toUpperCase()} ${amount}`;
}

/** 显示官方状态；未识别状态保留中性文案。 */
export function getMcDonaldsOrderStatusLabel(
  statusLabel: string | null | undefined,
  status: string | null | undefined,
): string {
  return statusLabel || status || "状态待官方同步";
}

/** 将 ISO 时间转为本地短日期；无效时间不显示。 */
export function formatMcDonaldsOrderDate(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

import {
  formatMcDonaldsOrderAmount,
  isMcDonaldsOrderAwaitingPayment,
} from "./mcdonaldsOrder.js";

if (!isMcDonaldsOrderAwaitingPayment("UNPAID")) {
  throw new Error("UNPAID 订单应显示官方支付入口");
}

if (!isMcDonaldsOrderAwaitingPayment("waiting_payment")) {
  throw new Error("状态判断应忽略大小写");
}

if (isMcDonaldsOrderAwaitingPayment("PROCESSING")) {
  throw new Error("非待支付订单不能显示支付入口");
}

if (isMcDonaldsOrderAwaitingPayment(null)) {
  throw new Error("未知订单状态不能显示支付入口");
}

if (formatMcDonaldsOrderAmount(null, "CNY") !== "金额待官方同步") {
  throw new Error("缺失金额不能被伪造成 0 元");
}

if (formatMcDonaldsOrderAmount("24.50", "CNY") !== "¥24.50") {
  throw new Error("CNY 金额应显示人民币符号");
}

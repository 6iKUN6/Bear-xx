import { useState } from "react";
import { Image, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { McDonaldsOrder } from "../../api/mcdonaldsOrder";
import { refreshMcDonaldsOrder } from "../../api/mcdonaldsOrder";
import {
  formatMcDonaldsOrderAmount,
  formatMcDonaldsOrderDate,
  getMcDonaldsOrderStatusLabel,
  isMcDonaldsOrderAwaitingPayment,
} from "../../utils/mcdonaldsOrder";
import McdonaldsPaymentSheet from "../McdonaldsPaymentSheet";
import AppIcon from "../AppIcon";
import "./index.scss";

interface McdonaldsOrderCardProps {
  order: McDonaldsOrder;
  /** 刷新成功后把最新安全订单快照交还给拥有状态的页面或聊天消息。 */
  onOrderChange?: (order: McDonaldsOrder) => void;
  /** 详情页已在订单上下文中，避免重复提供跳转入口。 */
  detailMode?: boolean;
  className?: string;
}

/**
 * 麦当劳订单安全回显卡片。
 * @description 只接收 REST/SSE/会话历史的安全 DTO；支付 URL 不作为 props 或状态存在。
 */
export default function McdonaldsOrderCard({
  order,
  onOrderChange,
  detailMode = false,
  className = "",
}: McdonaldsOrderCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const awaitingPayment = isMcDonaldsOrderAwaitingPayment(order.status);
  const externalActionsAvailable = order.externalActionsAvailable;
  const expectedTime = formatMcDonaldsOrderDate(order.estimatedFulfillmentAt);
  const refreshedTime = formatMcDonaldsOrderDate(order.lastRefreshedAt);
  const createdTime = formatMcDonaldsOrderDate(order.createdAt);

  const handleRefresh = async () => {
    if (refreshing || !externalActionsAvailable) {
      return;
    }

    setRefreshing(true);
    setRefreshError(null);
    try {
      const next = await refreshMcDonaldsOrder(order.id);
      onOrderChange?.(next);
      void Taro.showToast({ title: "订单状态已刷新", icon: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新订单状态失败";
      setRefreshError(message.slice(0, 42));
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpenDetail = () => {
    if (detailMode) {
      return;
    }

    void Taro.navigateTo({ url: `/pages/orders/detail?id=${order.id}` });
  };

  return (
    <>
      <View className={`mcd-order-card ${className}`.trim()}>
        <View className='mcd-order-card-head'>
          <View className='mcd-order-brand'>
            <Text className='mcd-order-brand-mark'>M</Text>
            <View className='min-w-0 flex-1'>
              <Text className='block overflow-hidden text-ellipsis whitespace-nowrap text-[0.875rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
                {order.storeName || "麦当劳订单"}
              </Text>
              <Text className='mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.35] text-[var(--lb-text-muted)]'>
                {order.fulfillmentType || "履约方式待官方同步"}
              </Text>
            </View>
          </View>
          <View className={`mcd-order-status mcd-order-status-${statusTone(order.status)}`}>
            <Text>{getMcDonaldsOrderStatusLabel(order.statusLabel, order.status)}</Text>
          </View>
        </View>

        <View className='mcd-order-progress' aria-hidden>
          <View
            className={`mcd-order-progress-fill mcd-order-progress-${statusTone(order.status)}`}
          />
        </View>

        {expectedTime ? (
          <View className='mcd-order-time-line'>
            <AppIcon name='clock' className='h-[0.75rem] w-[0.75rem] text-[var(--lb-text-muted)]' />
            <Text>预计 {expectedTime} {order.fulfillmentType || "可取餐"}</Text>
          </View>
        ) : null}

        <View className='mcd-order-items'>
          {order.items.length > 0 ? (
            order.items.map((item, index) => (
              <View className='mcd-order-item' key={`${item.name}-${index}`}>
                {item.imageUrl ? (
                  <Image
                    className='mcd-order-item-image'
                    src={item.imageUrl}
                    mode='aspectFill'
                  />
                ) : (
                  <View className='mcd-order-item-placeholder'>
                    <AppIcon name='shoppingBag' className='h-[0.875rem] w-[0.875rem]' />
                  </View>
                )}
                <View className='min-w-0 flex-1'>
                  <Text className='block overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-medium leading-[1.35] text-[var(--lb-text-primary)]'>
                    {item.name}
                  </Text>
                  {item.specification ? (
                    <Text className='mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.35] text-[var(--lb-text-muted)]'>
                      {item.specification}
                    </Text>
                  ) : null}
                </View>
                <View className='ml-[0.5rem] flex shrink-0 items-center gap-[0.5rem]'>
                  <Text className='text-[0.75rem] leading-[1.3] text-[var(--lb-text-secondary)]'>
                    x{item.quantity ?? "-"}
                  </Text>
                  <Text className='min-w-[3.25rem] text-right text-[0.75rem] font-medium leading-[1.3] text-[var(--lb-text-primary)]'>
                    {item.subtotal || item.unitPrice || "-"}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <Text className='block py-[0.25rem] text-[0.75rem] leading-[1.5] text-[var(--lb-text-muted)]'>
              订单餐品明细待官方同步
            </Text>
          )}
        </View>

        <View className='mcd-order-total'>
          <View className='min-w-0'>
            {order.discountAmount ? (
              <Text className='block text-[0.6875rem] leading-[1.35] text-[var(--lb-success)]'>
                已优惠 {formatMcDonaldsOrderAmount(order.discountAmount, order.currency)}
              </Text>
            ) : null}
            <Text className='mt-[0.125rem] block text-[0.6875rem] leading-[1.35] text-[var(--lb-text-muted)]'>
              {refreshedTime ? `最近同步 ${refreshedTime}` : createdTime ? `下单于 ${createdTime}` : "订单时间待同步"}
            </Text>
          </View>
          <View className='text-right'>
            <Text className='block text-[0.6875rem] leading-[1.25] text-[var(--lb-text-muted)]'>
              实付
            </Text>
            <Text className='mt-[0.125rem] block text-[1.125rem] font-bold leading-[1.15] text-[var(--lb-text-primary)]'>
              {formatMcDonaldsOrderAmount(order.totalAmount, order.currency)}
            </Text>
          </View>
        </View>

        {refreshError ? (
          <Text className='mt-[0.625rem] block text-[0.6875rem] leading-[1.4] text-[var(--lb-danger)]'>
            {refreshError}
          </Text>
        ) : null}

        <View className='mcd-order-actions'>
          {!detailMode ? (
            <View className='mcd-order-secondary-action' onClick={handleOpenDetail}>
              <Text>订单详情</Text>
              <AppIcon name='chevronRight' className='h-[0.75rem] w-[0.75rem]' />
            </View>
          ) : null}
          {externalActionsAvailable && awaitingPayment ? (
            <View
              className='mcd-order-primary-action'
              onClick={() => setPaymentVisible(true)}
            >
              <AppIcon name='link' className='h-[0.8125rem] w-[0.8125rem]' />
              <Text>去官方支付</Text>
            </View>
          ) : externalActionsAvailable ? (
            <View
              className={`mcd-order-primary-action ${refreshing ? "mcd-order-action-disabled" : ""}`}
              onClick={() => void handleRefresh()}
            >
              <AppIcon name='reload' className='h-[0.8125rem] w-[0.8125rem]' />
              <Text>{refreshing ? "刷新中" : "刷新订单状态"}</Text>
            </View>
          ) : (
            <View className='mcd-order-readonly-status'>
              <AppIcon name='lock' className='h-[0.75rem] w-[0.75rem]' />
              <Text>账号已解绑，订单仅可查看</Text>
            </View>
          )}
        </View>
      </View>

      <McdonaldsPaymentSheet
        orderId={order.id}
        visible={paymentVisible}
        onClose={() => setPaymentVisible(false)}
      />
    </>
  );
}

function statusTone(status: string | null | undefined): "pending" | "active" | "complete" | "neutral" {
  const normalized = status?.toUpperCase() || "";
  if (isMcDonaldsOrderAwaitingPayment(normalized)) {
    return "pending";
  }
  // MCP 未给出固定结果枚举；仅给少量确认过的值着色，未知状态保留中性原文。
  if (["COMPLETED", "FINISHED", "PICKED_UP", "DELIVERED"].includes(normalized)) {
    return "complete";
  }
  if (["PROCESSING", "PREPARING", "DELIVERING", "ACCEPTED"].includes(normalized)) {
    return "active";
  }
  return "neutral";
}

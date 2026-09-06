import { useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import { useDidShow } from "@tarojs/taro";
import type { McDonaldsOrder } from "../../api/mcdonaldsOrder";
import { getMcDonaldsOrders } from "../../api/mcdonaldsOrder";
import McdonaldsOrderCard from "../../components/McdonaldsOrderCard";
import AppIcon from "../../components/AppIcon";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import { appScreenClass } from "../../utils/style";
import "./index.scss";

/** 当前用户在本系统创建的麦当劳订单历史。 */
export default function McdonaldsOrdersPage() {
  const [orders, setOrders] = useState<McDonaldsOrder[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirstPage = async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await getMcDonaldsOrders();
      setOrders(page.items);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor ?? null);
    } catch (requestError) {
      setError(toOrderErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  };

  useDidShow(() => {
    void loadFirstPage();
  });

  const loadMore = async () => {
    if (!hasMore || !nextCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    try {
      const page = await getMcDonaldsOrders(nextCursor);
      setOrders((current) => mergeOrders(current, page.items));
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor ?? null);
    } catch (requestError) {
      setError(toOrderErrorMessage(requestError));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleOrderChange = (next: McDonaldsOrder) => {
    setOrders((current) =>
      current.map((order) => (order.id === next.id ? next : order)),
    );
  };

  return (
    <PageShell>
      <NavBar title='我的订单' showBack capsule='hidden' />
      <ScrollView
        className={appScreenClass}
        lowerThreshold={96}
        scrollY
        onScrollToLower={() => void loadMore()}
      >
        <View className='px-[1rem] pb-[1.125rem] pt-[0.875rem]'>
          <Text className='block text-[1.25rem] font-bold leading-[1.25] text-[var(--lb-text-primary)]'>
            我的订单
          </Text>
          <Text className='mt-[0.375rem] block text-[0.8125rem] leading-[1.5] text-[var(--lb-text-secondary)]'>
            仅显示通过本服务创建的麦当劳订单
          </Text>

          {loading ? (
            <OrderLoading />
          ) : orders.length > 0 ? (
            <View className='mt-[1rem] flex flex-col gap-[0.75rem]'>
              {orders.map((order) => (
                <McdonaldsOrderCard
                  key={order.id}
                  order={order}
                  onOrderChange={handleOrderChange}
                />
              ))}
              {hasMore ? (
                <View
                  className='flex min-h-[2.75rem] items-center justify-center rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] active:bg-[var(--lb-surface-hover)]'
                  onClick={() => void loadMore()}
                >
                  <Text className='text-[0.8125rem] leading-none text-[var(--lb-text-secondary)]'>
                    {loadingMore ? "加载中…" : "加载更多订单"}
                  </Text>
                </View>
              ) : (
                <Text className='py-[0.5rem] text-center text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]'>
                  已展示全部订单
                </Text>
              )}
            </View>
          ) : (
            <OrderEmpty onRetry={() => void loadFirstPage()} error={error} />
          )}

          {error && orders.length > 0 ? (
            <View className='mt-[0.875rem] flex items-center justify-between gap-[0.75rem] rounded-[var(--lb-radius-sm)] bg-[var(--lb-danger-soft)] px-[0.75rem] py-[0.625rem]'>
              <Text className='min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.35] text-[var(--lb-danger)]'>
                {error}
              </Text>
              <Text
                className='shrink-0 text-[0.75rem] font-semibold leading-none text-[var(--lb-danger)]'
                onClick={() => void loadFirstPage()}
              >
                重试
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </PageShell>
  );
}

function OrderLoading() {
  return (
    <View className='mt-[1rem] flex min-h-[14rem] flex-col items-center justify-center gap-[0.75rem]'>
      <View className='mcd-orders-loading-spinner' />
      <Text className='text-[0.8125rem] leading-[1.4] text-[var(--lb-text-muted)]'>
        正在读取订单
      </Text>
    </View>
  );
}

function OrderEmpty({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <View className='mt-[1rem] flex min-h-[16rem] flex-col items-center justify-center px-[1.5rem] text-center'>
      <View className='flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-[var(--lb-radius-md)] bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]'>
        <AppIcon name='shoppingBag' className='h-[1.5rem] w-[1.5rem]' />
      </View>
      <Text className='mt-[0.875rem] block text-[1rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
        {error ? "订单暂时无法加载" : "还没有订单"}
      </Text>
      <Text className='mt-[0.375rem] block text-[0.8125rem] leading-[1.5] text-[var(--lb-text-secondary)]'>
        {error || "在聊天中完成点餐后，订单会出现在这里"}
      </Text>
      {error ? (
        <View
          className='mt-[1rem] rounded-[var(--lb-radius-sm)] bg-[var(--lb-accent-surface)] px-[1rem] py-[0.625rem] active:opacity-80'
          onClick={onRetry}
        >
          <Text className='text-[0.8125rem] font-semibold leading-none text-[var(--lb-on-accent)]'>
            重新加载
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function mergeOrders(
  current: McDonaldsOrder[],
  incoming: McDonaldsOrder[],
): McDonaldsOrder[] {
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !ids.has(item.id))];
}

function toOrderErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 42)
    : "订单加载失败，请稍后重试";
}

import { useState } from "react";
import { Text, View } from "@tarojs/components";
import Taro, { useDidShow, useRouter } from "@tarojs/taro";
import type { McDonaldsOrder } from "../../api/mcdonaldsOrder";
import { getMcDonaldsOrder } from "../../api/mcdonaldsOrder";
import McdonaldsOrderCard from "../../components/McdonaldsOrderCard";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import { appScreenClass } from "../../utils/style";
import "./index.scss";

/** 订单详情页：只显示安全订单字段，支付链接由卡片中用户点击时按需请求。 */
export default function McdonaldsOrderDetailPage() {
  const router = useRouter();
  const orderId = router.params.id || "";
  const [order, setOrder] = useState<McDonaldsOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOrder = async () => {
    if (!orderId) {
      setError("缺少订单标识");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setOrder(await getMcDonaldsOrder(orderId));
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message
          ? requestError.message.slice(0, 42)
          : "订单详情加载失败",
      );
    } finally {
      setLoading(false);
    }
  };

  useDidShow(() => {
    void loadOrder();
  });

  return (
    <PageShell>
      <NavBar title='订单详情' showBack capsule='hidden' />
      <View className={appScreenClass}>
        <View className='px-[1rem] pb-[1.5rem] pt-[0.875rem]'>
          {loading ? (
            <View className='flex min-h-[16rem] flex-col items-center justify-center gap-[0.75rem]'>
              <View className='mcd-orders-loading-spinner' />
              <Text className='text-[0.8125rem] leading-[1.4] text-[var(--lb-text-muted)]'>
                正在读取订单详情
              </Text>
            </View>
          ) : order ? (
            <McdonaldsOrderCard
              detailMode
              order={order}
              onOrderChange={setOrder}
            />
          ) : (
            <View className='flex min-h-[16rem] flex-col items-center justify-center px-[1.5rem] text-center'>
              <Text className='block text-[1rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
                订单暂时无法显示
              </Text>
              <Text className='mt-[0.375rem] block text-[0.8125rem] leading-[1.5] text-[var(--lb-text-secondary)]'>
                {error || "请返回订单列表后重试"}
              </Text>
              <View className='mt-[1rem] flex gap-[0.625rem]'>
                <View
                  className='rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-strong)] px-[1rem] py-[0.625rem] active:bg-[var(--lb-surface-hover)]'
                  onClick={() => Taro.navigateBack()}
                >
                  <Text className='text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-secondary)]'>
                    返回
                  </Text>
                </View>
                <View
                  className='rounded-[var(--lb-radius-sm)] bg-[var(--lb-accent-surface)] px-[1rem] py-[0.625rem] active:opacity-80'
                  onClick={() => void loadOrder()}
                >
                  <Text className='text-[0.8125rem] font-semibold leading-none text-[var(--lb-on-accent)]'>
                    重试
                  </Text>
                </View>
              </View>
            </View>
          )}
        </View>
      </View>
    </PageShell>
  );
}

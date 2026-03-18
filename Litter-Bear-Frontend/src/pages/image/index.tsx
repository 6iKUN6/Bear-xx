import { View, Text } from "@tarojs/components";
import TabBar from "../../components/TabBar";

export default function ImagePage() {
  return (
    <View className='app-page'>
      <View className='app-page__body flex items-center justify-center px-rpx-48 pb-rpx-196'>
        <View className='app-surface app-animate-fade-in-up w-full max-w-[640rpx] px-rpx-64 py-rpx-72 text-center box-border'>
          <Text className='mb-rpx-32 block text-[120rpx] leading-none'>🎨</Text>
          <Text className='mb-rpx-16 block text-rpx-40 font-semibold leading-[1.3] text-td-text-primary'>
            AI 画图
          </Text>
          <Text className='block text-rpx-28 leading-[1.5] text-td-text-secondary'>
            功能开发中，敬请期待...
          </Text>
        </View>
      </View>
      <TabBar current={1} />
    </View>
  );
}

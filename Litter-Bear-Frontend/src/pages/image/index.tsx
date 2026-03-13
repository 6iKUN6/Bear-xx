import { View, Text } from "@tarojs/components";
import TabBar from "../../components/TabBar";

export default function ImagePage() {
  return (
    <View className='flex flex-col min-h-screen bg-td-bg-page'>
      <View className='flex-1 flex flex-col items-center justify-center px-6 pb-[156rpx]'>
        <View className='animate-fade-in-up w-full max-w-[640rpx] bg-white border border-td-border-base rounded-td-lg shadow-td-sm px-8 py-[72rpx]'>
          <Text className='text-[120rpx] block text-center mb-4'>🎨</Text>
          <Text className='text-[40rpx] font-semibold text-td-text-primary block text-center mb-2'>
            AI 画图
          </Text>
          <Text className='text-[28rpx] text-td-text-secondary block text-center'>
            功能开发中，敬请期待...
          </Text>
        </View>
      </View>
      <TabBar current={1} />
    </View>
  );
}

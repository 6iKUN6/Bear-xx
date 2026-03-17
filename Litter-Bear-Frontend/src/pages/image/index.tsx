import { View, Text } from "@tarojs/components";
import TabBar from "../../components/TabBar";
import "./index.scss";

export default function ImagePage() {
  return (
    <View className='app-page image-page'>
      <View className='app-page__body image-page__body'>
        <View className='app-surface image-page__card app-animate-fade-in-up'>
          <Text className='image-page__icon'>🎨</Text>
          <Text className='image-page__title'>
            AI 画图
          </Text>
          <Text className='image-page__subtitle'>
            功能开发中，敬请期待...
          </Text>
        </View>
      </View>
      <TabBar current={1} />
    </View>
  );
}

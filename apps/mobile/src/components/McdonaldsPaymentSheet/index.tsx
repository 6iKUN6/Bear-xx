import { useEffect, useRef, useState } from "react";
import { Image, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import {
  getMcDonaldsPaymentLink,
  getMcDonaldsPaymentQr,
} from "../../api/mcdonaldsOrder";
import "./index.scss";

interface McdonaldsPaymentSheetProps {
  orderId: string;
  visible: boolean;
  onClose: () => void;
}

/**
 * 麦当劳官方支付入口。
 * @description H5 只在用户点击后临时读取链接并立即跳转；小程序只保存二维码临时文件路径，
 * 复制链接时重新请求，支付 URL 不会进入 React state、Zustand 或本地存储。
 */
export default function McdonaldsPaymentSheet({
  orderId,
  visible,
  onClose,
}: McdonaldsPaymentSheetProps) {
  const [loading, setLoading] = useState(false);
  const [qrPath, setQrPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;

  useEffect(() => {
    if (!visible) {
      setLoading(false);
      setQrPath(null);
      setError(null);
      return;
    }

    let disposed = false;
    let temporaryQrPath: string | null = null;

    const clearTemporaryQr = () => {
      if (!temporaryQrPath || !isWeapp) {
        return;
      }

      try {
        Taro.getFileSystemManager().unlink({
          filePath: temporaryQrPath,
          fail: () => undefined,
        });
      } catch {
        // 临时文件由运行时回收也没有关系，不能因清理失败打断支付流程。
      }
    };

    const openH5Payment = async () => {
      setLoading(true);
      try {
        const paymentLink = await getMcDonaldsPaymentLink(orderId);
        if (disposed) {
          return;
        }

        if (typeof window === "undefined") {
          throw new Error("当前环境无法打开官方支付页面");
        }

        window.location.assign(paymentLink.url);
      } catch (requestError) {
        if (!disposed) {
          const message = toPaymentErrorMessage(requestError);
          Taro.showToast({ title: message, icon: "none" });
          onCloseRef.current();
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    const loadWeappQr = async () => {
      setLoading(true);
      setError(null);
      try {
        const binary = await getMcDonaldsPaymentQr(orderId);
        if (disposed) {
          return;
        }

        temporaryQrPath = await writePaymentQrFile(binary, orderId);
        if (disposed) {
          clearTemporaryQr();
          return;
        }
        setQrPath(temporaryQrPath);
      } catch (requestError) {
        if (!disposed) {
          setError(toPaymentErrorMessage(requestError));
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    if (isWeapp) {
      void loadWeappQr();
    } else {
      void openH5Payment();
    }

    return () => {
      disposed = true;
      clearTemporaryQr();
    };
  }, [isWeapp, orderId, visible]);

  const handleSaveQr = async () => {
    if (!qrPath) {
      return;
    }

    try {
      await Taro.saveImageToPhotosAlbum({ filePath: qrPath });
      void Taro.showToast({ title: "二维码已保存", icon: "success" });
    } catch {
      void Taro.showToast({ title: "保存失败，请检查相册权限", icon: "none" });
    }
  };

  const handleCopyPaymentLink = async () => {
    try {
      const paymentLink = await getMcDonaldsPaymentLink(orderId);
      await Taro.setClipboardData({ data: paymentLink.url });
      void Taro.showToast({ title: "支付链接已复制", icon: "success" });
    } catch (requestError) {
      void Taro.showToast({
        title: toPaymentErrorMessage(requestError),
        icon: "none",
      });
    }
  };

  if (!visible || !isWeapp) {
    return null;
  }

  return (
    <View className='mcd-payment-mask' onClick={onClose}>
      <View
        className='mcd-payment-sheet'
        onClick={(event) => event.stopPropagation()}
      >
        <View className='mcd-payment-sheet-handle' />
        <View className='mcd-payment-sheet-head'>
          <View className='mcd-payment-brand-mark'>M</View>
          <View className='min-w-0 flex-1'>
            <Text className='block text-[1.0625rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
              使用麦当劳官方渠道支付
            </Text>
            <Text className='mt-[0.25rem] block text-[0.75rem] leading-[1.45] text-[var(--lb-text-secondary)]'>
              支付完成后，请返回订单页手动刷新状态
            </Text>
          </View>
          <View className='mcd-payment-close' onClick={onClose}>
            <Text className='at-icon at-icon-close text-[0.9375rem] leading-none [&::before]:block' />
          </View>
        </View>

        <View className='mcd-payment-qr-area'>
          {loading ? (
            <View className='mcd-payment-placeholder'>
              <View className='mcd-payment-spinner' />
              <Text>正在获取官方支付二维码</Text>
            </View>
          ) : qrPath ? (
            <Image
              className='mcd-payment-qr-image'
              src={qrPath}
              mode='aspectFit'
            />
          ) : (
            <View className='mcd-payment-placeholder'>
              <Text className='at-icon at-icon-alert-circle text-[1.25rem] leading-none text-[var(--lb-warning)] [&::before]:block' />
              <Text>{error || "暂时无法获取支付二维码"}</Text>
            </View>
          )}
        </View>

        <View className='mt-[1rem] flex gap-[0.625rem]'>
          <View
            className='mcd-payment-secondary-action'
            onClick={() => void handleCopyPaymentLink()}
          >
            <Text className='at-icon at-icon-copy text-[0.875rem] leading-none [&::before]:block' />
            <Text>复制链接</Text>
          </View>
          <View
            className={`mcd-payment-primary-action ${qrPath ? "" : "mcd-payment-action-disabled"}`}
            onClick={() => void handleSaveQr()}
          >
            <Text className='at-icon at-icon-download text-[0.875rem] leading-none [&::before]:block' />
            <Text>保存二维码</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function writePaymentQrFile(binary: ArrayBuffer, orderId: string): Promise<string> {
  const filePath = `${Taro.env.USER_DATA_PATH}/mcd-payment-${orderId}-${Date.now()}.png`;
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().writeFile({
      filePath,
      data: binary,
      success: () => resolve(filePath),
      fail: (error) => reject(new Error(error.errMsg || "写入二维码失败")),
    });
  });
}

function toPaymentErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 40)
    : "支付入口暂时不可用";
}

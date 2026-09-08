import { useMemo, useState } from "react";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { bindWechat, loginByPhone, loginByWechat } from "../../api/user";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import AppIcon from "../../components/AppIcon";
import type { AppIconName } from "../../components/AppIcon";
import { useUserStore } from "../../store/userStore";
import {
  appGlassCardClass,
  appGradientSurfaceClass,
  appHairlineClass,
  appIconTileClass,
} from "../../utils/style";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

const loginButtonBaseClass =
  "flex h-[3.25rem] w-full items-center justify-center gap-[0.625rem] rounded-[var(--lb-radius-md)] border-0 transition-all";
const loginButtonEnabledClass = `${appGradientSurfaceClass} shadow-[var(--lb-shadow-glow)]`;
const loginButtonDisabledClass =
  "bg-[var(--lb-surface-hover)] text-[var(--lb-text-muted)] shadow-none";

interface FieldRowProps {
  /** 图标（AppIcon 闭集） */
  icon: AppIconName;
  /** 该字段当前是否要显示错误（决定瓷贴与文案的 danger 着色） */
  invalid: boolean;
  /** 错误文案；空串表示无错误 */
  error: string;
  children: React.ReactNode;
}

/**
 * 表单卡里的一个字段行：软色图标瓷贴 + 输入框，下方预留错误文案位。
 * @description 沿用 profile 页「图标瓷贴 + 分区行」语言；有错误时瓷贴转 danger 软色对，
 * 错误文案显示在该字段正下方（min-height 预留，避免校验时布局跳动）。
 */
function FieldRow({ icon, invalid, error, children }: FieldRowProps) {
  return (
    <View className="px-[1rem]">
      <View className="flex h-[3.5rem] items-center gap-[0.75rem]">
        <View
          className={`flex h-[1.875rem] w-[1.875rem] shrink-0 items-center justify-center rounded-[var(--lb-radius-xs)] ${
            invalid
              ? "bg-[var(--lb-danger-soft)] text-[var(--lb-danger)]"
              : "bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
          }`}
        >
          <AppIcon name={icon} className="h-[1rem] w-[1rem]" />
        </View>
        {children}
      </View>
      <View className="min-h-[1.375rem] justify-center pb-[0.125rem]">
        {invalid && error ? (
          <Text className="block text-[0.75rem] leading-[1.35] text-[var(--lb-danger)]">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default function LoginPage() {
  const login = useUserStore((s) => s.login);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [touched, setTouched] = useState({
    phone: false,
    password: false,
  });

  const normalizedPhone = useMemo(() => phone.trim(), [phone]);
  const normalizedPassword = useMemo(() => password.trim(), [password]);

  const phoneError = useMemo(() => {
    if (!normalizedPhone) {
      return "请输入手机号";
    }

    if (!PHONE_PATTERN.test(normalizedPhone)) {
      return "请输入 11 位有效手机号";
    }

    return "";
  }, [normalizedPhone]);

  const passwordError = useMemo(() => {
    if (!normalizedPassword) {
      return "请输入密码";
    }

    if (normalizedPassword.length < 8) {
      return "密码至少需要 8 位";
    }

    return "";
  }, [normalizedPassword]);

  const isFormValid = !phoneError && !passwordError;
  const canLogin = isFormValid && !submitting;
  const shouldShowPhoneError = Boolean(
    phoneError && (touched.phone || submitAttempted),
  );
  const shouldShowPasswordError = Boolean(
    passwordError && (touched.password || submitAttempted),
  );
  const validationHint = submitting
    ? "正在登录，请稍候"
    : phoneError || passwordError;

  const markTouched = (field: keyof typeof touched) => {
    setTouched((current) => ({
      ...current,
      [field]: true,
    }));
  };

  const finishLogin = (result: LoginResult) => {
    login(result);
    Taro.redirectTo({ url: "/pages/index/index" });
  };

  const tryBindWechat = async () => {
    try {
      const { code } = await Taro.login();
      const result = await bindWechat(code);
      login(result);
    } catch (err) {
      console.warn("Bind wechat skipped:", err);
    }
  };

  const handlePhoneLogin = async () => {
    setSubmitAttempted(true);

    if (!isFormValid) {
      Taro.showToast({ title: validationHint, icon: "none" });
      return;
    }

    try {
      setSubmitting(true);
      Taro.showLoading({ title: "登录中..." });
      const result = await loginByPhone(normalizedPhone, normalizedPassword);
      login(result);

      await tryBindWechat();

      Taro.redirectTo({ url: "/pages/index/index" });
    } catch (err) {
      Taro.showToast({ title: "手机号登录失败", icon: "none" });
      console.error("Phone login failed:", err);
    } finally {
      Taro.hideLoading();
      setSubmitting(false);
    }
  };

  const handleWechatLogin = async () => {
    try {
      setSubmitting(true);
      Taro.showLoading({ title: "微信登录中..." });
      const { code } = await Taro.login();

      const result = await loginByWechat(code);
      finishLogin(result);
    } catch (err) {
      Taro.showToast({ title: "微信登录失败，请先用手机号登录", icon: "none" });
      console.error("Wechat login failed:", err);
    } finally {
      Taro.hideLoading();
      setSubmitting(false);
    }
  };

  return (
    <PageShell>
      <NavBar variant="ghost" showBack={false} capsule="hidden" />

      <View className="relative z-[10] flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* 品牌 hero：左对齐、充足留白；「办」字瓷贴不叠装饰徽章，amber 只留给主行动 */}
        <View className="px-[1.5rem] pb-[1.75rem] pt-[2.25rem]">
          <View
            className={`${appIconTileClass} mb-[1.25rem] h-[3.5rem] w-[3.5rem] text-[1.75rem]`}
          >
            <Text className="leading-none">办</Text>
          </View>
          <Text className="block text-[1.75rem] font-bold leading-[1.2] text-[var(--lb-text-primary)]">
            办伴
          </Text>
          <Text className="mt-[0.5rem] block text-[0.9375rem] leading-[1.5] text-[var(--lb-text-secondary)]">
            和 AI 一起，把事办成
          </Text>
        </View>

        {/* 表单卡：图标瓷贴 + hairline 分区行，与 profile 同一语言 */}
        <View className="px-[1.5rem]">
          <View className={appGlassCardClass}>
            <FieldRow
              icon="user"
              invalid={shouldShowPhoneError}
              error={phoneError}
            >
              <Input
                className="h-full flex-1 text-[1rem] text-[var(--lb-text-primary)]"
                maxlength={11}
                placeholder="请输入手机号"
                placeholderClass="text-[var(--lb-text-muted)]"
                type="number"
                value={phone}
                onBlur={() => markTouched("phone")}
                onInput={(event) => {
                  markTouched("phone");
                  setPhone(event.detail.value);
                }}
              />
            </FieldRow>

            <View className={appHairlineClass} />

            <FieldRow
              icon="lock"
              invalid={shouldShowPasswordError}
              error={passwordError}
            >
              <Input
                className="h-full flex-1 text-[1rem] text-[var(--lb-text-primary)]"
                maxlength={64}
                password
                placeholder="请输入密码"
                placeholderClass="text-[var(--lb-text-muted)]"
                type="text"
                value={password}
                onBlur={() => markTouched("password")}
                onInput={(event) => {
                  markTouched("password");
                  setPassword(event.detail.value);
                }}
              />
            </FieldRow>
          </View>
        </View>

        {/* 行动区：主按钮琥珀渐变是唯一主行动，微信登录为描边次级 */}
        <View className="mt-[1.5rem] px-[1.5rem]">
          <Button
            className={`${loginButtonBaseClass} ${
              isFormValid ? loginButtonEnabledClass : loginButtonDisabledClass
            } ${submitting ? "opacity-80" : ""}`}
            disabled={!canLogin}
            hoverClass={canLogin ? "opacity-90" : "none"}
            loading={submitting}
            onClick={handlePhoneLogin}
          >
            <Text
              className={`text-[1.0625rem] font-semibold leading-none ${
                isFormValid
                  ? "text-[var(--lb-on-accent)]"
                  : "text-[var(--lb-text-muted)]"
              }`}
            >
              {submitting ? "登录中..." : "登 录"}
            </Text>
          </Button>

          {!isFormValid || submitting ? (
            <Text
              className={`mt-[0.625rem] block text-center text-[0.75rem] leading-[1.35] ${
                submitting
                  ? "text-[var(--lb-text-muted)]"
                  : "text-[var(--lb-danger)]"
              }`}
            >
              {validationHint}
            </Text>
          ) : null}

          <Button
            className="mt-[0.875rem] flex h-[3rem] w-full items-center justify-center rounded-[var(--lb-radius-md)] border border-[var(--lb-line-strong)] bg-[var(--lb-surface)] text-[0.9375rem] font-semibold text-[var(--lb-text-secondary)]"
            hoverClass="opacity-80"
            loading={submitting}
            onClick={handleWechatLogin}
          >
            微信一键登录
          </Button>
        </View>

        <Text className="mt-[1.75rem] block px-[1.5rem] pb-[1.5rem] text-center text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]">
          默认使用手机号作为主账号
        </Text>
      </View>
    </PageShell>
  );
}

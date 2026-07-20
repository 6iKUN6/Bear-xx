import { useMemo, useState } from "react";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { bindWechat, loginByPhone, loginByWechat } from "../../api/user";
import NavBar from "../../components/NavBar";
import PageShell from "../../components/PageShell";
import { useUserStore } from "../../store/userStore";
import {
  appGlassCardStrongClass,
  appGradientSurfaceClass,
  appGradientSurfaceWarmClass,
  appGradientTextClass,
  appIconTileClass,
} from "../../utils/style";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

const inputWrapBaseClass =
  "flex h-[3.25rem] items-center rounded-[var(--lb-radius-md)] border bg-[var(--lb-surface)] px-[1rem] transition-colors";
const inputWrapNormalClass = "border-[var(--lb-line-strong)]";
const inputWrapErrorClass =
  "border-[var(--lb-danger)] bg-[var(--lb-danger-soft)]";
const errorTextClass =
  "block text-[0.75rem] leading-[1.35] text-[var(--lb-danger)]";
const fieldHintWrapClass = "mt-[0.375rem] min-h-[1.125rem]";
const loginButtonBaseClass =
  "flex h-[3.25rem] w-full items-center justify-center gap-[0.625rem] rounded-[var(--lb-radius-md)] border-0 transition-all";
const loginButtonEnabledClass = `${appGradientSurfaceClass} shadow-[var(--lb-shadow-glow)]`;
const loginButtonDisabledClass =
  "bg-[var(--lb-surface-hover)] text-[var(--lb-text-muted)] shadow-none";

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
      <NavBar
        title="登录"
        variant="ghost"
        className="shrink-0"
        barClassName="px-[0.5rem]"
      />

      <View className="relative z-[10] flex min-h-0 flex-1 items-center justify-center px-[1.5rem] pb-[1.5rem]">
        <View
          className={`${appGlassCardStrongClass} w-full max-w-[21.25rem] px-[1.5rem] py-[2rem]`}
        >
          <View className="mb-[2rem] flex justify-center">
            <View className="relative">
              <View
                className={`${appIconTileClass} h-[4.75rem] w-[4.75rem] text-[2.5rem]`}
              >
                <Text className="leading-none">🐻</Text>
              </View>
              <View
                className={`${appGradientSurfaceWarmClass} absolute -right-[0.25rem] -top-[0.25rem] flex h-[1.75rem] w-[1.75rem] items-center justify-center rounded-[var(--lb-radius-sm)] text-[0.75rem]`}
              >
                <Text className="leading-none">✦</Text>
              </View>
            </View>
          </View>

          <Text
            className={`${appGradientTextClass} mb-[0.625rem] block text-center text-[1.75rem] font-bold leading-[1.2]`}
          >
            Litter Bear
          </Text>
          <Text className="mb-[1.75rem] block text-center text-[1rem] leading-[1.5] text-[var(--lb-text-secondary)]">
            手机号密码登录后自动绑定微信
          </Text>

          <View className="mb-[0.5rem]">
            <View
              className={`${inputWrapBaseClass} ${
                shouldShowPhoneError
                  ? inputWrapErrorClass
                  : inputWrapNormalClass
              }`}
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
            </View>
            <View className={fieldHintWrapClass}>
              {shouldShowPhoneError ? (
                <Text className={errorTextClass}>{phoneError}</Text>
              ) : null}
            </View>
          </View>

          <View className="mb-[0.875rem]">
            <View
              className={`${inputWrapBaseClass} ${
                shouldShowPasswordError
                  ? inputWrapErrorClass
                  : inputWrapNormalClass
              }`}
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
            </View>
            <View className={fieldHintWrapClass}>
              {shouldShowPasswordError ? (
                <Text className={errorTextClass}>{passwordError}</Text>
              ) : null}
            </View>
          </View>

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
              {submitting ? "登录中..." : "手机号密码登录"}
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
            已绑定微信，直接登录
          </Button>

          <Text className="mt-[1.25rem] block text-center text-[0.75rem] leading-[1.4] text-[var(--lb-text-muted)]">
            默认使用手机号作为主账号
          </Text>
        </View>
      </View>
    </PageShell>
  );
}

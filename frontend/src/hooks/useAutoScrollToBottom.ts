import { useCallback, useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";

interface ScrollDetail {
  deltaY?: number;
  isDrag?: boolean;
  scrollTop: number;
  scrollHeight: number;
}

interface ScrollEvent {
  detail: ScrollDetail;
}

interface UseAutoScrollToBottomOptions {
  enabled?: boolean;
  scrollSignal: string | number;
  isStreaming?: boolean;
  containerId?: string;
  bottomThreshold?: number;
  throttleMs?: number;
}

export function useAutoScrollToBottom({
  enabled = true,
  scrollSignal,
  isStreaming = false,
  containerId = "chat-message-scroll",
  bottomThreshold = 96,
  throttleMs = 120,
}: UseAutoScrollToBottomOptions) {
  const [scrollTop, setScrollTop] = useState<number | undefined>(undefined);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const viewportHeightRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const scrollTopBumpRef = useRef(0);
  const autoScrollEnabledRef = useRef(true);
  const lastScrollAtRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const userScrollIntentRef = useRef(false);
  const userInteractingRef = useRef(false);
  const lastIsAtBottomRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measureViewport = useCallback(() => {
    Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select(`#${containerId}`)
        .boundingClientRect((rect) => {
          if (rect && !Array.isArray(rect) && rect.height) {
            viewportHeightRef.current = rect.height;
          }
        })
        .exec();
    });
  }, [containerId]);

  const scrollToBottom = useCallback(() => {
    Taro.nextTick(() => {
      scrollTopBumpRef.current += 1;
      const nextScrollTop =
        Math.max(lastScrollHeightRef.current, viewportHeightRef.current) +
        100000 +
        scrollTopBumpRef.current;
      setScrollTop(nextScrollTop);
      lastScrollAtRef.current = Date.now();
      programmaticScrollUntilRef.current = Date.now() + 600;
    });
  }, []);

  const scheduleScrollToBottom = useCallback(
    (force = false) => {
      if (!enabled) {
        return;
      }

      if (!force && (!autoScrollEnabledRef.current || userInteractingRef.current)) {
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const elapsed = Date.now() - lastScrollAtRef.current;
      if (force || elapsed >= throttleMs) {
        scrollToBottom();
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        scrollToBottom();
      }, throttleMs - elapsed);
    },
    [enabled, scrollToBottom, throttleMs],
  );

  const handleScroll = useCallback(
    (event: ScrollEvent) => {
      const viewportHeight = viewportHeightRef.current;
      if (!viewportHeight) {
        measureViewport();
        return;
      }

      const { scrollTop, scrollHeight } = event.detail;
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = scrollHeight;
      const distanceToBottom = scrollHeight - scrollTop - viewportHeight;
      const nextIsAtBottom = distanceToBottom <= bottomThreshold;
      const isProgrammaticScroll = Date.now() < programmaticScrollUntilRef.current;
      const hasUserIntent =
        event.detail.isDrag ||
        userInteractingRef.current ||
        userScrollIntentRef.current ||
        (event.detail.deltaY ?? 0) < 0;

      if (!nextIsAtBottom && isProgrammaticScroll && !hasUserIntent) {
        return;
      }

      lastIsAtBottomRef.current = nextIsAtBottom;
      autoScrollEnabledRef.current = nextIsAtBottom;
      setIsAtBottom(nextIsAtBottom);

      if (nextIsAtBottom) {
        userScrollIntentRef.current = false;
      }
    },
    [bottomThreshold, measureViewport],
  );

  const handleUserScrollStart = useCallback(() => {
    userInteractingRef.current = true;
    userScrollIntentRef.current = true;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    autoScrollEnabledRef.current = false;
    setScrollTop(undefined);
  }, []);

  const handleUserScrollEnd = useCallback(() => {
    userInteractingRef.current = false;

    if (lastIsAtBottomRef.current) {
      autoScrollEnabledRef.current = true;
      userScrollIntentRef.current = false;
      setIsAtBottom(true);
    }
  }, []);

  const handleScrollToLower = useCallback(() => {
    lastIsAtBottomRef.current = true;

    if (userInteractingRef.current) {
      setIsAtBottom(true);
      return;
    }

    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    setIsAtBottom(true);
  }, []);

  const restoreAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    userInteractingRef.current = false;
    lastIsAtBottomRef.current = true;
    setIsAtBottom(true);
    scheduleScrollToBottom(true);
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    measureViewport();
  }, [measureViewport]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    scheduleScrollToBottom(!isStreaming);
  }, [enabled, isStreaming, scheduleScrollToBottom, scrollSignal]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return {
    containerId,
    handleScroll,
    handleScrollToLower,
    handleUserScrollEnd,
    handleUserScrollStart,
    isAtBottom,
    restoreAutoScroll,
    scrollTop,
    showScrollToBottom: enabled && !isAtBottom,
  };
}

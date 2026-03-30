import { useEffect, useState } from "react";
import { consumeTabTransition } from "../utils/tabTransition";

export function useTabPageTransition(tabIndex: number) {
  const [className, setClassName] = useState(() => {
    const direction = consumeTabTransition(tabIndex);
    if (direction === "left") return "page-enter-from-left";
    if (direction === "right") return "page-enter-from-right";
    return "";
  });

  useEffect(() => {
    if (!className) return;

    const timer = setTimeout(() => {
      setClassName("");
    }, 360);

    return () => clearTimeout(timer);
  }, [className]);

  return className;
}

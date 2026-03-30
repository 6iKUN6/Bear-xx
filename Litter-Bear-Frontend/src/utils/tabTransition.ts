let pendingTabTransition:
  | {
      from: number;
      to: number;
    }
  | null = null;

export function setPendingTabTransition(from: number, to: number) {
  pendingTabTransition = { from, to };
}

export function consumeTabTransition(target: number): "left" | "right" | null {
  if (!pendingTabTransition || pendingTabTransition.to !== target) {
    return null;
  }

  const direction = pendingTabTransition.from < pendingTabTransition.to
    ? "right"
    : "left";

  pendingTabTransition = null;
  return direction;
}

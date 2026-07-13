import { useSyncExternalStore } from "react";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";

type BoundStore<State> = {
  (): State;
  <Slice>(selector: (state: State) => Slice): Slice;
} & StoreApi<State>;

function bindStore<State>(store: StoreApi<State>): BoundStore<State> {
  const useBoundStore = (<Slice>(selector?: (state: State) => Slice) => {
    const select = selector ?? ((state: State) => state as unknown as Slice);
    return useSyncExternalStore(
      store.subscribe,
      () => select(store.getState()),
      () => select(store.getInitialState())
    );
  }) as BoundStore<State>;

  return Object.assign(useBoundStore, store);
}

export function createBoundStore<State>(
  initializer: StateCreator<State, [], []>
): BoundStore<State> {
  return bindStore(createStore(initializer));
}

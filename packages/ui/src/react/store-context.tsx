import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { AppState, AppStore } from "../store/index.ts";

const StoreContext = createContext<AppStore | undefined>(undefined);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export const useAppStore = (): AppStore => {
  const store = useContext(StoreContext);
  if (store === undefined) throw new Error("useAppStore needs a StoreProvider");
  return store;
};

/** The store, where there is one: a part also drawn on its own (in a test or the gallery) works without it. */
export const useOptionalAppStore = (): AppStore | undefined => useContext(StoreContext);

/** Reads part of the state, and draws again when that part changes. */
export function useAppState<T>(select: (state: AppState) => T): T {
  const store = useAppStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

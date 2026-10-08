// A minimal external store for useSyncExternalStore: leaf components subscribe to one selected value, so a block tick
// re-renders only the components whose value changed (MOBILE_PLAN N2 §3 performance). No dependency needed.
import { useCallback, useSyncExternalStore } from "react";

export type Listener = () => void;

export class Store<T> {
  private listeners = new Set<Listener>();
  constructor(private state: T) {}

  get = (): T => this.state;

  set(next: T): void {
    if (Object.is(next, this.state)) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }

  update(patch: Partial<T>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof T)[]) if (!Object.is(patch[k], this.state[k])) changed = true;
    if (changed) this.set({ ...this.state, ...patch });
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

/** Subscribe to `select(state)`. The selector must return a primitive or a reference stored in the state. */
export function useStore<T, S>(store: Store<T>, select: (s: T) => S): S {
  const get = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, get, get);
}

// Connectivity for the whole app: NetInfo → { online }, and the writes-disabled flag later phases check before any
// transaction or order (MOBILE_PLAN §1.3 "offline banner + disabled writes").
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Store } from "./store";

export type NetworkState = {
  /** undefined until NetInfo's first report */
  online: boolean | undefined;
  type: string | undefined;
};

export const networkStore = new Store<NetworkState>({ online: undefined, type: undefined });

/** isInternetReachable is null while unknown: treat only an explicit false (or no connection) as offline. */
export function toNetworkState(s: Pick<NetInfoState, "isConnected" | "isInternetReachable" | "type">): NetworkState {
  const online = s.isConnected === false || s.isInternetReachable === false ? false : s.isConnected === true ? true : undefined;
  return { online, type: s.type };
}

export function startNetworkWatch(): () => void {
  return NetInfo.addEventListener((s) => {
    const n = toNetworkState(s);
    networkStore.update(n);
  });
}

/** Later phases: block every write while offline. */
export const writesDisabled = (n: NetworkState): boolean => n.online === false;

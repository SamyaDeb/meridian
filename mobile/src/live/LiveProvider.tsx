// Mounts the live layer once for the app: resume on launch / foreground, pause in background (AppState), NetInfo.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { getAppConfig } from "../config";
import { createLive, type Live } from "./live";
import { startNetworkWatch } from "./network";

const LiveContext = createContext<Live | undefined>(undefined);

export function LiveProvider({ children, live: injected }: { children: ReactNode; live?: Live }) {
  const [live] = useState<Live>(() => injected ?? createLive(getAppConfig()));

  useEffect(() => {
    live.resume();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") live.resume();
      else if (s === "background") live.pause();
    });
    const stopNet = startNetworkWatch();
    return () => {
      sub.remove();
      stopNet();
      live.pause();
    };
  }, [live]);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  const l = useContext(LiveContext);
  if (!l) throw new Error("useLive outside <LiveProvider>");
  return l;
}

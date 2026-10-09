import { Redirect } from "expo-router";
import { useAuthState } from "../auth/AuthProvider";

// Launch / anchor route: unlocked → Home; a wallet on this phone → Unlock; nobody yet → Welcome.
export default function Index() {
  const s = useAuthState();
  if (s.status === "loading") return null;
  if (s.status === "unlocked") return <Redirect href="/portfolio" />;
  return <Redirect href={s.hasAccount ? "/unlock" : "/welcome"} />;
}

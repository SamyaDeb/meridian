import { Redirect } from "expo-router";

// No session yet (N3 adds Mera): every launch starts at Welcome.
export default function Index() {
  return <Redirect href="/welcome" />;
}

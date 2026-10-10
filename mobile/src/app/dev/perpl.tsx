// Dev menu route (N4 trade smoke). In release builds __DEV__ is false, Metro inlines it and the require below is
// dropped, so the smoke code isn't in the bundle; the route itself just redirects home.
import { Redirect } from "expo-router";
import type { ComponentType } from "react";

const PerplSmokeScreen: ComponentType | undefined = __DEV__ ? (require("../../features/dev/PerplSmokeScreen") as { default: ComponentType }).default : undefined;

export default function PerplSmoke() {
  return PerplSmokeScreen ? <PerplSmokeScreen /> : <Redirect href="/" />;
}

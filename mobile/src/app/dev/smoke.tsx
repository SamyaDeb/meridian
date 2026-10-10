// Dev menu route. In release builds __DEV__ is false, Metro inlines it and the require below is dropped, so the smoke
// code isn't in the bundle; the route itself just redirects home.
import { Redirect } from "expo-router";
import type { ComponentType } from "react";

const SmokeScreen: ComponentType | undefined = __DEV__ ? (require("../../features/dev/SmokeScreen") as { default: ComponentType }).default : undefined;

export default function Smoke() {
  return SmokeScreen ? <SmokeScreen /> : <Redirect href="/" />;
}

// Entry: the polyfills must run before anything imports viem / noble (MOBILE_PLAN N2, expo-native-app §2).
import "./polyfills";
import "expo-router/entry";

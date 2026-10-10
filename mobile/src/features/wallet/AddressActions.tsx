// Copy / Share the address (expo-clipboard, RN Share). The address is public; copying or sharing it is always fine.
import * as Clipboard from "expo-clipboard";
import { Share, StyleSheet, View } from "react-native";
import { Button, haptic, space, useToast } from "../../ui";

export function AddressActions({ address }: { address: string }) {
  const toast = useToast();
  return (
    <View style={s.row}>
      <Button
        title="Copy address"
        variant="secondary"
        style={s.grow}
        onPress={() =>
          void Clipboard.setStringAsync(address).then(
            () => {
              haptic.selection();
              toast("Address copied", "success");
            },
            () => toast("Couldn't copy", "error"),
          )
        }
        testID="btn-copy"
      />
      <Button title="Share" variant="secondary" style={s.grow} accessibilityHint="Shares your wallet address" onPress={() => void Share.share({ message: address }).catch(() => undefined)} testID="btn-share" />
    </View>
  );
}

const s = StyleSheet.create({ row: { flexDirection: "row", gap: space.m, flexWrap: "wrap" }, grow: { flexGrow: 1 } });

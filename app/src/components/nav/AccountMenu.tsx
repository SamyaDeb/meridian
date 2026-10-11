"use client";
import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import dynamic from "next/dynamic";
import { Popover } from "@/components/ds";
import { ConnectButton } from "@/components/Wallet";
import { readChain } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";
import { privyEnabled } from "@/lib/privy";
import { meraEnabled } from "@/lib/mera/config";
import { PASSKEY_CONNECTOR_TYPE } from "@/lib/mera/connector";

const PrivyAccountActions = privyEnabled ? dynamic(() => import("@/components/PrivyControls").then((m) => m.PrivyAccountActions)) : null;
const passkey = meraEnabled
  ? {
      Actions: dynamic(() => import("@/components/PasskeyControls").then((m) => m.PasskeyAccountActions)),
      Lifecycle: dynamic(() => import("@/components/PasskeyControls").then((m) => m.PasskeyLifecycle)),
      PhraseDialog: dynamic(() => import("@/components/PasskeyControls").then((m) => m.RecoveryPhraseDialog)),
    }
  : null;

export const item = "flex min-h-10 w-full items-center rounded-control px-3 text-left text-sm hover:bg-card-2 pointer-coarse:min-h-11";

/** Address pill → copy, explorer (viem's chain record; none ⇒ no link), then export wallet (embedded, Privy) + log out,
 *  the passkey wallet's phrase / lock / forget (W1), or disconnect without Privy. Not connected ⇒ connect / log in. */
export function AccountMenu() {
  const [phrase, setPhrase] = useState<string>();
  return (
    <>
      {passkey && <passkey.Lifecycle />}
      <AccountPill onPhrase={setPhrase} />
      {passkey && <passkey.PhraseDialog phrase={phrase} onClose={() => setPhrase(undefined)} />}
    </>
  );
}

function AccountPill({ onPhrase }: { onPhrase: (phrase: string) => void }) {
  const { isConnected, address, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);
  if (!isConnected || !address) return <ConnectButton />;
  const explorer = readChain().chain.blockExplorers?.default.url;
  const isPasskey = connector?.type === PASSKEY_CONNECTOR_TYPE;
  return (
    <Popover
      label="Account"
      triggerClassName="num inline-flex h-9 items-center gap-2 rounded-full bg-card-2 px-3 text-xs hover:bg-border pointer-coarse:h-11"
      trigger={
        <>
          <span className="h-2 w-2 rounded-full bg-brand" aria-hidden />
          {shortAddress(address)}
        </>
      }
    >
      {(close) => (
        <div className="space-y-1">
          <p className="num break-all px-3 py-2 text-[11px] text-muted">{address}</p>
          {isPasskey && <p className="px-3 pb-1 text-[11px] text-muted">Passkey wallet · pays its own gas in MON</p>}
          <button
            type="button"
            className={item}
            onClick={() => {
              try {
                void navigator.clipboard.writeText(address).then(() => setCopied(true));
              } catch {
                /* clipboard unavailable (insecure context): the full address is shown above */
              }
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          {explorer && (
            <a className={item} href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" onClick={close}>
              View on explorer ↗
            </a>
          )}
          {isPasskey && passkey ? (
            <passkey.Actions onDone={close} onPhrase={onPhrase} />
          ) : PrivyAccountActions ? (
            <PrivyAccountActions onDone={close} />
          ) : (
            <button
              type="button"
              className={`${item} text-short`}
              onClick={() => {
                disconnect();
                close();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}


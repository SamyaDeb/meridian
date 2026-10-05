"use client";
import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import dynamic from "next/dynamic";
import { Popover } from "@/components/ds";
import { ConnectButton } from "@/components/Wallet";
import { readChain } from "@/lib/wagmi";
import { shortAddress } from "@/lib/format";
import { privyEnabled } from "@/lib/privy";

const PrivyLogout = privyEnabled ? dynamic(() => import("@/components/PrivyControls").then((m) => m.PrivyLogout)) : null;

export const item = "flex min-h-10 w-full items-center rounded-control px-3 text-left text-sm hover:bg-card-2 pointer-coarse:min-h-11";

/** Address pill → copy, explorer (viem's chain record; none ⇒ no link), disconnect. Not connected ⇒ connect button. */
export function AccountMenu() {
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);
  if (!isConnected || !address) return <ConnectButton />;
  const explorer = readChain().chain.blockExplorers?.default.url;
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
          {PrivyLogout ? (
            <PrivyLogout onDone={close} />
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


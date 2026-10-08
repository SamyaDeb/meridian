// Perpl Exchange ABI: only the entries core uses, copied verbatim from indexer/abis/PerplExchange.json (dex-sdk @ dbb37c5,
// deployments/perpl.json "abi"). `as const` so viem types the calls; test/perpl-abi.test.ts asserts each entry still equals
// the vendored JSON.
export const perplExchangeAbi = [
  {
    "type": "function",
    "name": "allowOrderForwarding",
    "inputs": [
      {
        "name": "allow",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createAccount",
    "inputs": [
      {
        "name": "amountCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "depositCollateral",
    "inputs": [
      {
        "name": "amountCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getAccountByAddr",
    "inputs": [
      {
        "name": "accountAddress",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "accountInfo",
        "type": "tuple",
        "internalType": "struct AccountInfo",
        "components": [
          {
            "name": "accountId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "balanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lockedBalanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "frozen",
            "type": "uint8",
            "internalType": "enum FreezeStatusEnum"
          },
          {
            "name": "accountAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "positions",
            "type": "tuple",
            "internalType": "struct PositionBitMap",
            "components": [
              {
                "name": "bank1",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank2",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank3",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank4",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getFundingSumAtBlock",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "blockNumber",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "fundingSumPNS",
        "type": "int48",
        "internalType": "int48"
      },
      {
        "name": "fundingEventBlock",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getMakerFee",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getMarginFractions",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "perpInitMarginFracHdths",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "perpMaintMarginFracHdths",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "dynamicInitMarginFracHdths",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "oiMaxLNS",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "unityDescentThreshHdths",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "overColDescentThreshHdths",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getMinAccountOpenCNS",
    "inputs": [],
    "outputs": [
      {
        "name": "minAccountOpenCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPositionV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "positionInfo",
        "type": "tuple",
        "internalType": "struct PositionInfoV2",
        "components": [
          {
            "name": "accountId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nextNodeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "prevNodeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "positionType",
            "type": "uint8",
            "internalType": "enum PositionEnum"
          },
          {
            "name": "depositCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "entryBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pnlCNS",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "deltaPnlCNS",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "premiumPnlCNS",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "priceResiduePNSQ16",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "markPriceValid",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTakerFee",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "OrderForwardingUpdated",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  }
] as const;

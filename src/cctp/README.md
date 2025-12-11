# CCTP V2 Relayer

Offchain component for completing CCTP V2 cross-chain USDC transfers initiated by `AaveCctpBridge`.

## Overview

CCTP V2 requires an offchain step between burning on the source chain and minting on the destination chain:

1. **Source Chain**: `AaveCctpBridge.bridge()` burns USDC and emits a `Bridge` event
2. **Offchain**: This relayer fetches the attestation from Circle's API
3. **Destination Chain**: Calls `MessageTransmitterV2.receiveMessage()` to mint USDC

## Setup

Dependencies are managed at the repository root level. Run from the repository root:

```bash
yarn install
```

## Usage

### Complete a Specific Transfer

```bash
PRIVATE_KEY=0x... \
SOURCE_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/... \
DEST_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/... \
npx tsx src/cctp/cctp-relayer.ts --tx 0xBurnTxHash --source 1 --dest 42161
```

### Watch and Auto-Relay

```bash
PRIVATE_KEY=0x... \
SOURCE_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/... \
DEST_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/... \
npx tsx src/cctp/cctp-relayer.ts --watch 0xBridgeContractAddress --source 1 --dest 42161
```

## Options

| Option | Description |
|--------|-------------|
| `--tx` | Burn transaction hash to complete |
| `--watch` | Bridge contract address to watch for events |
| `--source` | Source chain ID (e.g., 1 for Ethereum) |
| `--dest` | Destination chain ID (e.g., 42161 for Arbitrum) |
| `--testnet` | Use testnet API (default: false) |
| `--interval` | Polling interval in ms (default: 5000) |
| `--retries` | Max attestation retries (default: 60) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Private key for signing destination chain transactions |
| `SOURCE_RPC_URL` | RPC URL for the source chain |
| `DEST_RPC_URL` | RPC URL for the destination chain |

## CCTP Domain Mapping

| Chain | Chain ID | CCTP Domain |
|-------|----------|-------------|
| Ethereum | 1 | 0 |
| Avalanche | 43114 | 1 |
| Optimism | 10 | 2 |
| Arbitrum | 42161 | 3 |
| Base | 8453 | 6 |
| Polygon | 137 | 7 |
| Linea | 59144 | 11 |

## How It Works

1. **Fetch Attestation**: Polls Circle's attestation API (`/v2/messages/{domain}?transactionHash={hash}`) until the attestation is ready
2. **Receive Message**: Calls `receiveMessage(message, attestation)` on the destination chain's `MessageTransmitterV2` contract
3. **Mint USDC**: The destination chain mints USDC to the recipient specified in the original burn

## Attestation Timing

- **Fast Transfer** (finality threshold 1000): ~30 seconds
- **Standard Transfer** (finality threshold 2000): 15-19 minutes for Ethereum/L2s

## API Endpoints

- Mainnet: `https://iris-api.circle.com`
- Testnet: `https://iris-api-sandbox.circle.com`

## Security Notes

- The relayer wallet only needs enough native tokens for gas on the destination chain
- The relayer does not need access to USDC

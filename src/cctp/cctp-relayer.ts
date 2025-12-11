import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  decodeEventLog,
  pad,
  toHex,
  PublicClient,
  WalletClient,
  Chain,
  Hex,
  TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, PrivateKeyAccount } from 'viem/accounts';
import {
  mainnet,
  optimism,
  arbitrum,
  polygon,
  avalanche,
  base,
  linea,
} from 'viem/chains';

// Default configuration
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRIES = 60;
const FETCH_TIMEOUT_MS = 30000;

// CCTP Domain IDs (from Circle docs)
// https://developers.circle.com/cctp/cctp-supported-blockchains
export const CCTP_DOMAINS: Record<number, number> = {
  1: 0, // Ethereum Mainnet
  10: 2, // Optimism
  42161: 3, // Arbitrum
  137: 7, // Polygon
  43114: 1, // Avalanche
  8453: 6, // Base
  59144: 11, // Linea
  130: 12, // Codex
  146: 13, // Sonic
  480: 14, // World Chain
  1301: 15, // Unichain Testnet
  534352: 16, // Sei
  56: 17, // BNB Smart Chain
  50: 18, // XDC
  999: 19, // HyperEVM
  57073: 21, // Ink
  98866: 22, // Plume
};

// Chain ID to viem chain mapping
const CHAIN_CONFIG: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  42161: arbitrum,
  137: polygon,
  43114: avalanche,
  8453: base,
  59144: linea,
};

// Circle Attestation API hosts
const ATTESTATION_API = {
  mainnet: 'https://iris-api.circle.com',
  testnet: 'https://iris-api-sandbox.circle.com',
} as const;

// MessageTransmitterV2 ABI (minimal for receiveMessage)
const MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) external returns (bool success)',
  'function usedNonces(bytes32 nonce) external view returns (uint256)',
]);

// AaveCctpBridge Bridge event ABI
const BRIDGE_EVENT_ABI = parseAbi([
  'event Bridge(address indexed token, uint32 indexed destinationDomain, address indexed receiver, uint256 amount, uint64 nonce, uint8 speed)',
]);

// MessageTransmitterV2 contract address (same for all EVM chains on mainnet)
// Source: https://developers.circle.com/cctp/evm-smart-contracts
export const MESSAGE_TRANSMITTER_V2_ADDRESS = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as const;

// Supported domains for MessageTransmitterV2
export const SUPPORTED_DOMAINS = new Set([0, 1, 2, 3, 6, 7, 10, 11]);

export interface CctpRelayerConfig {
  privateKey: Hex;
  sourceRpcUrl: string;
  destRpcUrl: string;
  sourceChainId: number;
  destChainId: number;
  sourceDomain: number;
  destDomain: number;
  isTestnet?: boolean;
  pollIntervalMs?: number;
  maxRetries?: number;
}

interface DecodedMessageBody {
  amount?: string;
  mintRecipient?: string;
}

interface DecodedMessage {
  decodedMessageBody?: DecodedMessageBody;
}

interface AttestationMessage {
  status: string;
  attestation?: string;
  message?: string;
  eventNonce?: string;
  decodedMessage?: DecodedMessage;
}

interface AttestationResponse {
  messages?: AttestationMessage[];
}

export interface AttestationData {
  message: string;
  attestation: string;
  nonce: string;
  decodedMessage?: DecodedMessage;
  alreadyReceived: boolean;
}

interface ReceiveMessageResult {
  receipt: TransactionReceipt | null;
  alreadyReceived: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isValidTxHash(txHash: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(txHash);
}

function getChainConfig(chainId: number): Chain {
  return CHAIN_CONFIG[chainId] || ({ id: chainId } as Chain);
}

export class CctpRelayer {
  private sourceClient: PublicClient;
  private destPublicClient: PublicClient;
  private destWalletClient: WalletClient;
  private account: PrivateKeyAccount;
  private attestationApiHost: string;
  private sourceDomain: number;
  private destDomain: number;
  private pollIntervalMs: number;
  private maxRetries: number;

  constructor(config: CctpRelayerConfig) {
    const sourceChain = getChainConfig(config.sourceChainId);
    const destChain = getChainConfig(config.destChainId);

    this.sourceClient = createPublicClient({
      chain: sourceChain,
      transport: http(config.sourceRpcUrl),
    });

    this.destPublicClient = createPublicClient({
      chain: destChain,
      transport: http(config.destRpcUrl),
    });

    const account = privateKeyToAccount(config.privateKey);
    this.destWalletClient = createWalletClient({
      account,
      chain: destChain,
      transport: http(config.destRpcUrl),
    });

    this.account = account;
    this.attestationApiHost = config.isTestnet
      ? ATTESTATION_API.testnet
      : ATTESTATION_API.mainnet;
    this.sourceDomain = config.sourceDomain;
    this.destDomain = config.destDomain;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

    this._validateConfig();
  }

  private _validateConfig(): void {
    if (!SUPPORTED_DOMAINS.has(this.destDomain)) {
      console.warn(`Warning: Domain ${this.destDomain} may not be supported for MessageTransmitterV2`);
    }
  }

  private _getTransmitterAddress(): Hex | null {
    if (!SUPPORTED_DOMAINS.has(this.destDomain)) {
      return null;
    }
    return MESSAGE_TRANSMITTER_V2_ADDRESS;
  }

  async fetchAttestation(txHash: string): Promise<AttestationData> {
    const url = `${this.attestationApiHost}/v2/messages/${this.sourceDomain}?transactionHash=${txHash}`;

    console.log(`Fetching attestation from: ${url}`);

    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`API returned status ${response.status}`);
        }

        const data: AttestationResponse = await response.json();

        if (data.messages && data.messages.length > 0) {
          const msg = data.messages[0];

          if (msg.status === 'complete' && msg.attestation && msg.message && msg.eventNonce) {
            console.log(`Attestation received for nonce: ${msg.eventNonce}`);

            const alreadyReceived = await this.isNonceUsed(msg.eventNonce);

            return {
              message: msg.message,
              attestation: msg.attestation,
              nonce: msg.eventNonce,
              decodedMessage: msg.decodedMessage,
              alreadyReceived,
            };
          }

          console.log(
            `Attestation status: ${msg.status}, waiting... (${retries + 1}/${this.maxRetries})`
          );
        } else {
          console.log(
            `No messages found yet, waiting... (${retries + 1}/${this.maxRetries})`
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error fetching attestation: ${errorMessage}`);
      }

      await sleep(this.pollIntervalMs);
      retries++;
    }

    throw new Error(
      `Failed to get attestation after ${this.maxRetries} retries`
    );
  }

  async isNonceUsed(nonce: string): Promise<boolean> {
    const transmitterAddress = this._getTransmitterAddress();

    if (!transmitterAddress) {
      console.log(`  No transmitter address for domain ${this.destDomain}`);
      return false;
    }

    try {
      const nonceAsBytes32 = pad(toHex(BigInt(nonce)), { size: 32 });
      console.log(`  Checking if nonce ${nonce} (${nonceAsBytes32}) is used on ${transmitterAddress}...`);
      const usedNonce = await this.destPublicClient.readContract({
        address: transmitterAddress,
        abi: MESSAGE_TRANSMITTER_V2_ABI,
        functionName: 'usedNonces',
        args: [nonceAsBytes32],
      });

      console.log(`  usedNonces result: ${usedNonce}`);
      return usedNonce > 0n;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`  Error checking nonce: ${errorMessage}`);
      return false;
    }
  }

  async receiveMessage(message: string, attestation: string, nonce: string): Promise<ReceiveMessageResult> {
    const transmitterAddress = this._getTransmitterAddress();

    if (!transmitterAddress) {
      throw new Error(
        `Unsupported destination domain: ${this.destDomain}. Supported domains: ${[...SUPPORTED_DOMAINS].join(', ')}`
      );
    }

    console.log(`Calling receiveMessage on ${transmitterAddress}...`);

    try {
      const { request } = await this.destPublicClient.simulateContract({
        address: transmitterAddress,
        abi: MESSAGE_TRANSMITTER_V2_ABI,
        functionName: 'receiveMessage',
        args: [message as Hex, attestation as Hex],
        account: this.account,
      });

      const hash = await this.destWalletClient.writeContract(request);
      console.log(`Transaction submitted: ${hash}`);

      const receipt = await this.destPublicClient.waitForTransactionReceipt({
        hash,
      });
      console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

      return { receipt, alreadyReceived: false };
    } catch (error) {
      const isNonceUsed = await this.isNonceUsed(nonce);
      if (isNonceUsed) {
        console.log(`\nMessage already received on destination chain (nonce used).`);
        return { receipt: null, alreadyReceived: true };
      }
      throw error;
    }
  }

  async completeTransfer(burnTxHash: string): Promise<{ attestation: AttestationData; receipt: TransactionReceipt | null }> {
    console.log(`\nCompleting CCTP transfer for tx: ${burnTxHash}`);
    console.log(
      `Source domain: ${this.sourceDomain}, Dest domain: ${this.destDomain}`
    );

    console.log('\n[Step 1] Fetching attestation from Circle API...');
    const attestationData = await this.fetchAttestation(burnTxHash);

    console.log('\nAttestation details:');
    console.log(`  Nonce: ${attestationData.nonce}`);
    if (attestationData.decodedMessage) {
      const decoded = attestationData.decodedMessage;
      console.log(`  Amount: ${decoded.decodedMessageBody?.amount}`);
      console.log(`  Recipient: ${decoded.decodedMessageBody?.mintRecipient}`);
    }

    if (attestationData.alreadyReceived) {
      console.log('\nTransfer already completed on destination chain!');
      console.log('  Nonce has been used - skipping receiveMessage call.');
      return { attestation: attestationData, receipt: null };
    }

    console.log('\n[Step 2] Submitting receiveMessage on destination chain...');
    const result = await this.receiveMessage(
      attestationData.message,
      attestationData.attestation,
      attestationData.nonce
    );

    if (result.alreadyReceived) {
      console.log('\nTransfer was already completed on destination chain!');
      return { attestation: attestationData, receipt: null };
    }

    console.log('\nTransfer completed successfully!');
    console.log(`  Destination tx: ${result.receipt!.transactionHash}`);

    return { attestation: attestationData, receipt: result.receipt };
  }

  async watchAndRelay(bridgeAddress: Hex): Promise<void> {
    console.log(`\nWatching for Bridge events on ${bridgeAddress}...`);

    const unwatch = this.sourceClient.watchEvent({
      address: bridgeAddress,
      event: BRIDGE_EVENT_ABI[0],
      onLogs: async (logs) => {
        for (const log of logs) {
          try {
            const decoded = decodeEventLog({
              abi: BRIDGE_EVENT_ABI,
              data: log.data,
              topics: log.topics,
            });

            console.log(`\nBridge event detected!`);
            console.log(`  Token: ${decoded.args.token}`);
            console.log(`  Destination: ${decoded.args.destinationDomain}`);
            console.log(`  Receiver: ${decoded.args.receiver}`);
            console.log(`  Amount: ${decoded.args.amount}`);
            console.log(`  Nonce: ${decoded.args.nonce}`);
            console.log(
              `  Speed: ${decoded.args.speed === 0 ? 'Fast' : 'Standard'}`
            );

            await this.completeTransfer(log.transactionHash);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Error processing Bridge event: ${errorMessage}`);
          }
        }
      },
    });

    console.log('Relayer is running. Press Ctrl+C to stop.');

    process.on('SIGINT', () => {
      console.log('\nStopping relayer...');
      unwatch();
      process.exit(0);
    });

    await new Promise(() => {});
  }
}

export function getDomainFromChainId(chainId: number): number {
  const domain = CCTP_DOMAINS[chainId];
  if (domain === undefined) {
    throw new Error(`Unknown chain ID: ${chainId}`);
  }
  return domain;
}

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];
    parsed[key] = value;
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }
  if (!process.env.SOURCE_RPC_URL) {
    throw new Error('SOURCE_RPC_URL environment variable is required');
  }
  if (!process.env.DEST_RPC_URL) {
    throw new Error('DEST_RPC_URL environment variable is required');
  }

  const sourceChainId = parseInt(args.source);
  const destChainId = parseInt(args.dest);

  if (!sourceChainId || !destChainId) {
    throw new Error('--source and --dest chain IDs are required');
  }

  let privateKey = process.env.PRIVATE_KEY;
  if (!privateKey.startsWith('0x')) {
    privateKey = `0x${privateKey}`;
  }

  const config: CctpRelayerConfig = {
    privateKey: privateKey as Hex,
    sourceRpcUrl: process.env.SOURCE_RPC_URL,
    destRpcUrl: process.env.DEST_RPC_URL,
    sourceChainId,
    destChainId,
    sourceDomain: getDomainFromChainId(sourceChainId),
    destDomain: getDomainFromChainId(destChainId),
    isTestnet: args.testnet === 'true',
    pollIntervalMs: parseInt(args.interval) || 5000,
    maxRetries: parseInt(args.retries) || 60,
  };

  const relayer = new CctpRelayer(config);

  if (args.tx) {
    if (!isValidTxHash(args.tx)) {
      throw new Error(`Invalid transaction hash format: ${args.tx}`);
    }
    await relayer.completeTransfer(args.tx);
  } else if (args.watch) {
    await relayer.watchAndRelay(args.watch as Hex);
  } else {
    console.log('CCTP V2 Relayer - See README.md for usage instructions');
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});

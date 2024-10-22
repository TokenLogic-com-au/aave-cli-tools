import { Command } from '@commander-js/extra-typings';

import type { Log } from '@ethersproject/providers';

import { providers, Wallet, Contract } from 'ethers';
import { defaultAbiCoder, id, keccak256 } from 'ethers/lib/utils';
import { AttestationStatus, getAttestation } from '../utils/cctpAttestationService';

const MESSAGE_EVENT_TYPE = 'MessageSent(bytes)';
const MessageTransmitterAbi = [
  {
    inputs: [
      {
        internalType: 'bytes',
        name: 'message',
        type: 'bytes',
      },
      {
        internalType: 'bytes',
        name: 'attestation',
        type: 'bytes',
      },
    ],
    name: 'receiveMessage',
    outputs: [
      {
        internalType: 'bool',
        name: 'success',
        type: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const TransmitterAddress: Record<number, string> = {
  0: '0x0a992d191deec32afe36203ad87d7d289a738f81',
  1: '0x8186359af5f57fbb40c6b14a588d2a59c0c29880',
  2: '0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8',
  3: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
  6: '0xAD09780d193884d503182aD4588450C416D6F9D4',
  7: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
};

const NetworkToDomain: Record<string, number> = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  base: 6,
  polygon: 7,
};

const DomainToProvider: Record<number, providers.JsonRpcProvider> = {
  0: new providers.JsonRpcProvider(process.env.RPC_MAINNET),
  1: new providers.JsonRpcProvider(process.env.RPC_AVALANCHE),
  2: new providers.JsonRpcProvider(process.env.RPC_OPTIMISM),
  3: new providers.JsonRpcProvider(process.env.RPC_ARBITRUM),
  6: new providers.JsonRpcProvider(process.env.RPC_BASE),
  7: new providers.JsonRpcProvider(process.env.RPC_POLYGON),
};

function getPrivateKey() {
  return process.env.PRIVATE_KEY ?? '';
}

function getMessageBytesFromEventLogs(logs: Log[], topic: string): string {
  const eventTopic = id(topic);
  const log = logs.filter((l) => l.topics[0] === eventTopic)[0];
  return defaultAbiCoder.decode(['bytes'], log.data)[0];
}

function getMessageHashFromBytes(message: string): string {
  return keccak256(message);
}

function stall(duration: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}

function getDestinationDomain(message: string) {
  const destinationDomain = +message.replace('0x', '').slice(16, 24);
  return destinationDomain;
}

export function addCommand(program: Command) {
  program
    .command('cctp-bridge-finalize')
    .description('finalize cctp bridge transaction')
    .argument('<from_network>', 'The name of from network')
    .argument('<tx_hash>', 'Transaction hash on sending network')
    .action(async (from_network, tx_hash) => {
      const fromDomain = NetworkToDomain[from_network];

      if (fromDomain == undefined) {
        throw Error(`from_network is invalid, it should be in ${Object.keys(NetworkToDomain).join(', ')}`);
      }

      const fromProvider = DomainToProvider[fromDomain];

      console.log('Decoding send transaction');
      await fromProvider.waitForTransaction(tx_hash);
      const sendTxReceipt = await fromProvider.getTransactionReceipt(tx_hash);
      const message = getMessageBytesFromEventLogs(sendTxReceipt.logs, MESSAGE_EVENT_TYPE);
      const messageHash = getMessageHashFromBytes(message);

      let attestation;
      console.log('Waiting for message to get attestation...');
      while (true) {
        attestation = await getAttestation(messageHash);

        if (!attestation) {
          throw Error(`Message not found`);
        }

        if (attestation?.status == AttestationStatus.complete) {
          break;
        }

        await stall(5000);
      }

      console.log('Receiving USDC...');
      const destinationDomain = getDestinationDomain(message);
      const signer = new Wallet(getPrivateKey(), DomainToProvider[destinationDomain]);
      const messageTransmitter = new Contract(TransmitterAddress[destinationDomain], MessageTransmitterAbi, signer);
      try {
        console.log(message, attestation.message);
        const tx = await messageTransmitter.receiveMessage(message, attestation.message);
        console.log('Receiving message transaction:', tx.hash);
      } catch (err) {
        console.log(err);
        throw err;
      }
    });
}

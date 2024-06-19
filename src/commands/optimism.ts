
import { Command } from '@commander-js/extra-typings';

import { CrossChainMessenger, MessageStatus } from '@eth-optimism/sdk';
import { providers, Wallet } from 'ethers';

function getMessenger() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY ?? '';
          const L1_CHAIN_ID = 1;
          const L2_CHAIN_ID = 10;

          const l1_provider = new providers.StaticJsonRpcProvider(process.env.RPC_MAINNET);
          const l2_provider = new providers.StaticJsonRpcProvider(process.env.RPC_OPTIMISM);
          const l1_wallet = new Wallet(PRIVATE_KEY, l1_provider);
          const l2_wallet = new Wallet(PRIVATE_KEY, l2_provider);

          const messenger = new CrossChainMessenger({
            l1ChainId: L1_CHAIN_ID,
            l2ChainId: L2_CHAIN_ID,
            l1SignerOrProvider: l1_wallet,
            l2SignerOrProvider: l2_wallet,
          });

          return messenger;
}

export function addCommand(program: Command) {
  program
        .command('optimism-prove-message')
        .description('prove optimism transaction to confirm bridge')
        .argument('<tx_hash>')
        .argument('<log_index>')
        .action(async (tx_hash, log_index) => {
          const messenger = getMessenger();

          console.log('Waiting for message to be READY_TO_PROVE');

          await messenger.waitForMessageStatus(tx_hash, MessageStatus.READY_TO_PROVE);
          await messenger.proveMessage(tx_hash, {}, Number(log_index));
        });

        program
        .command('optimism-finalize-bridge')
        .description('finalizes optimism transaction to bridge')
        .argument('<tx_hash>')
        .argument('<log_index>')
        .action(async (tx_hash, log_index) => {
          const messenger = getMessenger();

          console.log('Waiting for message to be READY_FOR_RELAY');

          await messenger.waitForMessageStatus(tx_hash, MessageStatus.READY_FOR_RELAY);
          await messenger.finalizeMessage(tx_hash, {}, Number(log_index));

          console.log('Waiting for message to be RELAYED');

          await messenger.waitForMessageStatus(tx_hash, MessageStatus.RELAYED);
        });
}

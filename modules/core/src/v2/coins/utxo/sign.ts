/**
 * @prettier
 */
import * as bip32 from 'bip32';
import * as utxolib from '@bitgo/utxo-lib';
import * as debugLib from 'debug';

import { Triple } from '../../triple';

import { DerivedWalletKeys, eqPublicKey, RootWalletKeys, WalletKeys } from './WalletKeys';
import { isReplayProtectionUnspent, toOutput, Unspent, WalletUnspent } from './unspent';

const debug = debugLib('bitgo:v2:utxo');

export class WalletUnspentSigner<T extends WalletKeys> {
  public readonly walletKeys: T;
  constructor(
    walletKeys: WalletKeys | Triple<bip32.BIP32Interface>,
    public signer: bip32.BIP32Interface,
    public cosigner: bip32.BIP32Interface
  ) {
    if (Array.isArray(walletKeys)) {
      walletKeys = new RootWalletKeys(walletKeys);
    }
    if (!walletKeys.triple.some((k) => eqPublicKey(k, signer))) {
      throw new Error(`signer not part of walletKeys`);
    }
    if (!walletKeys.triple.some((k) => eqPublicKey(k, cosigner))) {
      throw new Error(`cosigner not part of walletKeys`);
    }

    this.walletKeys = walletKeys as T;

    if (eqPublicKey(signer, cosigner)) {
      throw new Error(`signer must not equal cosigner`);
    }
    if (signer.isNeutered()) {
      throw new Error(`signer must have private key`);
    }
  }

  deriveForUnspent(chain: number, index: number): WalletUnspentSigner<DerivedWalletKeys> {
    if (this.walletKeys instanceof DerivedWalletKeys) {
      throw new Error(`cannot derive again from DerivedWalletKeys`);
    }

    if (this.walletKeys instanceof RootWalletKeys) {
      return new WalletUnspentSigner(
        this.walletKeys.deriveForChainAndIndex(chain, index),
        this.signer.derivePath(this.walletKeys.getDerivationPath(this.signer, chain, index)),
        this.cosigner.derivePath(this.walletKeys.getDerivationPath(this.cosigner, chain, index))
      );
    }

    throw new Error(`invalid state`);
  }
}

/**
 * Create utxo transaction input signature for a wallet unspent.
 * Derives keys, compares scripts and throws error on mismatch.
 *
 * @param txBuilder
 * @param inputIndex
 * @param unspent
 * @param walletSigner
 */
export function signWalletTransactionWithUnspent(
  txBuilder: utxolib.bitgo.UtxoTransactionBuilder,
  inputIndex: number,
  unspent: WalletUnspent,
  walletSigner: WalletUnspentSigner<RootWalletKeys>
): void {
  const { walletKeys, signer, cosigner } = walletSigner.deriveForUnspent(unspent.chain, unspent.index);
  const scriptType = utxolib.bitgo.outputScripts.scriptTypeForChain(unspent.chain);
  const pubScript = utxolib.bitgo.outputScripts.createOutputScript2of3(walletKeys.publicKeys, scriptType).scriptPubKey;
  const pubScriptExpected = utxolib.address.toOutputScript(unspent.address, txBuilder.network as utxolib.Network);
  if (!pubScript.equals(pubScriptExpected)) {
    throw new Error(
      `pubscript mismatch: expected ${pubScriptExpected.toString('hex')} got ${pubScript.toString('hex')}`
    );
  }
  utxolib.bitgo.signInput2Of3(
    txBuilder,
    inputIndex,
    scriptType,
    walletKeys.publicKeys,
    signer,
    cosigner.publicKey,
    unspent.value
  );
}

export class InputSigningError extends Error {
  constructor(public inputIndex: number, public unspent: Unspent, public reason: Error | string) {
    super(`signing error at input ${inputIndex}: unspentId=${unspent.id}: ${reason}`);
  }
}

export class TransactionSigningError extends Error {
  constructor(signErrors: InputSigningError[], verifyError: InputSigningError[]) {
    super(
      `sign errors at inputs: [${signErrors.join(',')}], ` +
        `verify errors at inputs: [${verifyError.join(',')}], see log for details`
    );
  }
}

/**
 * Sign all inputs of a wallet transaction and verify signatures after signing.
 * Collects and logs signing errors and verification errors, throws error in the end if any of them
 * failed.
 *
 * @param transaction - wallet transactions to be signed
 * @param unspents - transaction unspents
 * @param walletSigner - signing parameters
 * @param isLastSignature - Returns full-signed transaction when true. Builds half-signed when false.
 */
export function signAndVerifyWalletTransaction(
  transaction: utxolib.bitgo.UtxoTransaction,
  unspents: Unspent[],
  walletSigner: WalletUnspentSigner<RootWalletKeys>,
  { isLastSignature }: { isLastSignature: boolean }
): utxolib.Transaction {
  if (transaction.ins.length !== unspents.length) {
    throw new Error(`transaction inputs must match unspents`);
  }
  const prevOutputs = unspents.map((u) => toOutput(u, transaction.network));
  const txBuilder = utxolib.bitgo.createTransactionBuilderFromTransaction(transaction, prevOutputs);

  const signErrors: InputSigningError[] = unspents
    .map((unspent: Unspent, inputIndex: number) => {
      try {
        if (isReplayProtectionUnspent(unspent, transaction.network)) {
          debug('Skipping signature for input %d of %d (RP input?)', inputIndex + 1, transaction.ins.length);
          return;
        }
        signWalletTransactionWithUnspent(txBuilder, inputIndex, unspent, walletSigner);
        debug('Successfully signed input %d of %d', inputIndex + 1, transaction.ins.length);
      } catch (e) {
        return new InputSigningError(inputIndex, unspent, e);
      }
    })
    .filter((e): e is InputSigningError => e !== undefined);

  const signedTransaction = isLastSignature ? txBuilder.build() : txBuilder.buildIncomplete();

  const verifyErrors: InputSigningError[] = signedTransaction.ins
    .map((input, inputIndex) => {
      const unspent = unspents[inputIndex] as Unspent;
      try {
        if (isReplayProtectionUnspent(unspent, transaction.network)) {
          debug(
            'Skipping input signature %d of %d (unspent from replay protection address which is platform signed only)',
            inputIndex + 1,
            transaction.ins.length
          );
          return;
        }
        const publicKey = walletSigner.deriveForUnspent(unspent.chain, unspent.index).signer.publicKey;
        if (!utxolib.bitgo.verifySignature(signedTransaction, inputIndex, unspent.value, { publicKey }, prevOutputs)) {
          return new InputSigningError(inputIndex, unspent, new Error(`invalid signature`));
        }
      } catch (e) {
        debug('Invalid signature');
        return new InputSigningError(inputIndex, unspent, e);
      }
    })
    .filter((e): e is InputSigningError => e !== undefined);

  if (signErrors.length || verifyErrors.length) {
    throw new TransactionSigningError(signErrors, verifyErrors);
  }

  return signedTransaction;
}

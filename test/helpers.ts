import { ethers } from "hardhat";
import { QuaiVault, QuaiVaultFactory, SocialRecoveryModule } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Shared test helpers for QuaiVault test suite.
 * Extracted to eliminate duplication across test files.
 */

/** Extract txHash from a TransactionProposed event */
export async function getTxHash(wallet: QuaiVault, tx: any): Promise<string> {
  const receipt = await tx.wait();
  const event = receipt?.logs.find((log: any) => {
    try {
      return wallet.interface.parseLog(log)?.name === "TransactionProposed";
    } catch {
      return false;
    }
  });
  return wallet.interface.parseLog(event as any)?.args[0];
}

/** Extract recoveryHash from a RecoveryInitiated event */
export async function getRecoveryHash(module: SocialRecoveryModule, tx: any): Promise<string> {
  const receipt = await tx.wait();
  const event = receipt?.logs.find((log: any) => {
    try {
      return module.interface.parseLog(log)?.name === "RecoveryInitiated";
    } catch {
      return false;
    }
  });
  return module.interface.parseLog(event as any)?.args.recoveryHash;
}

/** Propose an external (non-self) transaction and return its txHash */
export async function proposeExternal(
  wallet: QuaiVault,
  signer: SignerWithAddress,
  to: string,
  value: bigint = 0n,
  data: string = "0x"
): Promise<string> {
  const tx = await wallet.connect(signer).proposeTransaction(to, value, data);
  return getTxHash(wallet, tx);
}

/** Propose a self-call and return its txHash */
export async function proposeSelfCall(
  wallet: QuaiVault,
  signer: SignerWithAddress,
  data: string
): Promise<string> {
  const walletAddr = await wallet.getAddress();
  const tx = await wallet.connect(signer).proposeTransaction(walletAddr, 0, data);
  return getTxHash(wallet, tx);
}

/** Approve a transaction with the first N signers */
export async function approveN(
  wallet: QuaiVault,
  txHash: string,
  signers: SignerWithAddress[],
  n: number
) {
  for (let i = 0; i < n; i++) {
    await wallet.connect(signers[i]).approveTransaction(txHash);
  }
}

/** Propose + approve + execute a self-call through multisig */
export async function executeSelfCall(
  wallet: QuaiVault,
  data: string,
  signers: SignerWithAddress[],
  threshold: number
): Promise<string> {
  const txHash = await proposeSelfCall(wallet, signers[0], data);
  await approveN(wallet, txHash, signers, threshold);
  await wallet.connect(signers[0]).executeTransaction(txHash);
  return txHash;
}

/** Propose + approve + execute any transaction through multisig */
export async function executeMultisig(
  wallet: QuaiVault,
  to: string,
  value: bigint,
  data: string,
  signers: SignerWithAddress[],
  threshold: number
): Promise<string> {
  const tx = await wallet.connect(signers[0]).proposeTransaction(to, value, data);
  const txHash = await getTxHash(wallet, tx);
  await approveN(wallet, txHash, signers, threshold);
  await wallet.connect(signers[0]).executeTransaction(txHash);
  return txHash;
}

/** Deploy a wallet via factory and return the typed QuaiVault instance */
export async function deployWalletViaFactory(
  factory: QuaiVaultFactory,
  owners: string[],
  threshold: number,
  signer: SignerWithAddress,
  minExecutionDelay: number = 0
): Promise<QuaiVault> {
  const salt = ethers.randomBytes(32);
  const QuaiVaultFactory = await ethers.getContractFactory("QuaiVault");

  let tx;
  if (minExecutionDelay > 0) {
    tx = await factory
      .connect(signer)
      ["createWallet(address[],uint256,bytes32,uint32)"](owners, threshold, salt, minExecutionDelay);
  } else {
    tx = await factory.connect(signer).createWallet(owners, threshold, salt);
  }

  const receipt = await tx.wait();
  const event = receipt?.logs.find((log) => {
    try {
      return factory.interface.parseLog(log as any)?.name === "WalletCreated";
    } catch {
      return false;
    }
  });
  const parsedEvent = factory.interface.parseLog(event as any);
  return QuaiVaultFactory.attach(parsedEvent?.args[0]) as QuaiVault;
}

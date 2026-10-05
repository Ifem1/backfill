import {createClient} from "genlayer-js";
import {studionet} from "genlayer-js/chains";
import {TransactionStatus, ExecutionResult} from "genlayer-js/types";
import {config} from "../config";
import type {EIP1193Provider} from "./wallet";

export type TxStage = "AWAITING_SIGNATURE" | "SUBMITTED" | "CONSENSUS" | "DECIDED" | "CONSENSUS_UNDETERMINED" | "FINALIZED" | "EXECUTION_CONFIRMED" | "STATE_CONFIRMED" | "USER_REJECTED" | "WRONG_NETWORK" | "RPC_UNAVAILABLE" | "CONSENSUS_FAILURE" | "EXECUTION_ERROR" | "STATE_MISMATCH" | "CONTRACT_ERROR";
export type StoredTransaction = {actionKey: string; account: string; chainId: string; contract: string; method: string; argsFingerprint: string; hash: string; submittedAt: number; stage: TxStage};
const STORAGE_KEY = "backfill.transactions";

export const readClient = createClient({chain: studionet});
export function writeClient(address: string, provider: EIP1193Provider) { return createClient({chain: studionet, account: address as `0x${string}`, provider}); }
export function explorerTx(hash: string) { return `${config.explorer}/tx/${hash}`; }
export async function readContract(address: string, functionName: string, args: any[] = []) { if (!address) throw new Error("Contract address is not configured in this deployment"); return readClient.readContract({address: address as `0x${string}`, functionName, args}); }
export async function readContractWithRetry(address: string, functionName: string, args: any[] = [], attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await readContract(address, functionName, args); }
    catch (error) {
      lastError = error;
      const message = String(error instanceof Error ? error.message : error).toLowerCase();
      if (message.includes("does not exist") || message.includes("out of range") || message.includes("invalid") || message.includes("not configured")) throw error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Canonical RPC read unavailable");
}
export async function readEpoch(id: number) { return readContract(config.rounds, "get_epoch", [id]); }
export type CanonicalCheck = () => Promise<void>;
export type WriteServices = {waitForFinalization?: (args: {hash: string}) => Promise<any>; actionKey?: string; account?: string; chainId?: string; contract?: string; onSubmitted?: (hash: string) => void};

function fingerprint(args: any[]) { return JSON.stringify(args, (_key, value) => typeof value === "bigint" ? `${value}n` : value); }
function readStored(): StoredTransaction[] { if (typeof window === "undefined" || !window.localStorage) return []; try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; } }
function writeStored(records: StoredTransaction[]) { if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }
const terminalStages = ["STATE_CONFIRMED", "USER_REJECTED", "CONSENSUS_UNDETERMINED", "EXECUTION_ERROR", "STATE_MISMATCH", "CONTRACT_ERROR"];
export function getPendingTransactions(account?: string, chainId?: string) { return readStored().filter(record => !terminalStages.includes(record.stage) && (!account || record.account?.toLowerCase()===account.toLowerCase()) && (!chainId || record.chainId?.toLowerCase()===chainId.toLowerCase())); }
export function getStoredTransaction(actionKey: string, account?: string, chainId?: string) { return readStored().find(record => record.actionKey===actionKey && (!account || record.account?.toLowerCase()===account.toLowerCase()) && (!chainId || record.chainId?.toLowerCase()===chainId.toLowerCase())); }
export function getTransaction(hash: string) { return readStored().find(record => record.hash === hash); }
function remember(record: StoredTransaction) { const records = readStored().filter(item => item.actionKey !== record.actionKey); records.push(record); writeStored(records); }

export async function getTriggeredTransactionIds(hash: string) { return readClient.getTriggeredTransactionIds({hash: hash as any}); }
export function selectTriggeredTransfer(parentHash: string, ids: string[], transactions: any[], recipient: string, amount: bigint) {
  const wanted = recipient.toLowerCase();
  return ids.map((hash, index) => ({hash, transaction: transactions[index]})).find(({transaction}) => {
    const actualRecipient = String(transaction?.recipient ?? transaction?.to ?? transaction?.message?.recipient ?? "").toLowerCase();
    const actualValue = transaction?.value ?? transaction?.message?.value;
    try { return actualRecipient === wanted && BigInt(actualValue) === amount; } catch { return false; }
  });
}
export async function findTriggeredTransfer(parentHash: string, recipient: string, amount: bigint) {
  const ids = await getTriggeredTransactionIds(parentHash);
  const transactions = await Promise.all(ids.map(hash => readClient.getTransaction({hash: hash as any})));
  return selectTriggeredTransfer(parentHash, ids as string[], transactions, recipient, amount);
}

export type PayoutDeliveryState = "CONFIRMED" | "PENDING_OR_UNVERIFIED" | "FAILED_OR_UNCREDITED";
export type PayoutDeliveryReason = "DELIVERY_CONFIRMED" | "NO_TRIGGERED_CHILD" | "NO_MATCHING_CHILD" | "AMBIGUOUS_MATCHING_CHILD" | "CHILD_NOT_FINALIZED" | "CHILD_EXECUTION_FAILED" | "VALUE_NOT_CREDITED" | "VALUE_CREDIT_UNVERIFIED" | "MALFORMED_CHILD";
export type PayoutDelivery = {state: PayoutDeliveryState; reason: PayoutDeliveryReason; parentHash: string; childHash?: string; transaction?: unknown};
export type PayoutDeliveryServices = {
  getTriggeredTransactionIds: (parentHash: string) => Promise<string[]>;
  getTransaction: (hash: string) => Promise<unknown>;
};

function canonicalAddress(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : undefined;
}

function exactWei(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function unanimous<T>(values: T[]): T | undefined {
  return values.length > 0 && values.every(value => value === values[0]) ? values[0] : undefined;
}

function childRecipient(transaction: any): string | undefined {
  const supplied = [transaction?.recipient, transaction?.to, transaction?.message?.recipient].filter(value => value !== undefined);
  const normalized = supplied.map(canonicalAddress);
  return normalized.every(Boolean) ? unanimous(normalized as string[]) : undefined;
}

function childValue(transaction: any): bigint | undefined {
  const supplied = [transaction?.value, transaction?.message?.value].filter(value => value !== undefined);
  const normalized = supplied.map(exactWei);
  return normalized.every(value => value !== undefined) ? unanimous(normalized as bigint[]) : undefined;
}

function childStatus(transaction: any): string | undefined {
  if (typeof transaction?.statusName === "string") return transaction.statusName;
  return typeof transaction?.status === "string" ? transaction.status : undefined;
}

function childExecution(transaction: any): string | undefined {
  const value = transaction?.txExecutionResultName
    ?? transaction?.execution_result
    ?? transaction?.txExecutionResult
    ?? transaction?.consensus_data?.leader_receipt?.find((item: any) => item?.mode === "leader")?.execution_result;
  return value === undefined ? undefined : typeof value === "string" ? value : "UNVERIFIABLE";
}

function servicesFromReadClient(): PayoutDeliveryServices {
  return {
    getTriggeredTransactionIds: async parentHash => (await readClient.getTriggeredTransactionIds({hash: parentHash as any})) as string[],
    getTransaction: async hash => readClient.getTransaction({hash: hash as any}),
  };
}

/**
 * Verifies delivery only from child transactions explicitly triggered by `parentHash`.
 * It deliberately treats incomplete or ambiguous receipts as non-delivery.
 */
export async function verifyTriggeredPayoutDelivery(parentHash: string, recipient: string, amount: bigint, services: PayoutDeliveryServices = servicesFromReadClient()): Promise<PayoutDelivery> {
  const expectedRecipient = canonicalAddress(recipient);
  if (!expectedRecipient || amount < 0n || !/^0x[0-9a-fA-F]+$/.test(parentHash)) {
    return {state: "PENDING_OR_UNVERIFIED", reason: "MALFORMED_CHILD", parentHash};
  }

  const ids = await services.getTriggeredTransactionIds(parentHash);
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string") || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    return {state: "PENDING_OR_UNVERIFIED", reason: "NO_TRIGGERED_CHILD", parentHash};
  }

  const children = await Promise.all(ids.map(async hash => ({hash, transaction: await services.getTransaction(hash)})));
  const candidates = children.filter(({transaction}) => childRecipient(transaction) === expectedRecipient && childValue(transaction) === amount);
  if (candidates.length === 0) return {state: "PENDING_OR_UNVERIFIED", reason: "NO_MATCHING_CHILD", parentHash};
  if (candidates.length !== 1) return {state: "PENDING_OR_UNVERIFIED", reason: "AMBIGUOUS_MATCHING_CHILD", parentHash};

  const candidate = candidates[0];
  const transaction: any = candidate.transaction;
  const recipientValue = childRecipient(transaction);
  const amountValue = childValue(transaction);
  if (!recipientValue || amountValue === undefined) return {state: "PENDING_OR_UNVERIFIED", reason: "MALFORMED_CHILD", parentHash, childHash: candidate.hash, transaction: candidate.transaction};
  if (childStatus(transaction) !== "FINALIZED") return {state: "PENDING_OR_UNVERIFIED", reason: "CHILD_NOT_FINALIZED", parentHash, childHash: candidate.hash, transaction: candidate.transaction};

  const execution = childExecution(transaction);
  if (execution && execution !== ExecutionResult.FINISHED_WITH_RETURN && execution !== "SUCCESS") {
    return {state: "FAILED_OR_UNCREDITED", reason: "CHILD_EXECUTION_FAILED", parentHash, childHash: candidate.hash, transaction: candidate.transaction};
  }
  if (transaction?.value_credited === false) {
    return {state: "FAILED_OR_UNCREDITED", reason: "VALUE_NOT_CREDITED", parentHash, childHash: candidate.hash, transaction: candidate.transaction};
  }
  if (transaction?.value_credited !== true) {
    return {state: "PENDING_OR_UNVERIFIED", reason: "VALUE_CREDIT_UNVERIFIED", parentHash, childHash: candidate.hash, transaction: candidate.transaction};
  }
  return {state: "CONFIRMED", reason: "DELIVERY_CONFIRMED", parentHash, childHash: candidate.hash, transaction: candidate.transaction};
}

export class TransactionOutcomeError extends Error {
  constructor(public readonly stage: TxStage, message: string) { super(message); this.name = "TransactionOutcomeError"; }
}

function executionResultName(receipt: any) {
  return receipt.txExecutionResultName
    ?? receipt.execution_result
    ?? receipt.txExecutionResult
    ?? receipt.consensus_data?.leader_receipt?.find((item: any) => item.mode === "leader")?.execution_result
    ?? receipt.consensus_data?.leader_receipt?.[0]?.execution_result;
}

async function waitForFinalized(hash: string, onStage?: (stage: TxStage) => void) {
  onStage?.("CONSENSUS");
  const decided = await readClient.waitForTransactionReceipt({hash: hash as any, status: TransactionStatus.ACCEPTED});
  const decision = String((decided as any).statusName ?? "");
  if (decision === "UNDETERMINED") throw new TransactionOutcomeError("CONSENSUS_UNDETERMINED", "Validators could not reach majority. This transaction was not executed.");
  if (decision === "CANCELED" || decision === "VALIDATORS_TIMEOUT" || decision === "LEADER_TIMEOUT") throw new TransactionOutcomeError("CONSENSUS_FAILURE", `Consensus ended with ${decision}.`);
  onStage?.("DECIDED");
  const receipt = decision === "FINALIZED" ? decided : await readClient.waitForTransactionReceipt({hash: hash as any, status: TransactionStatus.FINALIZED});
  onStage?.("FINALIZED");
  return receipt;
}

export async function resumeAndConfirm(hash: string, onStage?: (stage: TxStage) => void, canonicalCheck?: CanonicalCheck) {
  try {
    const receipt = await waitForFinalized(hash, onStage);
    const execution = executionResultName(receipt);
    if (execution !== ExecutionResult.FINISHED_WITH_RETURN && execution !== "SUCCESS") throw new TransactionOutcomeError("EXECUTION_ERROR", `Transaction finalized, but contract execution failed: ${execution ?? "unknown"}`);
    onStage?.("EXECUTION_CONFIRMED");
    try { await canonicalCheck?.(); } catch (error) { throw new TransactionOutcomeError("STATE_MISMATCH", error instanceof Error ? `Transaction succeeded, but canonical state verification failed: ${error.message}` : "Transaction succeeded, but canonical state verification failed."); }
    onStage?.("STATE_CONFIRMED");
    return {hash, receipt};
  } catch (error) {
    if (error instanceof TransactionOutcomeError && getTransaction(hash)) remember({...getTransaction(hash)!, stage: error.stage});
    throw error;
  }
}

export async function writeAndConfirm(client: any, address: string, functionName: string, args: any[], value = 0n, onStage?: (stage: TxStage) => void, canonicalCheck?: CanonicalCheck, services: WriteServices = {}) {
  let hash: string | undefined;
  const actionKey = services.actionKey || `${address}:${functionName}:${fingerprint(args)}`;
  try {
    onStage?.("AWAITING_SIGNATURE");
    hash = await client.writeContract({address: address as `0x${string}`, functionName, args, value});
    if (!hash) throw new Error("Write did not return a transaction hash");
    remember({actionKey, account: services.account || "", chainId: services.chainId || "0x0", contract: services.contract || address, method: functionName, argsFingerprint: fingerprint(args), hash, submittedAt: Date.now(), stage: "SUBMITTED"});
    services.onSubmitted?.(hash);
    onStage?.("SUBMITTED");
    onStage?.("CONSENSUS");
    const receipt = services.waitForFinalization ? await services.waitForFinalization({hash}) : await waitForFinalized(hash, onStage);
    onStage?.("FINALIZED");
    const execution = executionResultName(receipt);
    if (String((receipt as any).statusName ?? "") === "UNDETERMINED") { remember({...getTransaction(hash)!, stage: "CONSENSUS_UNDETERMINED"}); onStage?.("CONSENSUS_UNDETERMINED"); throw new TransactionOutcomeError("CONSENSUS_UNDETERMINED", "Validators could not reach majority. This transaction was not executed."); }
    if (execution !== ExecutionResult.FINISHED_WITH_RETURN && execution !== "SUCCESS") { remember({...getTransaction(hash)!, stage: "EXECUTION_ERROR"}); onStage?.("EXECUTION_ERROR"); throw new TransactionOutcomeError("EXECUTION_ERROR", `Transaction finalized, but contract execution failed: ${execution ?? "unknown"}`); }
    onStage?.("EXECUTION_CONFIRMED");
    try { await canonicalCheck?.(); } catch (error) { remember({...getTransaction(hash)!, stage: "STATE_MISMATCH"}); onStage?.("STATE_MISMATCH"); throw new TransactionOutcomeError("STATE_MISMATCH", error instanceof Error ? `Transaction finalized, but canonical state did not match the expected transition: ${error.message}` : "Transaction finalized, but canonical state did not match the expected transition."); }
    remember({...getTransaction(hash)!, stage: "STATE_CONFIRMED"});
    onStage?.("STATE_CONFIRMED");
    return {hash, receipt};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let failureStage: TxStage;
    if (error instanceof TransactionOutcomeError) failureStage = error.stage;
    else if (message.toLowerCase().includes("reject")) failureStage = "USER_REJECTED";
    else if (message.toLowerCase().includes("network")) failureStage = "WRONG_NETWORK";
    else if (message.toLowerCase().includes("consensus")) failureStage = "CONSENSUS_FAILURE";
    else if (message.toLowerCase().includes("rpc") || message.toLowerCase().includes("fetch")) failureStage = "RPC_UNAVAILABLE";
    else if (hash) failureStage = "EXECUTION_ERROR";
    else failureStage = "CONTRACT_ERROR";
    if (hash && getTransaction(hash)) remember({...getTransaction(hash)!, stage: failureStage});
    onStage?.(failureStage);
    throw error;
  }
}

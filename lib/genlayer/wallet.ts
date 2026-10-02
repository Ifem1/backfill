import {config} from "../config";

export type EIP1193Provider = {
  request(args: {method: string; params?: unknown[]}): Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

export type EIP6963ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
export type EIP6963ProviderDetail = { info: EIP6963ProviderInfo; provider: EIP1193Provider };

export async function discoverEIP6963Providers(timeoutMs = 250): Promise<EIP6963ProviderDetail[]> {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return [];
  const found = new Map<string, EIP6963ProviderDetail>();
  const onAnnouncement = (event: Event) => {
    const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail;
    if (detail?.info?.uuid && detail.provider) found.set(detail.info.uuid, detail);
  };
  window.addEventListener("eip6963:announceProvider", onAnnouncement);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs));
  window.removeEventListener("eip6963:announceProvider", onAnnouncement);
  return [...found.values()];
}
declare global { interface Window { ethereum?: EIP1193Provider } }

export const BACKFILL_ADDRESS_KEY = "backfill:address";
export const STUDIONET_CHAIN_ID = `0x${config.chainId.toString(16)}`;
export const STUDIONET_RPC_URL = "https://studio.genlayer.com/api";
export const STUDIONET_EXPLORER_URL = "https://explorer-studio.genlayer.com";

export function getWindowProvider(): EIP1193Provider {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("No injected wallet provider detected.");
  return window.ethereum;
}

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export async function ensureStudionet(provider: EIP1193Provider): Promise<void> {
  let chainId = String(await provider.request({method: "eth_chainId"}));
  if (chainId.toLowerCase() !== STUDIONET_CHAIN_ID) {
    try {
      await provider.request({method: "wallet_switchEthereumChain", params: [{chainId: STUDIONET_CHAIN_ID}]});
    } catch (error) {
      const code = (error as {code?: number})?.code;
      const message = String((error as {message?: unknown})?.message ?? "").toLowerCase();
      if (code === 4902 || isUnknownChainMessage(message)) {
        try {
          await provider.request({method: "wallet_addEthereumChain", params: [{
            chainId: STUDIONET_CHAIN_ID,
            chainName: "GenLayer Studionet",
            nativeCurrency: {name: "GEN", symbol: "GEN", decimals: 18},
            rpcUrls: [STUDIONET_RPC_URL],
            blockExplorerUrls: [STUDIONET_EXPLORER_URL],
          }]});
          await provider.request({method: "wallet_switchEthereumChain", params: [{chainId: STUDIONET_CHAIN_ID}]});
        } catch (addOrSwitchError) {
          if (isUserRejection(addOrSwitchError)) throw new Error("Studionet was not added or selected.");
          throw addOrSwitchError;
        }
      } else if (isUserRejection(error)) throw new Error("Studionet was not added or selected.");
      else if (code === -32601 || message.includes("method not found") || message.includes("unsupported")) {
        throw new Error("This injected wallet does not support automatic network switching. Choose another injected wallet or add GenLayer Studionet manually.");
      } else throw error;
    }
  }
  chainId = String(await provider.request({method: "eth_chainId"}));
  if (chainId.toLowerCase() !== STUDIONET_CHAIN_ID) throw new Error("Wallet is not on GenLayer Studionet (61999).");
}

function isUserRejection(error: unknown) {
  const code = (error as {code?: number})?.code;
  const message = String((error as {message?: unknown})?.message ?? "").toLowerCase();
  return code === 4001 || message.includes("user rejected") || message.includes("user denied") || message.includes("rejected");
}

function isUnknownChainMessage(message: string) {
  return ["unknown chain", "chain not found", "unrecognized chain", "unrecognised chain", "chain is not configured", "chain not configured", "chain does not exist", "chain isn't configured", "chain is unknown"].some((part) => message.includes(part));
}

export function normalizeWalletError(error: unknown): string {
  const code = (error as {code?: number})?.code;
  const message = String((error as {message?: unknown})?.message ?? error).toLowerCase();
  if (message.includes("validators could not reach majority") || message.includes("undetermined")) return "Validators could not reach majority. This transaction was not executed. You can retry with a new transaction.";
  if (message.includes("transaction finalized, but contract execution failed") || message.includes("execution failed")) return "Transaction finalized, but contract execution failed.";
  if (message.includes("canonical state") || message.includes("state verification")) return "Transaction succeeded, but canonical state verification is unavailable or mismatched.";
  if (message.includes("studionet was not added or selected")) return "Studionet was not added or selected.";
  if (code === 4001 || message.includes("user rejected")) return message.includes("switch") || message.includes("network") ? "Network switch rejected in wallet." : "Transaction rejected in wallet.";
  if (code === -32601 || message.includes("method not found") || message.includes("unsupported")) return "This injected wallet does not support automatic network switching. Choose another injected wallet or add GenLayer Studionet manually.";
  if (message.includes("rpc") || message.includes("fetch") || message.includes("timeout")) return "Studionet RPC is currently unavailable.";
  if (message.includes("chain") || message.includes("network")) return "Switch your injected wallet to GenLayer Studionet (61999).";
  return "Wallet transaction could not be submitted.";
}

export function disconnectWallet(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(BACKFILL_ADDRESS_KEY);
}

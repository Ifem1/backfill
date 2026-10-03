import { describe, expect, it, vi } from "vitest";
import { discoverEIP6963Providers, ensureStudionet, normalizeWalletError, selectInjectedProvider, STUDIONET_CHAIN_ID, STUDIONET_EXPLORER_URL, STUDIONET_RPC_URL } from "../../lib/genlayer/wallet";

const studionetMetadata = {
  chainId: STUDIONET_CHAIN_ID,
  chainName: "GenLayer Studionet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: [STUDIONET_RPC_URL],
  blockExplorerUrls: [STUDIONET_EXPLORER_URL],
};

function provider(initialChain = STUDIONET_CHAIN_ID) {
  let chain = initialChain;
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  const value: any = {
    calls,
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params });
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") { chain = STUDIONET_CHAIN_ID; return null; }
      return null;
    }),
  };
  return { value, calls, setChain: (next: string) => { chain = next; } };
}

describe("injected Studionet wallet flow", () => {

  it("discovers announced EIP-6963 providers without trusting arbitrary event payloads", async () => {
    const p = provider();
    const fakeWindow = new EventTarget() as unknown as Window & typeof globalThis;
    Object.defineProperty(fakeWindow, "setTimeout", { value: setTimeout });
    vi.stubGlobal("window", fakeWindow);
    const discovered = discoverEIP6963Providers(0);
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "backfill-test", name: "Test Wallet", icon: "data:image/svg+xml,", rdns: "com.example.test" },
      provider: p.value,
    }}));
    const providers = await discovered;
    expect(providers).toHaveLength(1);
    expect(providers[0].info.uuid).toBe("backfill-test");
    expect(providers[0].provider).toBe(p.value);
    vi.unstubAllGlobals();
  });
  it("ignores announcements with incomplete EIP-6963 metadata", async () => {
    const p = provider();
    const fakeWindow = new EventTarget() as unknown as Window & typeof globalThis;
    Object.defineProperty(fakeWindow, "setTimeout", { value: setTimeout });
    vi.stubGlobal("window", fakeWindow);
    const discovered = discoverEIP6963Providers(0);
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "missing-name", name: "", icon: "data:image/svg+xml,", rdns: "com.example.bad" },
      provider: p.value,
    }}));
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "valid-provider", name: "Valid Wallet", icon: "data:image/svg+xml,", rdns: "com.example.valid" },
      provider: p.value,
    }}));
    const providers = await discovered;
    expect(providers.map((item) => item.info.uuid)).toEqual(["valid-provider"]);
    vi.unstubAllGlobals();
  });

  it("selects a stable valid EIP-6963 announcement before the legacy fallback", () => {
    const fallback=provider().value;
    const later=provider().value;
    const earlier=provider().value;
    expect(selectInjectedProvider([
      {info:{uuid:"z-provider",name:"Later",icon:"data:image/svg+xml,",rdns:"example.z"},provider:later},
      {info:{uuid:"a-provider",name:"Earlier",icon:"data:image/svg+xml,",rdns:"example.a"},provider:earlier},
    ],fallback)).toBe(earlier);
    expect(selectInjectedProvider([],fallback)).toBe(fallback);
  });

  it("does not switch or add when already on 61999 and rereads the chain", async () => {
    const p = provider();
    await ensureStudionet(p.value);
    expect(p.calls.map((call) => call.method)).toEqual(["eth_chainId", "eth_chainId"]);
  });

  it("switches directly when Studionet is already configured", async () => {
    const p = provider("0x1");
    await ensureStudionet(p.value);
    expect(p.calls.map((call) => call.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
    expect(p.calls.some((call) => call.method === "wallet_addEthereumChain")).toBe(false);
  });

  it("adds missing Studionet with exact metadata, switches again, and verifies the final chain", async () => {
    const p = provider("0x1");
    let switchCalls = 0;
    p.value.request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      p.calls.push({ method, params });
      if (method === "eth_chainId") return p.calls.filter((call) => call.method === method).length > 1 ? STUDIONET_CHAIN_ID : "0x1";
      if (method === "wallet_switchEthereumChain" && switchCalls++ === 0) { const error: any = new Error("provider says chain is not configured"); error.code = -32000; throw error; }
      return null;
    });
    await ensureStudionet(p.value);
    expect(p.calls[2]).toEqual({ method: "wallet_addEthereumChain", params: [studionetMetadata] });
    expect(p.calls.map((call) => call.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_chainId"]);
  });

  it("does not add after a rejected switch and keeps the rejection distinct", async () => {
    const p = provider("0x1");
    p.value.request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      p.calls.push({ method, params });
      if (method === "eth_chainId") return "0x1";
      const error: any = new Error("user rejected the request"); error.code = 4001; throw error;
    });
    await expect(ensureStudionet(p.value)).rejects.toThrow("Studionet was not added or selected.");
    expect(p.calls.map((call) => call.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain"]);
    expect(normalizeWalletError({ code: 4001, message: "user rejected transaction" })).toBe("Transaction rejected in wallet.");
  });

  it("stays wrong-network when the add-network request is rejected", async () => {
    const p = provider("0x1");
    let switchCalls = 0;
    p.value.request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      p.calls.push({ method, params });
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain" && switchCalls++ === 0) { const error: any = new Error("unknown chain"); error.code = 4902; throw error; }
      const error: any = new Error("user rejected add network"); error.code = 4001; throw error;
    });
    await expect(ensureStudionet(p.value)).rejects.toThrow("Studionet was not added or selected.");
    expect(p.calls.map((call) => call.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain"]);
    expect(normalizeWalletError(new Error("Studionet was not added or selected."))).toBe("Studionet was not added or selected.");
  });

  it("does not mark the wallet ready when the final chain reread is not 61999", async () => {
    const p = provider("0x1");
    p.value.request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      p.calls.push({ method, params });
      if (method === "eth_chainId") return "0x1";
      return null;
    });
    await expect(ensureStudionet(p.value)).rejects.toThrow("Wallet is not on GenLayer Studionet");
  });

  it("does not add for an unrelated provider error", async () => {
    const p = provider("0x1");
    p.value.request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      p.calls.push({ method, params });
      if (method === "eth_chainId") return "0x1";
      throw Object.assign(new Error("RPC unavailable"), { code: -32005 });
    });
    await expect(ensureStudionet(p.value)).rejects.toThrow("RPC unavailable");
    expect(p.calls.map((call) => call.method)).toEqual(["eth_chainId", "wallet_switchEthereumChain"]);
  });

  it("normalizes unsupported switching without exposing provider details", () => {
    expect(normalizeWalletError({ code: -32601, message: "method not found" })).toContain("does not support automatic network switching");
  });
});

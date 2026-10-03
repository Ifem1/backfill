"use client";

import {createContext,useContext,useEffect,useMemo,useState} from "react";
import {BACKFILL_ADDRESS_KEY,discoverEIP6963Providers,ensureStudionet,getWindowProvider,normalizeWalletError,selectInjectedProvider,STUDIONET_CHAIN_ID,type EIP1193Provider} from "@/lib/genlayer/wallet";

type WalletStatus="DISCONNECTED"|"CONNECTING"|"CONNECTED"|"WRONG_NETWORK";
type Session={address:string;provider:EIP1193Provider};
type WalletContextValue={provider?:EIP1193Provider;address:string;chainId:string;status:WalletStatus;error:string;connect:()=>Promise<string>;switchToStudionet:()=>Promise<void>;ensureWriteReady:()=>Promise<Session>;disconnect:()=>void};
const Context=createContext<WalletContextValue|undefined>(undefined);

export function WalletProvider({children}:{children:React.ReactNode}) {
  const [provider,setProvider]=useState<EIP1193Provider>();
  const [address,setAddress]=useState("");
  const [chainId,setChainId]=useState("");
  const [status,setStatus]=useState<WalletStatus>("DISCONNECTED");
  const [error,setError]=useState("");

  const applyChain=(next:string,current=address)=>{setChainId(next);setStatus(current?(next.toLowerCase()===STUDIONET_CHAIN_ID?"CONNECTED":"WRONG_NETWORK"):"DISCONNECTED")};
  const applyAccount=(next:string)=>{setAddress(next);if(next) window.localStorage.setItem(BACKFILL_ADDRESS_KEY,next);else window.localStorage.removeItem(BACKFILL_ADDRESS_KEY);setStatus(next?(chainId.toLowerCase()===STUDIONET_CHAIN_ID?"CONNECTED":"WRONG_NETWORK"):"DISCONNECTED")};

  useEffect(()=>{
    if(typeof window === "undefined") return;
    let active=true;
    let selected:EIP1193Provider|undefined;
    const saved=window.localStorage.getItem(BACKFILL_ADDRESS_KEY);
    if(saved) {setAddress(saved);setStatus("WRONG_NETWORK");}
    const accountsChanged=(value:unknown)=>applyAccount((value as string[]|undefined)?.[0]||"");
    const chainChanged=(value:unknown)=>applyChain(String(value));
    const disconnected=()=>{setAddress("");setChainId("");setStatus("DISCONNECTED");window.localStorage.removeItem(BACKFILL_ADDRESS_KEY);};
    void (async()=>{
      const announced=await discoverEIP6963Providers();
      const current=selectInjectedProvider(announced,window.ethereum);
      if(!active || !current) return;
      selected=current;
      setProvider(current);
      current.on?.("accountsChanged",accountsChanged);current.on?.("chainChanged",chainChanged);current.on?.("disconnect",disconnected);
      try {
        const [accounts,chain]=await Promise.all([
          current.request({method:"eth_accounts"}) as Promise<string[]>,
          current.request({method:"eth_chainId"}) as Promise<string>,
        ]);
        if(!active) return;
        const authorized=(accounts||[]).find(a=>!saved||a.toLowerCase()===saved.toLowerCase())||"";
        if(saved && !authorized) {window.localStorage.removeItem(BACKFILL_ADDRESS_KEY);setAddress("");setStatus("DISCONNECTED");}
        else if(authorized) {setAddress(authorized);setStatus(String(chain).toLowerCase()===STUDIONET_CHAIN_ID?"CONNECTED":"WRONG_NETWORK");}
        setChainId(String(chain));
      } catch { if(active) setError("Studionet RPC is currently unavailable."); }
    })();
    return()=>{active=false;selected?.removeListener?.("accountsChanged",accountsChanged);selected?.removeListener?.("chainChanged",chainChanged);selected?.removeListener?.("disconnect",disconnected);};
  },[]);

  const connect=async()=>{
    let current:EIP1193Provider;
    try {current=provider||getWindowProvider();setProvider(current);setStatus("CONNECTING");setError("");const accounts=await current.request({method:"eth_requestAccounts"}) as string[];const next=accounts?.[0];if(!next) throw new Error("Wallet returned no account.");setAddress(next);window.localStorage.setItem(BACKFILL_ADDRESS_KEY,next);const chain=String(await current.request({method:"eth_chainId"}));applyChain(chain,next);if(chain.toLowerCase()!==STUDIONET_CHAIN_ID) await ensureStudionet(current);const finalChain=String(await current.request({method:"eth_chainId"}));setChainId(finalChain);setStatus(finalChain.toLowerCase()===STUDIONET_CHAIN_ID?"CONNECTED":"WRONG_NETWORK");return next;} catch(e){setError(normalizeWalletError(e));setStatus(address?"WRONG_NETWORK":"DISCONNECTED");return "";}
  };
  const switchToStudionet=async()=>{if(!provider){setError("No injected wallet provider detected.");return}setStatus("CONNECTING");setError("");try{await ensureStudionet(provider);const chain=String(await provider.request({method:"eth_chainId"}));applyChain(chain);if(chain.toLowerCase()!==STUDIONET_CHAIN_ID) throw new Error("Wallet is not on GenLayer Studionet (61999).");}catch(e){setError(normalizeWalletError(e));setStatus("WRONG_NETWORK")}};
  const ensureWriteReady=async()=>{const current=provider||getWindowProvider();const accounts=await current.request({method:"eth_accounts"}) as string[];const actual=accounts?.[0]||"";if(!address||!actual||actual.toLowerCase()!==address.toLowerCase()) throw new Error("Connect the displayed wallet account before writing.");let chain=String(await current.request({method:"eth_chainId"}));if(chain.toLowerCase()!==STUDIONET_CHAIN_ID){await ensureStudionet(current);chain=String(await current.request({method:"eth_chainId"}))}setChainId(chain);if(chain.toLowerCase()!==STUDIONET_CHAIN_ID){setStatus("WRONG_NETWORK");throw new Error("Wallet is not on GenLayer Studionet (61999).")}setStatus("CONNECTED");return {address,provider:current};};
  const value=useMemo(()=>({provider,address,chainId,status,error,connect,switchToStudionet,ensureWriteReady,disconnect:()=>{window.localStorage.removeItem(BACKFILL_ADDRESS_KEY);setAddress("");setChainId("");setStatus("DISCONNECTED");setError("")}}),[provider,address,chainId,status,error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWallet(){const value=useContext(Context);if(!value) throw new Error("useWallet must be used inside WalletProvider");return value;}

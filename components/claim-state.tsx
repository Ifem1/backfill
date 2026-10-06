"use client";

import Link from "next/link";
import {useEffect, useState} from "react";
import {config} from "@/lib/config";
import {explorerTx, getStoredTransaction, readContractWithRetry, verifyTriggeredPayoutDelivery, type PayoutDelivery} from "@/lib/genlayer/client";
import {formatGen} from "@/lib/genlayer/amounts";
import {isPayoutSettlementActive, payoutDeliveryPresentation} from "@/lib/ui/payout-delivery";
import {ContractAction} from "@/components/contract-action";
import {useWallet} from "@/components/wallet-provider";

type Claim = {
  id: number;
  epoch_id: number;
  claimant: string;
  title: string;
  type: string;
  status: string;
  impact_band: string;
  weight: number;
  reason: string;
  evidence: {source: number; excerpt: string}[];
  challenge_status: string;
  challenge_used: boolean;
  attempts?: number;
  retryable?: boolean;
};

export function ClaimState({id}: {id: number}) {
  const [claim, setClaim] = useState<Claim>();
  const [epoch, setEpoch] = useState<any>();
  const [pool, setPool] = useState<any>();
  const [settlement, setSettlement] = useState<any>();
  const [error, setError] = useState("");
  const [parentHash, setParentHash] = useState("");
  const [delivery, setDelivery] = useState<PayoutDelivery>();
  const [deliveryCheck, setDeliveryCheck] = useState(0);
  const {address} = useWallet();
  const payoutInitiated = isPayoutSettlementActive(settlement?.status);

  const load = async () => {
    setError("");
    let currentClaim: Claim;
    try {
      currentClaim = await readContractWithRetry(config.rounds, "get_claim", [id]) as Claim;
      setClaim(currentClaim);
      setEpoch(await readContractWithRetry(config.rounds, "get_epoch", [currentClaim.epoch_id]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read claim");
      return;
    }
    try { setPool(await readContractWithRetry(config.pool, "get_pool", [currentClaim.epoch_id])); }
    catch (cause) { setPool(undefined); setError(cause instanceof Error ? cause.message : "Unable to read pool state"); }
    try { setSettlement(await readContractWithRetry(config.pool, "get_settlement", [currentClaim.epoch_id, id])); }
    catch (cause) { setSettlement(undefined); setError(cause instanceof Error ? cause.message : "Unable to read settlement state"); }
  };

  useEffect(() => { void load(); }, [id, address]);

  useEffect(() => {
    if (!claim || !address) return;
    const actionKey = `claim:${claim.epoch_id}:${id}:${address.toLowerCase()}`;
    const stored = getStoredTransaction(actionKey, address, "0xf22f");
    if (stored?.hash) setParentHash(stored.hash);
  }, [address, claim?.epoch_id, id]);

  useEffect(() => {
    let current = true;
    if (!payoutInitiated || !parentHash) { setDelivery(undefined); return; }
    let recipient: string;
    let amount: bigint;
    try {
      recipient = String(settlement.recipient || "");
      amount = BigInt(String(settlement.amount || "0"));
    } catch {
      setDelivery({state: "PENDING_OR_UNVERIFIED", reason: "MALFORMED_CHILD", parentHash});
      return;
    }
    void verifyTriggeredPayoutDelivery(parentHash, recipient, amount)
      .then(result => { if (current) setDelivery(result); })
      .catch(() => { if (current) setDelivery({state: "PENDING_OR_UNVERIFIED", reason: "PARENT_EXECUTION_UNVERIFIED", parentHash}); });
    return () => { current = false; };
  }, [deliveryCheck, parentHash, payoutInitiated, settlement?.amount, settlement?.identity, settlement?.recipient]);

  if (error) return <p className="border-l-4 border-[var(--coral)] p-4">{error}</p>;
  if (!claim) return <p className="mono">Reading canonical claim state…</p>;

  const now = Math.floor(Date.now() / 1000);
  const canChallenge = Boolean(address) && epoch?.status === "CHALLENGE" && !claim.challenge_used && claim.status !== "CHALLENGED" && address.toLowerCase() !== claim.claimant.toLowerCase() && now < Number(epoch.challenge_close);
  const canEvaluate = epoch?.status === "EVALUATING" && (claim.status === "SUBMITTED" || (claim.status === "INCONCLUSIVE" && claim.retryable === true));
  const canExpire = epoch?.status === "EVALUATING" && now >= Number(epoch.claims_close) && (claim.status === "SUBMITTED" || (claim.status === "INCONCLUSIVE" && claim.retryable === true));
  const deliveryView = payoutDeliveryPresentation(payoutInitiated, parentHash || undefined, delivery);
  const deliveryTone = deliveryView.tone === "confirmed" ? "border-[var(--blue)]" : deliveryView.tone === "failed" ? "border-[var(--coral)]" : "border-[var(--line)]";

  async function completeClaim(result?: {hash: string}) {
    if (result?.hash) setParentHash(result.hash);
    await load();
    setDeliveryCheck(value => value + 1);
  }

  return <div>
    <div className="mono text-xs uppercase">Dossier {id} / {claim.status}</div>
    <h1 className="serif mt-5 text-6xl leading-none md:text-8xl">{claim.title}</h1>
    <div className="mt-10 grid gap-8 md:grid-cols-[1fr_.7fr]">
      <article>
        <div className="plate p-7">
          <div className="mono text-xs">{claim.type} / {claim.status}</div>
          <p className="mt-8 leading-7">{claim.reason || "No canonical reason recorded yet."}</p>
          <div className="mt-8 border-t border-[var(--line)] pt-5">
            <div className="mono text-xs uppercase">Grounded evidence</div>
            {claim.evidence.length ? claim.evidence.map((e, index) => <p className="mt-3 text-sm leading-6" key={index}>Source {e.source}: {e.excerpt}</p>) : <p className="mt-3 text-sm">No evidence stored.</p>}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {canEvaluate && <ContractAction contract="rounds" method="evaluate_claim" args={[id]} label="Evaluate evidence" onComplete={load} />}
          {canExpire && <ContractAction contract="rounds" method="expire_unresolved_claim" args={[id]} label="Expire unresolved claim" onComplete={load} />}
          {canChallenge && <Link className="button inline-block" href={`/challenge/${id}`}>Challenge the record</Link>}
          {claim.challenge_status === "PENDING" && <ContractAction contract="rounds" method="resolve_challenge" args={[id]} label="Resolve challenge" onComplete={load} />}
          {claim.status === "ELIGIBLE" && pool?.status === "POOL_FINALIZED" && (settlement?.status === "NONE" || settlement?.status === "PENDING") && <ContractAction contract="pool" method="claim" args={[claim.epoch_id, id]} label={settlement?.status === "PENDING" ? "Payout initiated" : "Claim finalized GEN"} disabled={settlement?.status === "PENDING"} onComplete={completeClaim} actionKey={`claim:${claim.epoch_id}:${id}`} />}
        </div>
      </article>
      <aside className="border-l border-[var(--ink)] p-6">
        <div className="mono text-xs uppercase">Authoritative allocation</div>
        <div className="serif mt-4 text-5xl">{claim.weight}</div>
        <p className="mt-3 leading-7">Weight / {claim.impact_band}</p>
        <p className="mt-5 text-sm">Challenge: {claim.challenge_status}</p>
        <p className="mt-5 break-all text-xs">Claimant: {claim.claimant}</p>
        {pool && <p className="mt-5 text-sm">Pool: {pool.status} / reserved {formatGen(BigInt(pool.reserved || 0))}</p>}
        {settlement && <div className="mt-5 border-t pt-5 text-sm"><p>Contract settlement: {settlement.status || "NONE"}</p><p>Identity: {settlement.identity || "—"}</p><p>Recipient: {settlement.recipient || "—"}</p><p>Amount: {formatGen(BigInt(settlement.amount || 0))}</p></div>}
        <div className={`mt-5 border-l-4 ${deliveryTone} bg-[var(--paper)] p-4 text-sm`}>
          <div className="mono text-xs uppercase">External GEN delivery</div>
          <p className="mt-2 font-medium">{deliveryView.title}</p>
          <p className="mt-2 leading-6">{deliveryView.message}</p>
          <p className="mt-3 text-xs">{deliveryView.parentState}</p>
          {parentHash ? <p className="mt-3 break-all text-xs">Parent claim transaction: <a className="underline" target="_blank" rel="noreferrer" href={explorerTx(parentHash)}>{parentHash}</a></p> : <p className="mt-3 text-xs">Parent claim transaction: unavailable in this browser.</p>}
          {deliveryView.childHash && <p className="mt-3 break-all text-xs">{deliveryView.tone === "confirmed" ? "Confirmed external transfer" : "Observed external transfer"}: <a className="underline" target="_blank" rel="noreferrer" href={explorerTx(deliveryView.childHash)}>{deliveryView.childHash}</a></p>}
          {payoutInitiated && parentHash && <button className="button mt-4" onClick={() => setDeliveryCheck(value => value + 1)}>Recheck delivery</button>}
        </div>
      </aside>
    </div>
  </div>;
}

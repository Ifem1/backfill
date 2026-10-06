import {describe, expect, it, vi} from "vitest";
import {getPendingTransactions, selectTriggeredTransfer, verifyTriggeredPayoutDelivery, writeAndConfirm, type PayoutDelivery, type PayoutDeliveryServices} from "../../lib/genlayer/client";
import {isPayoutSettlementActive, payoutDeliveryPresentation} from "../../lib/ui/payout-delivery";
import {nestedLeaderExecutionReceipt, nestedLeaderFailureReceipt, topLevelExecutionReceipt} from "./fixtures/studionet-receipts";

function fakeClient(receipt:any={txExecutionResultName:"FINISHED_WITH_RETURN"}) {
  const client:any={
    connect:vi.fn(async()=>undefined),
    writeContract:vi.fn(async()=>"0xabc"),
  };
  return {client, receipt};
}

describe("write transaction safety", () => {
  it("persists the hash immediately and retains it when finalization fails", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {localStorage: {getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value)}});
    const {client}=fakeClient();
    const submitted:string[]=[];
    await expect(writeAndConfirm(client,"0x0000000000000000000000000000000000000001","fund",[7],0n,undefined,undefined,{actionKey:"resume-me",waitForFinalization:async()=>{expect(getPendingTransactions()[0].hash).toBe("0xabc"); throw new Error("rpc unavailable")},onSubmitted:hash=>submitted.push(hash)})).rejects.toThrow(/rpc unavailable/);
    expect(submitted).toEqual(["0xabc"]);
    expect(getPendingTransactions().find(item=>item.actionKey==="resume-me")?.hash).toBe("0xabc");
    vi.unstubAllGlobals();
  });
  it("sends payable value in wei and rereads canonical state", async () => {
    const {client,receipt}=fakeClient();
    const stages:string[]=[]; let canonical=0; let request:any;
    client.writeContract=vi.fn(async(input:any)=>{request=input; return "0xabc";});
    const result=await writeAndConfirm(client,"0x0000000000000000000000000000000000000001","fund",[7],1000000000000000000n,s=>stages.push(s),async()=>{canonical++;},{waitForFinalization:async()=>receipt});
    expect(request.value).toBe(1000000000000000000n);
    expect(client.connect).not.toHaveBeenCalled();
    expect(request.fees).toBeUndefined();
    expect(result.hash).toBe("0xabc");
    expect(canonical).toBe(1);
    expect(stages).toContain("EXECUTION_CONFIRMED");
  });

  it("surfaces rejected wallet transactions", async () => {
    const {client}=fakeClient(); client.writeContract=vi.fn(async()=>{throw new Error("User rejected the request")});
    const stages:string[]=[];
    await expect(writeAndConfirm(client,"0x1","x",[],0n,s=>stages.push(s))).rejects.toThrow(/rejected/);
    expect(stages).toContain("USER_REJECTED");
  });

  it("does not report success for reverted execution", async () => {
    const {client}=fakeClient({txExecutionResultName:"REVERTED"}); const stages:string[]=[];
    await expect(writeAndConfirm(client,"0x1","x",[],0n,s=>stages.push(s),undefined,{waitForFinalization:async()=>({txExecutionResultName:"REVERTED"})})).rejects.toThrow(/execution failed/);
    expect(stages).toContain("EXECUTION_ERROR");
  });

  it("surfaces consensus failure after submission", async () => {
    const {client}=fakeClient(); const stages:string[]=[];
    await expect(writeAndConfirm(client,"0x1","x",[],0n,s=>stages.push(s),undefined,{waitForFinalization:async()=>{throw new Error("consensus failed")}})).rejects.toThrow(/consensus/);
    expect(stages).toContain("CONSENSUS_FAILURE");
  });

  it("classifies an undetermined post-submission transaction and allows a fresh attempt", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {localStorage: {getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value)}});
    const {client}=fakeClient(); const stages:string[]=[];
    await expect(writeAndConfirm(client,"0x1","evaluate_claim",[3],0n,s=>stages.push(s),undefined,{actionKey:"evaluate:3",account:"0xabc",chainId:"0xf22f",waitForFinalization:async()=>({statusName:"UNDETERMINED"})})).rejects.toThrow(/not executed/);
    expect(stages).toContain("CONSENSUS_UNDETERMINED");
    expect(getPendingTransactions("0xabc","0xf22f")).toHaveLength(0);
    expect(JSON.parse(storage.get("backfill.transactions") || "[]")[0]).toMatchObject({hash:"0xabc",stage:"CONSENSUS_UNDETERMINED",account:"0xabc",chainId:"0xf22f"});
    vi.unstubAllGlobals();
  });

  it("accepts the nested Studionet leader execution result", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {localStorage: {getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value)}});
    const {client}=fakeClient();
    const stages:string[]=[];
    const result=await writeAndConfirm(client,"0x1","open_epoch",[1],0n,s=>stages.push(s),undefined,{actionKey:"open:1",account:"0xabc",chainId:"0xf22f",waitForFinalization:async()=>nestedLeaderExecutionReceipt});
    expect(result.hash).toBe("0xabc");
    expect(stages).toContain("EXECUTION_CONFIRMED");
    expect(getPendingTransactions("0xabc","0xf22f")).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("accepts the top-level Studionet txExecutionResult shape", async () => {
    const {client}=fakeClient(); const stages:string[]=[];
    const result=await writeAndConfirm(client,"0x1","finalize_pool",[4],0n,s=>stages.push(s),undefined,{waitForFinalization:async()=>topLevelExecutionReceipt});
    expect(result.receipt).toBe(topLevelExecutionReceipt);
    expect(stages).toContain("EXECUTION_CONFIRMED");
  });

  it("rejects a failed nested Studionet leader receipt", async () => {
    const {client}=fakeClient(); const stages:string[]=[];
    await expect(writeAndConfirm(client,"0x1","refund_unallocated",[4],0n,s=>stages.push(s),undefined,{waitForFinalization:async()=>nestedLeaderFailureReceipt})).rejects.toThrow(/execution failed: REVERTED/);
    expect(stages).toContain("EXECUTION_ERROR");
  });

  it("identifies a triggered child by parent-derived id, recipient, and exact value", () => {
    const child = selectTriggeredTransfer("0xparent", ["0xwrong", "0xchild"], [{to:"0x0000000000000000000000000000000000000002", value:2n}, {recipient:"0x0000000000000000000000000000000000000001", value:"1000000000000000000"}], "0x0000000000000000000000000000000000000001", 1000000000000000000n);
    expect(child?.hash).toBe("0xchild");
  });
});

const PH="0x"+"a".repeat(64), CH="0x"+"b".repeat(64);
const view=(state:PayoutDelivery["state"],reason:PayoutDelivery["reason"],child=false):PayoutDelivery=>({state,reason,parentHash:PH,...(child?{childHash:CH}:{})});
describe("claim payout delivery presentation",()=>{
  it.each(["PENDING","PAID"])("%s is active",s=>expect(isPayoutSettlementActive(s)).toBe(true));
  it.each(["NONE",undefined,null,"","UNKNOWN",1,{},[] as any])("%j is inactive",s=>expect(isPayoutSettlementActive(s)).toBe(false));
  it("keeps uninitiated and confirmed delivery neutral",()=>{expect(payoutDeliveryPresentation(false)).toMatchObject({tone:"neutral",title:"Payout not initiated"}); expect(payoutDeliveryPresentation(false,PH,view("CONFIRMED","DELIVERY_CONFIRMED",true)).title).toBe("Payout not initiated")});
  it("keeps missing parent pending",()=>expect(payoutDeliveryPresentation(true)).toMatchObject({tone:"pending",title:"Delivery pending / unverified"}));
  it.each(["PARENT_NOT_FINALIZED","PARENT_EXECUTION_UNVERIFIED","NO_TRIGGERED_CHILD","NO_MATCHING_CHILD","CHILD_NOT_FINALIZED","VALUE_CREDIT_UNVERIFIED","MALFORMED_CHILD"] as const)("maps %s to pending",reason=>expect(payoutDeliveryPresentation(true,PH,view("PENDING_OR_UNVERIFIED",reason))).toMatchObject({tone:"pending",title:"Delivery pending / unverified"}));
  it("distinguishes verified parent from malformed child",()=>{expect(payoutDeliveryPresentation(true,PH,view("PENDING_OR_UNVERIFIED","MALFORMED_CHILD")).parentState).toContain("finalized and execution verified"); expect(payoutDeliveryPresentation(true,PH,view("PENDING_OR_UNVERIFIED","PARENT_NOT_FINALIZED")).parentState).toContain("not authoritatively verified")});
  it.each([["PARENT_EXECUTION_FAILED","The authoritative payout path did not complete successfully."],["CHILD_EXECUTION_FAILED","The authoritative payout path did not complete successfully."],["VALUE_NOT_CREDITED","The matching external transfer was not credited."]] as const)("maps %s to failed",(reason,message)=>expect(payoutDeliveryPresentation(true,PH,view("FAILED_OR_UNCREDITED",reason,true))).toMatchObject({tone:"failed",title:"Delivery failed / uncredited",message,childHash:CH}));
  it("confirms only confirmed delivery",()=>{expect(payoutDeliveryPresentation(true,PH,view("CONFIRMED","DELIVERY_CONFIRMED",true))).toMatchObject({tone:"confirmed",title:"Delivery confirmed",childHash:CH}); expect(payoutDeliveryPresentation(true,PH,view("PENDING_OR_UNVERIFIED","NO_MATCHING_CHILD")).title).not.toBe("Delivery confirmed")});
});

const P="0x"+"a".repeat(64), Q="0x"+"b".repeat(64), R="0x0000000000000000000000000000000000000001", A=1000000000000000000n;
const child=(x:any={})=>({recipient:R,value:String(A),statusName:"FINALIZED",txExecutionResultName:"SUCCESS",value_credited:true,...x});
const parent=(x:any={})=>({statusName:"FINALIZED",txExecutionResultName:"SUCCESS",...x});
const services=(children:any, parents:any={}):PayoutDeliveryServices=>({
  getTriggeredTransactionIds:async h=>Object.keys(children[h]||{}),
  getTransaction:async h=>parents[h]??(h===P||h===Q?parent():children[P]?.[h]??children[Q]?.[h]),
});
const verify=(c:any, p=P, s?:PayoutDeliveryServices)=>verifyTriggeredPayoutDelivery(p,R,A,s||services({[p]:{"0xc":c}}));

describe("triggered payout delivery verification",()=>{
  it("confirms one exact credited child",async()=>expect(await verify(child())).toMatchObject({state:"CONFIRMED",reason:"DELIVERY_CONFIRMED",childHash:"0xc"}));
  it.each([["pending","PENDING"],["accepted","ACCEPTED"],["malformed",7]])("rejects non-final parent %s",async(_,status)=>{
    const called=vi.fn(async()=>["0xc"]), r=await verifyTriggeredPayoutDelivery(P,R,A,{getTriggeredTransactionIds:called,getTransaction:async h=>h===P?parent({statusName:status}):child()});
    expect(r).toMatchObject({state:"PENDING_OR_UNVERIFIED",reason:"PARENT_NOT_FINALIZED"}); expect(called).not.toHaveBeenCalled();
  });
  it.each([["missing",(()=>{const{txExecutionResultName,...x}=parent();return x})(),"PARENT_EXECUTION_UNVERIFIED"],["malformed",parent({txExecutionResultName:7}),"PARENT_EXECUTION_UNVERIFIED"],["failed",parent({txExecutionResultName:"REVERTED"}),"PARENT_EXECUTION_FAILED"]])("rejects parent execution %s",async(_,p,reason)=>expect(await verifyTriggeredPayoutDelivery(P,R,A,services({[P]:{"0xc":child()}},{[P]:p}))).toMatchObject({reason,state:reason==="PARENT_EXECUTION_FAILED"?"FAILED_OR_UNCREDITED":"PENDING_OR_UNVERIFIED"}));
  it("rejects malformed parent without lookup",async()=>{const get=vi.fn(), t=vi.fn(); const r=await verifyTriggeredPayoutDelivery("0xabc",R,A,{getTransaction:get,getTriggeredTransactionIds:t}); expect(r).toMatchObject({state:"PENDING_OR_UNVERIFIED",reason:"MALFORMED_PARENT"}); expect(get).not.toHaveBeenCalled(); expect(t).not.toHaveBeenCalled()});
  it("rejects no child",async()=>expect(await verifyTriggeredPayoutDelivery(P,R,A,services({[P]:{}}))).toMatchObject({reason:"NO_TRIGGERED_CHILD",state:"PENDING_OR_UNVERIFIED"}));
  it.each([["recipient",{recipient:"0x0000000000000000000000000000000000000002"}],["amount",{value:"2"}],["bad recipient",{recipient:"bad"}],["bad amount",{value:"1e18"}]])("rejects child %s",async(_,x)=>expect(await verify(child(x))).toMatchObject({reason:"NO_MATCHING_CHILD",state:"PENDING_OR_UNVERIFIED"}));
  it.each([["pending","PENDING"],["accepted","ACCEPTED"],["malformed",7]])("rejects child finality %s",async(_,status)=>expect(await verify(child({statusName:status}))).toMatchObject({reason:"CHILD_NOT_FINALIZED",state:"PENDING_OR_UNVERIFIED"}));
  it("rejects failed child",async()=>expect(await verify(child({txExecutionResultName:"REVERTED"}))).toMatchObject({reason:"CHILD_EXECUTION_FAILED",state:"FAILED_OR_UNCREDITED"}));
  it.each([["false",false,"VALUE_NOT_CREDITED","FAILED_OR_UNCREDITED"],["missing",undefined,"VALUE_CREDIT_UNVERIFIED","PENDING_OR_UNVERIFIED"],["malformed","true","VALUE_CREDIT_UNVERIFIED","PENDING_OR_UNVERIFIED"]])("requires value credit %s",async(_,v,reason,state)=>{const c=v===undefined?(()=>{const{value_credited,...x}=child();return x})():child({value_credited:v}); expect(await verify(c)).toMatchObject({reason,state})});
  it("selects one match and rejects ambiguity",async()=>{const one=await verifyTriggeredPayoutDelivery(P,R,A,services({[P]:{"0xa":child({recipient:"0x0000000000000000000000000000000000000002"}),"0xb":child()}})); expect(one).toMatchObject({state:"CONFIRMED",childHash:"0xb"}); const many=await verifyTriggeredPayoutDelivery(P,R,A,services({[P]:{"0xa":child(),"0xb":child()}})); expect(many).toMatchObject({state:"PENDING_OR_UNVERIFIED",reason:"AMBIGUOUS_MATCHING_CHILD"})});
  it("binds parent namespace and rejects rescue",async()=>{const s=services({[P]:{"0xa":child()},[Q]:{"0xb":child({value:"2"})}}); expect(await verifyTriggeredPayoutDelivery(P,R,A,s)).toMatchObject({state:"CONFIRMED",childHash:"0xa"}); expect(await verifyTriggeredPayoutDelivery(Q,R,A,s)).toMatchObject({reason:"NO_MATCHING_CHILD"}); const t=vi.fn(async()=>["0xc"]),r=await verifyTriggeredPayoutDelivery(P,R,A,{getTriggeredTransactionIds:t,getTransaction:async h=>h===P?parent({txExecutionResultName:"REVERTED"}):child()}); expect(r).toMatchObject({reason:"PARENT_EXECUTION_FAILED"}); expect(t).not.toHaveBeenCalled()});
  it("fails closed for malformed target and parent success alone",async()=>{expect(await verifyTriggeredPayoutDelivery(P,"bad",A,services({[P]:{"0xc":child()}}))).toMatchObject({reason:"MALFORMED_CHILD"}); expect(await verify(child({value_credited:false}))).toMatchObject({reason:"VALUE_NOT_CREDITED"})});
});

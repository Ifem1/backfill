import {describe, expect, it, vi} from "vitest";
import {getPendingTransactions, selectTriggeredTransfer, verifyTriggeredPayoutDelivery, writeAndConfirm, type PayoutDeliveryServices} from "../../lib/genlayer/client";
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

const parentA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const parentB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const recipient = "0x0000000000000000000000000000000000000001";
const amount = 1000000000000000000n;

function deliveredChild(overrides: Record<string, unknown> = {}) {
  return {recipient, value: amount.toString(), statusName: "FINALIZED", txExecutionResultName: "SUCCESS", value_credited: true, ...overrides};
}

function finalizedParent(overrides: Record<string, unknown> = {}) {
  return {statusName: "FINALIZED", txExecutionResultName: "SUCCESS", ...overrides};
}

function deliveryServices(childrenByParent: Record<string, Record<string, unknown>>, parentsByHash: Record<string, unknown> = Object.fromEntries(Object.keys(childrenByParent).map(hash => [hash, finalizedParent()]))) : PayoutDeliveryServices {
  return {
    getTriggeredTransactionIds: async parent => Object.keys(childrenByParent[parent] || {}),
    getTransaction: async hash => parentsByHash[hash] ?? Object.values(childrenByParent).flatMap(children => Object.entries(children)).find(([id]) => id === hash)?.[1],
  };
}

describe("triggered payout delivery verification", () => {
  it("confirms only a finalized, successful parent and child with the exact recipient, amount, and credited value", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, `0x${recipient.slice(2).toUpperCase()}`, amount, deliveryServices({[parentA]: {"0xchild": deliveredChild()}}));
    expect(result).toMatchObject({state: "CONFIRMED", reason: "DELIVERY_CONFIRMED", parentHash: parentA, childHash: "0xchild"});
  });

  it.each([
    ["pending", finalizedParent({statusName: "PENDING"}), "PARENT_NOT_FINALIZED"],
    ["accepted but non-finalized", finalizedParent({statusName: "ACCEPTED"}), "PARENT_NOT_FINALIZED"],
    ["malformed finality", finalizedParent({statusName: 7}), "PARENT_NOT_FINALIZED"],
  ])("does not inspect children for a %s parent", async (_label, parent, reason) => {
    const triggered = vi.fn(async () => ["0xchild"]);
    const services: PayoutDeliveryServices = {getTriggeredTransactionIds: triggered, getTransaction: async hash => hash === parentA ? parent : deliveredChild()};
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, services);
    expect(result).toMatchObject({state: "PENDING_OR_UNVERIFIED", reason});
    expect(triggered).not.toHaveBeenCalled();
  });

  it("does not confirm a finalized parent with failed execution", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": deliveredChild()}}, {[parentA]: finalizedParent({txExecutionResultName: "REVERTED"})}));
    expect(result).toMatchObject({state: "FAILED_OR_UNCREDITED", reason: "PARENT_EXECUTION_FAILED"});
  });

  it.each([
    ["missing", (() => { const {txExecutionResultName: _execution, ...parent} = finalizedParent(); return parent; })()],
    ["malformed", finalizedParent({txExecutionResultName: 7})],
  ])("fails closed when parent execution evidence is %s", async (_label, parent) => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": deliveredChild()}}, {[parentA]: parent}));
    expect(result).toMatchObject({state: "PENDING_OR_UNVERIFIED", reason: "PARENT_EXECUTION_UNVERIFIED"});
  });

  it("rejects a malformed or non-32-byte parent hash before lookup", async () => {
    const getTransaction = vi.fn(async () => finalizedParent());
    const triggered = vi.fn(async () => ["0xchild"]);
    const result = await verifyTriggeredPayoutDelivery("0xabc", recipient, amount, {getTransaction, getTriggeredTransactionIds: triggered});
    expect(result).toMatchObject({state: "PENDING_OR_UNVERIFIED", reason: "MALFORMED_PARENT"});
    expect(getTransaction).not.toHaveBeenCalled();
    expect(triggered).not.toHaveBeenCalled();
  });

  it("does not confirm a parent with no triggered child", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {}}));
    expect(result.state).not.toBe("CONFIRMED");
    expect(result.reason).toBe("NO_TRIGGERED_CHILD");
  });

  it.each([
    ["different recipient", deliveredChild({recipient: "0x0000000000000000000000000000000000000002"})],
    ["different amount", deliveredChild({value: "999"})],
    ["malformed recipient", deliveredChild({recipient: "not-an-address"})],
    ["malformed amount", deliveredChild({value: "1e18"})],
  ])("does not confirm a child with %s", async (_label, child) => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": child}}));
    expect(result.state).not.toBe("CONFIRMED");
  });

  it.each([
    ["pending", deliveredChild({statusName: "PENDING"})],
    ["accepted but not finalized", deliveredChild({statusName: "ACCEPTED"})],
    ["malformed finality", deliveredChild({statusName: 7})],
  ])("does not confirm a child that is %s", async (_label, child) => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": child}}));
    expect(result).toMatchObject({state: "PENDING_OR_UNVERIFIED", reason: "CHILD_NOT_FINALIZED"});
  });

  it("does not confirm a finalized child with failed execution", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": deliveredChild({txExecutionResultName: "REVERTED"})}}));
    expect(result).toMatchObject({state: "FAILED_OR_UNCREDITED", reason: "CHILD_EXECUTION_FAILED"});
  });

  it.each([
    ["false", deliveredChild({value_credited: false}), "FAILED_OR_UNCREDITED", "VALUE_NOT_CREDITED"],
    ["missing", (() => { const {value_credited: _valueCredited, ...child} = deliveredChild(); return child; })(), "PENDING_OR_UNVERIFIED", "VALUE_CREDIT_UNVERIFIED"],
    ["malformed", deliveredChild({value_credited: "true"}), "PENDING_OR_UNVERIFIED", "VALUE_CREDIT_UNVERIFIED"],
  ])("fails closed when value credit is %s", async (_label, child, state, reason) => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": child}}));
    expect(result).toMatchObject({state, reason});
  });

  it("selects the one exact child from the parent's triggered set", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {
      "0xunrelated": deliveredChild({recipient: "0x0000000000000000000000000000000000000002"}),
      "0xdelivery": deliveredChild(),
    }}));
    expect(result).toMatchObject({state: "CONFIRMED", childHash: "0xdelivery"});
  });

  it("fails closed when multiple triggered children plausibly match", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {
      "0xdelivery-one": deliveredChild(), "0xdelivery-two": deliveredChild(),
    }}));
    expect(result).toMatchObject({state: "PENDING_OR_UNVERIFIED", reason: "AMBIGUOUS_MATCHING_CHILD"});
  });

  it("binds evidence to the supplied parent transaction", async () => {
    const services = deliveryServices({[parentA]: {"0xchild-a": deliveredChild()}, [parentB]: {"0xchild-b": deliveredChild({value: "2"})}});
    await expect(verifyTriggeredPayoutDelivery(parentA, recipient, amount, services)).resolves.toMatchObject({state: "CONFIRMED", childHash: "0xchild-a"});
    await expect(verifyTriggeredPayoutDelivery(parentB, recipient, amount, services)).resolves.toMatchObject({state: "PENDING_OR_UNVERIFIED", reason: "NO_MATCHING_CHILD"});
  });

  it("cannot turn an invalid parent into delivery by exposing a valid child namespace", async () => {
    const triggered = vi.fn(async () => ["0xchild"]);
    const services: PayoutDeliveryServices = {
      getTriggeredTransactionIds: triggered,
      getTransaction: async hash => hash === parentA ? finalizedParent({txExecutionResultName: "REVERTED"}) : deliveredChild(),
    };
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, services);
    expect(result).toMatchObject({state: "FAILED_OR_UNCREDITED", reason: "PARENT_EXECUTION_FAILED"});
    expect(triggered).not.toHaveBeenCalled();
  });

  it("does not treat parent success as payout delivery without a valid credited child", async () => {
    const result = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": deliveredChild({value_credited: false})}}));
    expect(result.state).not.toBe("CONFIRMED");
  });

  it("does not let address case normalization accept a malformed or contradictory address", async () => {
    const malformed = await verifyTriggeredPayoutDelivery(parentA, "not-an-address", amount, deliveryServices({[parentA]: {"0xchild": deliveredChild()}}));
    const contradictory = await verifyTriggeredPayoutDelivery(parentA, recipient, amount, deliveryServices({[parentA]: {"0xchild": deliveredChild({to: "0x0000000000000000000000000000000000000002"})}}));
    expect(malformed.state).not.toBe("CONFIRMED");
    expect(contradictory.state).not.toBe("CONFIRMED");
  });
});

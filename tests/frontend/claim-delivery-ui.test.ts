import {describe, expect, it} from "vitest";
import {isPayoutSettlementActive, payoutDeliveryPresentation} from "../../lib/ui/payout-delivery";
import type {PayoutDelivery} from "../../lib/genlayer/client";

const parentHash = `0x${"a".repeat(64)}`;
const childHash = `0x${"b".repeat(64)}`;
function result(state: PayoutDelivery["state"], reason: PayoutDelivery["reason"], child = false): PayoutDelivery {
  return {state, reason, parentHash, ...(child ? {childHash} : {})};
}

describe("claim payout delivery presentation", () => {
  it.each(["PENDING", "PAID"])("treats %s as an initiated payout", status => {
    expect(isPayoutSettlementActive(status)).toBe(true);
  });

  it.each(["NONE", undefined, null, "", "UNKNOWN", 1, {}, []])("does not treat %j as an initiated payout", status => {
    expect(isPayoutSettlementActive(status)).toBe(false);
  });

  it("does not claim a payout when no settlement exists", () => {
    expect(payoutDeliveryPresentation(false)).toMatchObject({tone: "neutral", title: "Payout not initiated"});
  });

  it("does not map an uninitiated settlement to delivery or depend on its delivery result", () => {
    const view = payoutDeliveryPresentation(isPayoutSettlementActive("NONE"), parentHash, result("CONFIRMED", "DELIVERY_CONFIRMED", true));
    expect(view).toMatchObject({tone: "neutral", title: "Payout not initiated"});
    expect(view.title).not.toBe("Delivery pending / unverified");
    expect(view.title).not.toBe("Delivery confirmed");
  });

  it("keeps an unavailable parent hash pending and never confirmed", () => {
    const view = payoutDeliveryPresentation(true);
    expect(view).toMatchObject({tone: "pending", title: "Delivery pending / unverified"});
    expect(view.title).not.toContain("confirmed");
  });

  it.each([
    "PARENT_NOT_FINALIZED",
    "PARENT_EXECUTION_UNVERIFIED",
    "NO_TRIGGERED_CHILD",
    "CHILD_NOT_FINALIZED",
    "VALUE_CREDIT_UNVERIFIED",
  ] as const)("maps %s to pending and unverified", reason => {
    expect(payoutDeliveryPresentation(true, parentHash, result("PENDING_OR_UNVERIFIED", reason))).toMatchObject({tone: "pending", title: "Delivery pending / unverified"});
  });

  it("keeps malformed child evidence pending while preserving a verified parent", () => {
    const view = payoutDeliveryPresentation(true, parentHash, result("PENDING_OR_UNVERIFIED", "MALFORMED_CHILD"));
    expect(view).toMatchObject({tone: "pending", title: "Delivery pending / unverified"});
    expect(view.parentState).toBe("Parent claim finalized and execution verified.");
  });

  it.each([
    ["PARENT_EXECUTION_FAILED", "The authoritative payout path did not complete successfully."],
    ["CHILD_EXECUTION_FAILED", "The authoritative payout path did not complete successfully."],
    ["VALUE_NOT_CREDITED", "The matching external transfer was not credited."],
  ] as const)("maps %s to explicit failed or uncredited delivery", (reason, message) => {
    expect(payoutDeliveryPresentation(true, parentHash, result("FAILED_OR_UNCREDITED", reason, true))).toMatchObject({tone: "failed", title: "Delivery failed / uncredited", message, childHash});
  });

  it("keeps an explicitly failed parent distinct from child delivery evidence", () => {
    const view = payoutDeliveryPresentation(true, parentHash, result("FAILED_OR_UNCREDITED", "PARENT_EXECUTION_FAILED"));
    expect(view).toMatchObject({tone: "failed", title: "Delivery failed / uncredited"});
    expect(view.parentState).toBe("Parent claim finality or execution is not authoritatively verified.");
  });

  it("uses confirmed language and the child hash only for confirmed delivery", () => {
    const confirmed = payoutDeliveryPresentation(true, parentHash, result("CONFIRMED", "DELIVERY_CONFIRMED", true));
    expect(confirmed).toMatchObject({tone: "confirmed", title: "Delivery confirmed", childHash});
    const pending = payoutDeliveryPresentation(true, parentHash, result("PENDING_OR_UNVERIFIED", "NO_MATCHING_CHILD"));
    expect(pending.title).not.toBe("Delivery confirmed");
  });

  it("keeps parent execution conceptually distinct from external delivery", () => {
    const pending = payoutDeliveryPresentation(true, parentHash, result("PENDING_OR_UNVERIFIED", "NO_TRIGGERED_CHILD"));
    expect(pending.message).toContain("Parent execution and external GEN credit");
    expect(pending.parentState).toBe("Parent claim finalized and execution verified.");
    expect(payoutDeliveryPresentation(true, parentHash, result("PENDING_OR_UNVERIFIED", "PARENT_NOT_FINALIZED")).parentState).toContain("not authoritatively verified");
  });
});

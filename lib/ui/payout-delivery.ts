import type {PayoutDelivery,PayoutDeliveryReason} from "@/lib/genlayer/client";
export type PayoutDeliveryPresentation={tone:"neutral"|"pending"|"confirmed"|"failed";title:string;message:string;parentState:string;childHash?:string};
const pending=new Set<PayoutDeliveryReason>(["MALFORMED_PARENT","PARENT_NOT_FINALIZED","PARENT_EXECUTION_UNVERIFIED","NO_TRIGGERED_CHILD","NO_MATCHING_CHILD","AMBIGUOUS_MATCHING_CHILD","CHILD_NOT_FINALIZED","VALUE_CREDIT_UNVERIFIED","MALFORMED_CHILD"]);
export function isPayoutSettlementActive(status:unknown){return status==="PENDING"||status==="PAID"}
export function payoutDeliveryPresentation(active:boolean,parentHash?:string,delivery?:PayoutDelivery):PayoutDeliveryPresentation{
 if(!active)return{tone:"neutral",title:"Payout not initiated",message:"No canonical payout settlement is recorded for this claim.",parentState:"No parent claim transaction is recorded."};
 if(!parentHash)return{tone:"pending",title:"Delivery pending / unverified",message:"No authoritative parent claim transaction is available in this browser. Parent execution and external GEN credit are separate events.",parentState:"Parent claim provenance unavailable in this browser."};
 if(!delivery)return{tone:"pending",title:"Delivery pending / unverified",message:"Authoritative delivery evidence is being checked. Parent execution alone is not proof of external GEN credit.",parentState:"Parent claim finality and execution are being checked."};
 const pf=["MALFORMED_PARENT","PARENT_NOT_FINALIZED","PARENT_EXECUTION_UNVERIFIED","PARENT_EXECUTION_FAILED"].includes(delivery.reason),ps=pf?"Parent claim finality or execution is not authoritatively verified.":"Parent claim finalized and execution verified.";
 if(delivery.state==="CONFIRMED")return{tone:"confirmed",title:"Delivery confirmed",message:"The finalized parent claim produced a finalized external GEN transfer with authoritative value-credit evidence.",parentState:ps,childHash:delivery.childHash};
 if(delivery.state==="FAILED_OR_UNCREDITED")return{tone:"failed",title:"Delivery failed / uncredited",message:delivery.reason==="VALUE_NOT_CREDITED"?"The matching external transfer was not credited.":"The authoritative payout path did not complete successfully.",parentState:ps,childHash:delivery.childHash};
 return{tone:"pending",title:"Delivery pending / unverified",message:"Authoritative delivery evidence is unavailable or incomplete. Parent execution and external GEN credit remain distinct.",parentState:ps,childHash:delivery.childHash};
}

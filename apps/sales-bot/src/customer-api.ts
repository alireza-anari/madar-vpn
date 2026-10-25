import { boundedText } from "./auth";
import { authenticateMiniApp } from "./miniapp-auth";
import { savePayment } from "./plans";
import { enqueue } from "./telegram";
import { requireSalesAdmin } from "./resellers";
import {
  availableCustomerNodes, approveCustomerOrder, createCustomerOrder, customerConfig,
  customerPlans, getCustomerOrderForAdmin, listCustomerOrders, paymentInstructions,
  rejectCustomerOrder, requestCustomerReceipt, saveCustomerPlan,
} from "./customer-store";

const json = (value: unknown, status = 200) =>
  Response.json(value, {status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});
const parse = async (req:Request) => JSON.parse(await boundedText(req,12000)) as Record<string,unknown>;

export async function customerApi(req:Request,env:Env,now:number):Promise<Response> {
  try {
    const actor=await authenticateMiniApp(req.headers.get("X-Telegram-Init-Data") || "",env,now);
    const path=new URL(req.url).pathname;
    const url=new URL(req.url);
    // Reject all administrative paths before resolving any order IDs.
    if (path.startsWith("/api/customer/admin/")) requireSalesAdmin(actor);
    if (req.method==="GET") {
      if (path==="/api/customer/me") return json({role:actor.role,telegramId:actor.telegramId});
      if (path==="/api/customer/payment") return json({payment:await paymentInstructions(env.SALES_DB)});
      if (path==="/api/customer/plans")
        return json({plans:await customerPlans(env.SALES_DB),paymentConfigured:!!(await paymentInstructions(env.SALES_DB))});
      if (path==="/api/customer/nodes") {
        const planId=url.searchParams.get("planId") || "";
        const plan=(await customerPlans(env.SALES_DB)).find(p=>p.id===planId);
        if (!plan) throw Error("PLAN_UNAVAILABLE");
        return json(await availableCustomerNodes(env.SALES_DB,now,plan.quotaBytes));
      }
      if (path==="/api/customer/orders") return json(await listCustomerOrders(env.SALES_DB,actor));
      const config=path.match(/^\/api\/customer\/orders\/([^/]+)\/config$/);
      if (config) return json(await customerConfig(env,actor,decodeURIComponent(config[1]!),now));
      if (path==="/api/customer/admin/plans") {
        const rows=await env.SALES_DB.prepare("SELECT id,name,price,currency,duration,enabled,quota_bytes FROM plans ORDER BY id LIMIT 100").all();
        return json(rows.results);
      }
      if (path==="/api/customer/admin/orders") {
        const rows=await env.SALES_DB.prepare("SELECT id,user_id,plan_id,price,currency,state,created_at FROM customer_orders WHERE state IN ('pending_review','approving') ORDER BY created_at LIMIT 50").all();
        return json(rows.results);
      }
      return json({error:"NOT_FOUND"},404);
    }
    if (req.method==="POST") {
      if (path==="/api/customer/orders") {
        const input=await parse(req);
        const order=await createCustomerOrder(env.SALES_DB,actor,{
          planId:input.planId as string,nodeId:input.nodeId as string,requestKey:input.requestKey as string,
        },now);
        return json({id:order.id,state:order.state,price:order.price,currency:order.currency,
          quotaBytes:order.quota_bytes,durationSeconds:order.duration_seconds,
          payment:await paymentInstructions(env.SALES_DB)},201);
      }
      const receipt=path.match(/^\/api\/customer\/orders\/([^/]+)\/receipt-request$/);
      if (receipt) {
        const id=decodeURIComponent(receipt[1]!);
        await requestCustomerReceipt(env.SALES_DB,actor,id);
        await enqueue(env.SALES_DB,"customer-receipt-start:"+id,actor.telegramId,{
          text:"📸 رسید پرداخت سفارش "+id+" را همین‌جا به صورت عکس یا فایل بفرستید. تا زمانی که مدیر پرداخت را بررسی نکند، کانفیگی صادر نمی‌شود.",
        });
        return json({ok:true});
      }
      if (path==="/api/customer/admin/plans") {
        const input=await parse(req);
        await saveCustomerPlan(env.SALES_DB,actor,input as any,now);
        return json({ok:true});
      }
      if (path==="/api/customer/admin/payment") {
        const input=await parse(req);
        if (typeof input.value!=="string") throw Error("INVALID_PAYMENT");
        await savePayment(env.SALES_DB,{telegramId:actor.telegramId,role:"admin"},input.value,now);
        return json({ok:true});
      }
      const approval=path.match(/^\/api\/customer\/admin\/orders\/([^/]+)\/approve$/);
      if (approval) return json(await approveCustomerOrder(env,actor,decodeURIComponent(approval[1]!),now));
      const reject=path.match(/^\/api\/customer\/admin\/orders\/([^/]+)\/reject$/);
      if (reject) {
        const input=await parse(req);
        if (typeof input.reason!=="string") throw Error("INVALID_REASON");
        await rejectCustomerOrder(env.SALES_DB,actor,decodeURIComponent(reject[1]!),input.reason,now);
        return json({ok:true});
      }
    }
    return json({error:"NOT_FOUND"},404);
  } catch(error) {
    const code=error instanceof Error?error.message:"REQUEST_FAILED";
    if (["INVALID_SIGNATURE","AUTH_EXPIRED","SELLER_DISABLED","ADMIN_REQUIRED"].includes(code))
      return json({error:code},403);
    if (["ORDER_NOT_AVAILABLE","PLAN_UNAVAILABLE"].includes(code)) return json({error:code},404);
    if (["KEY_REUSED","NODE_UNAVAILABLE","NODE_FULL","NODE_ALLOCATION_FULL","NODE_SLOT_LIMIT","SELLER_ACCOUNT_LIMIT","SELLER_ALLOCATION_FULL","SALES_DISABLED","PENDING_ORDER_EXISTS"].includes(code))
      return json({error:code},409);
    if (["INVALID_INPUT","INVALID_PLAN","INVALID_PAYMENT","INVALID_REASON","INVALID_RECEIPT"].includes(code) || error instanceof SyntaxError)
      return json({error:code==="REQUEST_FAILED"?"INVALID_INPUT":code},400);
    return json({error:"REQUEST_FAILED"},500);
  }
}

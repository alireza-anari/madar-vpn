import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";
import {
  approveCustomerOrder, availableCustomerNodes, createCustomerOrder, customerConfig,
  customerPlans, getCustomerOrderForAdmin, listCustomerOrders, paymentInstructions,
  rejectCustomerOrder, requestCustomerReceipt, submitCustomerReceipt,
} from "./customer-store";

const callback=(label:string,data:string)=>({text:label,callback_data:data});
const NODE_STATE_PREFIX="customer-node-list:";
type NodeChoice={id:string;name:string};
type NodeState={flow:"customer-node-list";planId:string;nodes:NodeChoice[];nonce:string};
const money=(price:number,currency:string)=>price.toLocaleString("fa-IR")+" "+(currency==="IRT"?"تومان":"ریال");
const gb=(bytes:number)=>Math.max(1,Math.round(bytes/1e9)).toLocaleString("fa-IR")+" گیگابایت";
const traffic=(bytes:number|null)=>((Math.max(0,bytes||0)/1e9).toLocaleString("fa-IR",{maximumFractionDigits:1}))+" گیگابایت";
const days=(seconds:number)=>Math.max(1,Math.round(seconds/86400)).toLocaleString("fa-IR")+" روز";
const dateTime=(seconds:number)=>new Date(seconds*1000).toLocaleString("fa-IR",{timeZone:"Asia/Tehran"});
const escapeHtml=(value:string)=>value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const usageBar=(used:number,total:number)=>{
  const ratio=total>0?Math.min(1,Math.max(0,used/total)):0;
  const filled=Math.round(ratio*10);
  return "🟩".repeat(filled)+"⬜".repeat(10-filled);
};
type CustomerOrderView={state:string;accountState:string|null;usedBytes:number|null;quotaBytes:number;validUntil:number|null};
function statusLabel(order:CustomerOrderView,now:number) {
  if(order.state==="awaiting_receipt") return "در انتظار رسید پرداخت";
  if(order.state==="pending_review") return "رسید در حال بررسی";
  if(order.state==="approving") return "در حال آماده‌سازی";
  if(order.state==="approved") {
    if(order.accountState==="revoked") return "دسترسی لغو شده";
    if(order.accountState==="exhausted" || (order.usedBytes!==null && order.quotaBytes>0 && order.usedBytes>=order.quotaBytes)) return "حجم تمام شده";
    if(order.validUntil!==null && order.validUntil<=now) return "اشتراک منقضی";
    if(order.accountState==="active" && order.validUntil!==null && order.validUntil>now) return "اشتراک فعال";
    return "در حال آماده‌سازی کانفیگ";
  }
  if(order.state==="rejected") return "پرداخت رد شده";
  return order.state;
}
function parseNodeState(raw:string):NodeState|null {
  if(!raw.startsWith(NODE_STATE_PREFIX)) return null;
  try {
    const value=JSON.parse(raw.slice(NODE_STATE_PREFIX.length)) as NodeState;
    if(value.flow!=="customer-node-list" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value.planId) ||
      !Array.isArray(value.nodes) || typeof value.nonce!=="string") return null;
    return value;
  } catch { return null; }
}
export async function handleCustomerTelegramUpdate(env:Env,u:TelegramUpdate,now:number):Promise<boolean> {
  const id=u.message?.from?.id ?? u.callback_query?.from.id;
  const chat=u.message?.chat ?? u.callback_query?.message?.chat;
  if (!id || !chat || chat.type!=="private" || chat.id!==id) return false;
  const userId=String(id);
  const actor=await resolveSalesActor(env.SALES_DB,userId,env);
  const data=u.callback_query?.data || "";
  const text=u.message?.text?.trim() || "";
  const command=text.split(/\s+/,1)[0]?.split("@",1)[0] || "";
  const db=env.SALES_DB;
  const reply=(value:string,rows?:Record<string,unknown>[][],extra:Record<string,unknown>={})=>
    enqueue(db,"u"+u.update_id+":reply",userId,{
      text:value,...extra,...(rows?{reply_markup:{inline_keyboard:rows}}:{}),
    });
  const setConversation=async(value:string)=> {
    await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
    await db.prepare("UPDATE users SET conversation=? WHERE id=?").bind(value,userId).run();
  };
  const homeRows:Record<string,unknown>[][]=[
    [callback("🛍️ خرید اشتراک","customer:buy"),callback("🌐 سرویس‌های من","customer:services")],
    [callback("📦 سفارش‌های من","customer:orders:0"),callback("📖 راهنمای اتصال","customer:help")],
  ];

  // Admin reviews the actual Telegram photo/document before confirming any payment.
  if (data.startsWith("cust:") || (actor.role==="admin" && (text==="/receipts" || (!text.startsWith("/") && !!(await db.prepare("SELECT conversation FROM users WHERE id=? AND conversation LIKE 'customer-reject:%'").bind(userId).first()))))) {
    if (actor.role!=="admin") {
      await reply("این بخش فقط برای مدیر است.");
      return true;
    }
    const inboxPage=data.match(/^cust:inbox:(0|[1-9][0-9]{0,2})$/);
    if (data==="/receipts" || data==="cust:inbox" || inboxPage || text==="/receipts") {
      const page=inboxPage?Number(inboxPage[1]):0;
      const pageSize=6;
      const rows=await db.prepare(
        "SELECT o.id,o.user_id,o.price,o.currency,o.created_at,p.name AS plan_name FROM customer_orders o LEFT JOIN plans p ON p.id=o.plan_id WHERE o.state='pending_review' AND EXISTS (SELECT 1 FROM customer_receipts r WHERE r.order_id=o.id) ORDER BY o.created_at,o.id LIMIT ? OFFSET ?",
      ).bind(pageSize+1,page*pageSize).all<{id:string;user_id:string;price:number;currency:string;created_at:number;plan_name:string|null}>();
      const visible=rows.results.slice(0,pageSize);
      const keyboard:Record<string,unknown>[][]=visible.map((order,i)=>[
        callback(`💳 ${(page*pageSize+i+1).toLocaleString("fa-IR")}. ${money(order.price,order.currency)} · ${order.id.slice(0,8)}`,
          "cust:review:"+order.id),
      ]);
      const navigation:Record<string,unknown>[]=[];
      if(page>0) navigation.push(callback("◀️ قبلی","cust:inbox:"+(page-1)));
      if(rows.results.length>pageSize && page<999) navigation.push(callback("بعدی ▶️","cust:inbox:"+(page+1)));
      if(navigation.length) keyboard.push(navigation);
      keyboard.push([callback("🔄 تازه‌سازی","cust:inbox:"+page)]);
      keyboard.push([callback("🏠 منوی اصلی","rs:home")]);
      await reply(visible.length?
        "💳 رسیدهای در انتظار تأیید\nروی هر سفارش بزن تا عکس یا فایل رسید را ببینی و سپس تأیید یا رد کنی.\nقبل از تأیید، واریز واقعی را از حساب بانکی بررسی کن.":
        page>0?"در این صفحه رسیدی وجود ندارد. به صفحه قبلی برگرد.":"✅ فعلاً هیچ رسیدی در انتظار تأیید نیست.",keyboard);
      return true;
    }
    const match=data.match(/^cust:(review|approve|reject):([a-f0-9-]{36})$/);
    try {
      if (match) {
        const [,action,orderId]=match;
        const order=await getCustomerOrderForAdmin(db,actor,orderId!);
        if (!order) throw Error("ORDER_NOT_AVAILABLE");
        if (action==="review") {
          const canDecide=order.state==="pending_review" && !!order.file_id;
          await reply("سفارش "+order.id+"\nمشتری: "+order.user_id+
            "\nمبلغ: "+money(order.price,order.currency)+
            "\nوضعیت: "+order.state+
            "\nرسید را بررسی کنید و فقط بعد از اطمینان از واریز، تأیید کنید.",[
            ...(canDecide?[
              [callback("✅ تأیید پرداخت","cust:approve:"+order.id)],
              [callback("❌ رد پرداخت","cust:reject:"+order.id)],
            ]:[]),
            [callback("💳 رسیدهای در انتظار","cust:inbox:0")],
          ]);
          if (order.file_id && order.kind)
            await enqueue(db,"u"+u.update_id+":customer-proof",userId,{
              _method:order.kind==="photo"?"sendPhoto":"sendDocument",
              [order.kind==="photo"?"photo":"document"]:order.file_id,
              caption:"رسید سفارش "+order.id,
            });
          return true;
        }
        if (action==="approve") {
          await approveCustomerOrder(env,actor,orderId!,now);
          await reply("✅ پرداخت تأیید و صدور کانفیگ درخواست شد. فعال‌شدن پس از ACK سرور خواهد بود.",[[callback("💳 رسیدهای در انتظار","cust:inbox:0")]]);
          return true;
        }
        await setConversation("customer-reject:"+orderId);
        await reply("دلیل رد سفارش را ارسال کنید.");
        return true;
      }
      const state=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation");
      if (state?.startsWith("customer-reject:") && text && !text.startsWith("/")) {
        await rejectCustomerOrder(db,actor,state.slice(16),text,now);
        await setConversation("");
        await reply("❌ سفارش رد شد و مشتری مطلع شد.",[[callback("💳 رسیدهای در انتظار","cust:inbox:0")]]);
        return true;
      }
    } catch(error) {
      const code=error instanceof Error?error.message:"";
      const expected=["ORDER_NOT_AVAILABLE","NODE_FULL","NODE_UNAVAILABLE","NODE_ALLOCATION_FULL","SELLER_ALLOCATION_FULL","SELLER_ACCOUNT_LIMIT"];
      if (!expected.includes(code)) throw error;
      await reply("امکان تأیید نیست: "+code+"؛ ظرفیت سرور یا وضعیت سفارش را بررسی کنید.");
      return true;
    }
    await reply("درخواست نامعتبر است.");
    return true;
  }

  if(actor.role!=="ordinary") return false;
  // Preserve reseller invitation deep links for the existing reseller workflow.
  if(command==="/start" && text.startsWith("/start seller_")) return false;
  await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
  const state=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation");

  if(["/start","/menu","/cancel"].includes(command) || data==="customer:home") {
    await setConversation("");
    const welcome="✨ <b>مدار | فروشگاه VPN</b>\n\nاشتراک با حجم و مدت مشخص؛ از انتخاب پلن تا دریافت کانفیگ، همه‌چیز در همین چت.\n\n👇 از منوی زیر شروع کن.";
    if(command==="/start" && env.PUBLIC_BASE_URL) {
      await enqueue(db,"u"+u.update_id+":reply",userId,{
        _method:"sendPhoto",
        photo:new URL("/madar-logo.png",env.PUBLIC_BASE_URL).toString(),
        caption:welcome,
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:homeRows},
      });
    } else {
      await reply(welcome,homeRows,{parse_mode:"HTML"});
    }
    return true;
  }

  if(data==="customer:buy" || command==="/buy") {
    await setConversation("");
    const pending=await db.prepare("SELECT id,price,currency FROM customer_orders WHERE user_id=? AND state='awaiting_receipt' ORDER BY created_at DESC,id DESC LIMIT 6")
      .bind(userId).all<{id:string;price:number;currency:string}>();
    if(pending.results.length) {
      const rows:Record<string,unknown>[][]=pending.results.map(order=>[
        callback("📸 ادامه · "+money(order.price,order.currency),"customer:receipt:"+order.id),
        callback("🔎 جزئیات","customer:order:"+order.id),
      ]);
      rows.push([callback("📦 همه سفارش‌ها","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]);
      await reply("🧾 هنوز برای سفارش باز رسید ثبت نشده است. برای جلوگیری از اشتباه، اول سفارش قبلی را ادامه بده و رسید همان سفارش را ارسال کن.",rows);
      return true;
    }
    if(!(await paymentInstructions(db))) {
      await reply("خرید در حال حاضر فعال نیست؛ اطلاعات پرداخت باید توسط مدیر تنظیم شود.",[[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const plans=await customerPlans(db);
    if(!plans.length) {
      await reply("فعلاً پلن فعالی برای خرید وجود ندارد.",[[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const rows:Record<string,unknown>[][]=plans.map(p=>[
      callback(`📦 ${p.name.slice(0,18)} · ${Math.round(p.quotaBytes/1e9).toLocaleString("fa-IR")}GB · ${Math.round(p.durationSeconds/86400).toLocaleString("fa-IR")}روز · ${money(p.price,p.currency)}`, "customer:plan:"+p.id),
    ]);
    rows.push([callback("🏠 منوی اصلی","customer:home")]);
    const details=plans.map(p=>"<b>"+escapeHtml(p.name)+"</b>\n📦 حجم: "+gb(p.quotaBytes)+" · ⏳ مدت: "+days(p.durationSeconds)+"\n💳 قیمت: "+money(p.price,p.currency)+" · هر گیگ: "+money(Math.round(p.price/(p.quotaBytes/1e9)),p.currency)).join("\n\n");
    await reply("🛍️ <b>فروشگاه مدار</b>\nپلنی را انتخاب کن که با مصرفت هماهنگ است.\n\n"+details+"\n\nقیمت نهایی قبل از ثبت سفارش نمایش داده می‌شود.",rows,{parse_mode:"HTML"});
    return true;
  }

  const planMatch=data.match(/^customer:plan:([a-zA-Z0-9_-]{1,40})$/);
  if(planMatch) {
    const planId=planMatch[1]!;
    const plan=(await customerPlans(db)).find(p=>p.id===planId);
    if(!plan) {
      await reply("این پلن دیگر فعال نیست. فهرست پلن‌ها را دوباره باز کن.",[[callback("🛍️ پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const nodes=(await availableCustomerNodes(db,now,plan.quotaBytes)).slice(0,100);
    if(!nodes.length) {
      await setConversation("");
      await reply("در حال حاضر سروری با ظرفیت کافی برای این پلن موجود نیست. لطفاً بعداً دوباره بررسی کن.",[[callback("🔄 بررسی دوباره","customer:plan:"+planId)],[callback("🛍️ پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const nodeState:NodeState={flow:"customer-node-list",planId,nodes,nonce:crypto.randomUUID().replaceAll("-","")};
    await setConversation(NODE_STATE_PREFIX+JSON.stringify(nodeState));
    const pageSize=8;
    const rows:Record<string,unknown>[][]=nodes.slice(0,pageSize).map((node,index)=>[
      callback(node.name.slice(0,45),"customer:node:"+planId+":"+index),
    ]);
    if(nodes.length>pageSize) rows.push([callback("سرورهای بعدی ▶️","customer:nodes:"+planId+":1")]);
    rows.push([callback("◀️ بازگشت به پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    await reply("پلن انتخاب‌شده: "+plan.name+"\nحجم: "+gb(plan.quotaBytes)+" · مدت: "+days(plan.durationSeconds)+"\nمبلغ: "+money(plan.price,plan.currency)+"\n\nحالا سرور را انتخاب کن:",rows);
    return true;
  }

  const nodePage=data.match(/^customer:nodes:([a-zA-Z0-9_-]{1,40}):(0|[1-9][0-9]{0,2})$/);
  if(nodePage) {
    const nodeState=state?parseNodeState(state):null;
    const page=Number(nodePage[2]);
    if(!nodeState || nodeState.planId!==nodePage[1]) {
      await reply("این انتخاب منقضی شده؛ لطفاً پلن و سرور را دوباره انتخاب کن.",[[callback("🛍️ شروع خرید","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const pageSize=8,offset=page*pageSize;
    const visible=nodeState.nodes.slice(offset,offset+pageSize);
    if(!visible.length) {
      await reply("این صفحه سرور ندارد.",[[callback("◀️ بازگشت به سرورها","customer:nodes:"+nodeState.planId+":"+Math.max(0,page-1))]]);
      return true;
    }
    const rows:Record<string,unknown>[][]=visible.map((node,i)=>[
      callback(node.name.slice(0,45),"customer:node:"+nodeState.planId+":"+(offset+i)),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:nodes:"+nodeState.planId+":"+(page-1)));
    if(offset+pageSize<nodeState.nodes.length) nav.push(callback("بعدی ▶️","customer:nodes:"+nodeState.planId+":"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("◀️ بازگشت به پلن‌ها","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    await reply("سرور موردنظر را انتخاب کن:",rows);
    return true;
  }

  const nodeMatch=data.match(/^customer:node:([a-zA-Z0-9_-]{1,40}):(0|[1-9][0-9]{0,2})$/);
  if(nodeMatch) {
    const nodeState=state?parseNodeState(state):null;
    const index=Number(nodeMatch[2]);
    if(!nodeState || nodeState.planId!==nodeMatch[1] || !nodeState.nodes[index]) {
      await reply("این انتخاب منقضی شده؛ برای جلوگیری از ثبت سفارش تکراری، خرید را دوباره آغاز کن.",[[callback("🛍️ شروع خرید","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const node=nodeState.nodes[index]!;
    try {
      const order=await createCustomerOrder(db,actor,{planId:nodeState.planId,nodeId:node.id,requestKey:"tg_"+userId+"_"+nodeState.nonce},now);
      await requestCustomerReceipt(db,actor,order.id);
      const payment=await paymentInstructions(db);
      await reply("🧾 سفارش ثبت شد\nشماره سفارش: "+order.id+"\nپلن: "+((await customerPlans(db)).find(p=>p.id===order.plan_id)?.name || order.plan_id)+
        "\nحجم: "+gb(order.quota_bytes)+" · مدت: "+days(order.duration_seconds)+
        "\nمبلغ قابل پرداخت: "+money(order.price,order.currency)+
        "\n\nاطلاعات پرداخت:\n"+(payment||"اطلاعات پرداخت ثبت نشده است.")+
        "\n\nپس از واریز، عکس یا فایل رسید را همین‌جا در چت بفرست. تا تأیید مدیر و آماده‌شدن سرور، کانفیگی صادر نمی‌شود.",
        [[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    } catch(error) {
      const code=error instanceof Error?error.message:"";
      const known=["SALES_DISABLED","PLAN_UNAVAILABLE","NODE_UNAVAILABLE","NODE_FULL","NODE_ALLOCATION_FULL","NODE_SLOT_LIMIT","SELLER_ACCOUNT_LIMIT","SELLER_ALLOCATION_FULL","KEY_REUSED","PENDING_ORDER_EXISTS"];
      if(!known.includes(code)) throw error;
      if(code==="PENDING_ORDER_EXISTS") {
        const pending=await db.prepare("SELECT id,price,currency FROM customer_orders WHERE user_id=? AND state='awaiting_receipt' ORDER BY created_at DESC LIMIT 1")
          .bind(userId).first<{id:string;price:number;currency:string}>();
        await reply("یک سفارش هنوز منتظر رسید است. ابتدا همان سفارش را ادامه بده تا رسید به سفارش اشتباه وصل نشود.",[
          ...(pending?[[callback("📸 ادامه سفارش · "+money(pending.price,pending.currency),"customer:receipt:"+pending.id)]]:[]),
          [callback("📦 سفارش‌های من","customer:orders:0")],
          [callback("🏠 منوی اصلی","customer:home")],
        ]);
        return true;
      }
      await reply(code==="SALES_DISABLED"?"خرید موقتاً غیرفعال است؛ مدیر باید اطلاعات پرداخت را تنظیم کند.":
        code==="PLAN_UNAVAILABLE"?"این پلن دیگر فعال نیست.":
        "ظرفیت این سرور تغییر کرده است؛ سرور دیگری انتخاب کن.",[
          [callback("🔄 انتخاب دوباره سرور","customer:plan:"+nodeState.planId)],
          [callback("🛍️ پلن‌ها","customer:buy")],
          [callback("🏠 منوی اصلی","customer:home")],
        ]);
      return true;
    }
  }

  const servicesPage=data.match(/^customer:services:(0|[1-9][0-9]{0,2})$/);
  if(data==="customer:services" || servicesPage || command==="/services") {
    await setConversation("");
    const all=(await listCustomerOrders(db,actor)).filter(order=>order.state==="approved");
    const page=servicesPage?Number(servicesPage[1]):0;
    const pageSize=6,offset=page*pageSize,visible=all.slice(offset,offset+pageSize);
    const rows:Record<string,unknown>[][]=visible.map(order=>[
      callback(statusLabel(order,now)+" · "+order.planName.slice(0,24),"customer:order:"+order.id),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:services:"+(page-1)));
    if(offset+pageSize<all.length) nav.push(callback("بعدی ▶️","customer:services:"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("🛍️ خرید اشتراک","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    await reply(visible.length?
      "🌐 اشتراک‌های من\nسرویس را انتخاب کن تا وضعیت، مصرف، حجم باقی‌مانده و تاریخ اعتبار را ببینی.":
      "هنوز اشتراک تأییدشده‌ای در حسابت نیست. بعد از تأیید پرداخت، سرویس اینجا نمایش داده می‌شود.",
      rows);
    return true;
  }

  const ordersPage=data.match(/^customer:orders:(0|[1-9][0-9]{0,2})$/);
  if(data==="customer:orders" || ordersPage || command==="/orders") {
    await setConversation("");
    const page=ordersPage?Number(ordersPage[1]):0;
    const all=await listCustomerOrders(db,actor);
    const pageSize=6,offset=page*pageSize,visible=all.slice(offset,offset+pageSize);
    const rows:Record<string,unknown>[][]=visible.map((order,i)=>[
      callback(`${(offset+i+1).toLocaleString("fa-IR")}. ${order.planName.slice(0,22)} · ${statusLabel(order,now)}`,
        "customer:order:"+order.id),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0) nav.push(callback("◀️ قبلی","customer:orders:"+(page-1)));
    if(offset+pageSize<all.length) nav.push(callback("بعدی ▶️","customer:orders:"+(page+1)));
    if(nav.length) rows.push(nav);
    rows.push([callback("🌐 سرویس‌های من","customer:services")],[callback("🛍️ خرید اشتراک","customer:buy")],[callback("🏠 منوی اصلی","customer:home")]);
    await reply(visible.length?"📦 سفارش‌های اخیر تو:\nبرای جزئیات، ادامه پرداخت یا دریافت کانفیگ یک سفارش را انتخاب کن.":"هنوز سفارشی ثبت نکرده‌ای.",rows);
    return true;
  }

  const orderMatch=data.match(/^customer:order:([a-f0-9-]{36})$/);
  if(orderMatch) {
    const order=(await listCustomerOrders(db,actor)).find(o=>o.id===orderMatch[1]);
    if(!order) {
      await reply("این سفارش در حساب تو پیدا نشد.",[[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]]);
      return true;
    }
    const rows:Record<string,unknown>[][]=[];
    if(order.state==="awaiting_receipt") rows.push([callback("📸 ادامه پرداخت و ارسال رسید","customer:receipt:"+order.id)]);
    if(order.state==="approved") rows.push([callback("📥 دریافت کانفیگ","customer:config:"+order.id)]);
    rows.push([callback("🌐 سرویس‌های من","customer:services")],[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]);
    let details="<b>📦 جزئیات سفارش مدار</b>\n\n🔖 شماره: <code>"+order.id+"</code>\n📦 پلن: "+escapeHtml(order.planName)+
      "\n💳 مبلغ: "+money(order.price,order.currency)+"\n📊 حجم کل: "+gb(order.quotaBytes)+
      " · ⏳ مدت: "+days(order.durationSeconds)+"\n📌 وضعیت: <b>"+statusLabel(order,now)+"</b>";
    if(order.serverName) details+="\n🛰️ سرور: "+escapeHtml(order.serverName);
    if(order.state==="approved" && order.accountId) {
      if(order.usedBytes!==null) {
        const used=Math.min(order.quotaBytes,Math.max(0,order.usedBytes));
        const remaining=Math.max(0,order.quotaBytes-used);
        details+="\n\n"+usageBar(used,order.quotaBytes)+"\n📈 مصرف: "+traffic(used)+" از "+gb(order.quotaBytes)+
          "\n🟢 حجم باقی‌مانده: "+traffic(remaining);
      }
      if(order.validUntil!==null) details+="\n⏰ تاریخ انقضا: "+dateTime(order.validUntil);
    }
    if(order.reason) details+="\n\n📝 توضیح مدیر: "+escapeHtml(order.reason);
    await reply(details,rows,{parse_mode:"HTML"});
    return true;
  }

  const receiptMatch=data.match(/^customer:receipt:([a-f0-9-]{36})$/);
  if(receiptMatch) {
    try {
      await requestCustomerReceipt(db,actor,receiptMatch[1]!);
      await reply("📸 حالا عکس یا فایل رسید پرداخت سفارش "+receiptMatch[1]+" را همین‌جا در چت بفرست. پس از بررسی و تأیید مدیر، کانفیگ آماده می‌شود.");
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("این سفارش دیگر منتظر رسید نیست. وضعیت آن را در «سفارش‌های من» بررسی کن.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }

  const configMatch=data.match(/^customer:config:([a-f0-9-]{36})$/);
  if(configMatch) {
    try {
      const result=await customerConfig(env,actor,configMatch[1]!,now);
      if(!result.ready || typeof result.validUntil !== "number" || typeof result.quotaBytes !== "number" || typeof result.config !== "string") {
        await reply("پرداخت تأیید شده؛ کانفیگ هنوز از سرور تأیید نهایی نگرفته است. کمی بعد دوباره بررسی کن.",[
          [callback("🔄 بررسی کانفیگ","customer:config:"+configMatch[1])],
          [callback("📦 سفارش‌های من","customer:orders:0")],
        ]);
        return true;
      }
      const output="<b>✅ اشتراک مدار آماده است</b>\n\n🛰️ <b>سرور:</b> "+escapeHtml(result.serverName)+"\n📦 <b>حجم کل:</b> "+gb(result.quotaBytes)+
        "\n⏰ <b>اعتبار تا:</b> "+dateTime(result.validUntil)+"\n\n<pre>"+escapeHtml(result.config)+"</pre>\n\n🔒 این کانفیگ مخصوص حساب توست؛ آن را برای دیگران ارسال نکن.";
      const rows:Record<string,unknown>[][]=[];
      if(result.config.length<=256) rows.push([{text:"📋 کپی کانفیگ",copy_text:{text:result.config}}]);
      if(result.usageUrl) rows.push([{text:"📊 مصرف و اعتبار",url:result.usageUrl}]);
      rows.push([callback("🌐 سرویس‌های من","customer:services")],[callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")]);
      await reply(output,rows,{parse_mode:"HTML",link_preview_options:{is_disabled:true}});
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await reply("این سفارش یا کانفیگ برای حساب تو در دسترس نیست.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }

  const helpMatch=data.match(/^customer:help:(android|ios|windows|mac)$/);
  if(data==="customer:help" || command==="/help") {
    await reply("📖 راهنمای مدار\n\n<b>خرید:</b> پلن و سرور را انتخاب کن، مبلغ را واریز کن و رسید را در همین چت بفرست. پس از تأیید پرداخت و آماده‌شدن سرور، کانفیگ در دسترس است.\n\n<b>اتصال:</b> سیستم‌عاملت را انتخاب کن تا برنامه سازگار و روش واردکردن کانفیگ را ببینی.",[
      [callback("🤖 اندروید","customer:help:android"),callback("🍎 آیفون و آیپد","customer:help:ios")],
      [callback("💻 ویندوز","customer:help:windows"),callback("🖥️ مک","customer:help:mac")],
      [callback("🛍️ خرید اشتراک","customer:buy")],[callback("🏠 منوی اصلی","customer:home")],
    ],{parse_mode:"HTML"});
    return true;
  }
  if(helpMatch) {
    const guides={
      android:{title:"🤖 اندروید · v2rayNG",url:"https://github.com/2dust/v2rayNG/releases",source:"دانلود v2rayNG از GitHub رسمی",steps:"۱) برنامه را از صفحه رسمی دانلود و نصب کن.\n۲) در مدار، کانفیگ را کپی کن.\n۳) در v2rayNG گزینه Import from clipboard را بزن.\n۴) سرور را انتخاب کن و اتصال را روشن کن."},
      ios:{title:"🍎 آیفون و آیپد · V2Box",url:"https://apps.apple.com/app/v2box-v2ray-client/id6446814690",source:"مشاهده V2Box در App Store",steps:"۱) V2Box را از App Store نصب کن.\n۲) کانفیگ را از مدار کپی کن.\n۳) در برنامه گزینه افزودن یا واردکردن از Clipboard را انتخاب کن.\n۴) پروفایل را فعال کن."},
      windows:{title:"💻 ویندوز · v2rayN",url:"https://github.com/2dust/v2rayN/releases",source:"دانلود v2rayN از GitHub رسمی",steps:"۱) نسخه مناسب ویندوز را از صفحه رسمی بگیر و استخراج کن.\n۲) کانفیگ را در مدار کپی کن.\n۳) در v2rayN گزینه Import share link from clipboard را انتخاب کن.\n۴) پروفایل را فعال کن و اتصال را روشن کن."},
      mac:{title:"🖥️ مک · V2Box",url:"https://apps.apple.com/app/v2box-v2ray-client/id6446814690",source:"مشاهده V2Box در App Store",steps:"۱) V2Box را از App Store نصب کن.\n۲) کانفیگ را از مدار کپی کن.\n۳) در برنامه آن را از Clipboard وارد کن.\n۴) پروفایل را فعال کن."},
    } as const;
    const guide=guides[helpMatch[1] as keyof typeof guides];
    await reply("<b>"+guide.title+"</b>\n\n"+guide.steps+"\n\nاگر اتصال برقرار نشد، اول مطمئن شو اشتراک منقضی یا تمام‌حجم نشده باشد.",[
      [{text:"⬇️ "+guide.source,url:guide.url}],
      [callback("↩️ انتخاب دستگاه دیگر","customer:help")],
      [callback("🌐 سرویس‌های من","customer:services")],[callback("🏠 منوی اصلی","customer:home")],
    ],{parse_mode:"HTML",link_preview_options:{is_disabled:true}});
    return true;
  }

  if(state?.startsWith("customer-receipt:") && (u.message?.photo?.length || u.message?.document)) {
    const orderId=state.slice("customer-receipt:".length);
    const fileId=u.message?.document?.file_id ?? u.message?.photo?.at(-1)?.file_id ?? "";
    try {
      const accepted=await submitCustomerReceipt(db,userId,orderId,fileId,u.message?.document?"document":"photo");
      await setConversation("");
      await reply(accepted?"✅ رسید ثبت شد و برای بررسی مدیر ارسال شد. نتیجه را از «سفارش‌های من» پیگیری کن.":"این سفارش قبلاً رسید دارد و در انتظار بررسی مدیر است.",[
        [callback("📦 سفارش‌های من","customer:orders:0")],[callback("🏠 منوی اصلی","customer:home")],
      ]);
      if(accepted) for(const adminId of (env.ADMIN_TELEGRAM_IDS||"").split(",").map(s=>s.trim()).filter(s=>/^\d+$/.test(s)))
        await enqueue(db,"customer-review:"+orderId+":"+adminId,adminId,{
          text:"💳 رسید جدید مشتری "+userId+"؛ سفارش "+orderId,
          reply_markup:{inline_keyboard:[[callback("بررسی رسید","cust:review:"+orderId)]]},
        });
    } catch(error) {
      if(!(error instanceof Error) || error.message!=="ORDER_NOT_AVAILABLE") throw error;
      await setConversation("");
      await reply("این سفارش دیگر منتظر رسید نیست. وضعیت آن را از «سفارش‌های من» بررسی کن.",[[callback("📦 سفارش‌های من","customer:orders:0")]]);
    }
    return true;
  }
  if(state?.startsWith("customer-receipt:")) {
    await reply("برای این سفارش، عکس یا فایل رسید پرداخت را به‌صورت پیام همین چت بفرست. برای لغو و بازگشت /start را ارسال کن.");
    return true;
  }

  await reply("برای ادامه از دکمه‌های منو استفاده کن یا /start را بفرست.",homeRows);
  return true;
}

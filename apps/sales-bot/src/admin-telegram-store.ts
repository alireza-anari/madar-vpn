import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";
import { saveCustomerPlan } from "./customer-store";
import { savePayment } from "./plans";

const btn=(text:string,data:string)=>({text,callback_data:data});
const home=()=>[btn("🏠 پنل مدیر","rs:home")];
const back=()=>[btn("↩️ مدیریت فروشگاه","adminstore:home")];
const esc=(v:string)=>v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const fa=(v:number)=>v.toLocaleString("fa-IR");
const money=(price:number,currency:string)=>fa(price)+" "+(currency==="IRT"?"تومان":"ریال");
const digits=(text:string)=>text.replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،\s]/g,"");
type Plan={id:string;name:string;price:number;currency:string;duration:number;enabled:number;quota_bytes:number|null};
type DraftPlan={kind:"plan";id:string;name:string;price:number;currency:"IRT"|"IRR";durationDays:number;quotaGb:number;enabled:boolean;original:string|null};
type DraftPayment={kind:"payment";value:string};
type DraftToggle={kind:"toggle";id:string;wasEnabled:boolean};
type Draft=DraftPlan|DraftPayment|DraftToggle;
const idOk=(id:string)=>/^[a-zA-Z0-9_-]{1,40}$/.test(id);
const signature=(p:Plan)=>[p.name,p.price,p.currency,p.duration,p.enabled,p.quota_bytes].join("|");
function parseDraft(raw:string):Draft|null {
  if(!raw.startsWith("adminstore:draft:"))return null;
  try {
    const candidate=JSON.parse(raw.slice("adminstore:draft:".length)) as Draft;
    if(candidate.kind==="payment" && typeof candidate.value==="string" && candidate.value.trim() && candidate.value.length<=1000)return candidate;
    if(candidate.kind==="toggle" && typeof candidate.id==="string" && idOk(candidate.id) && typeof candidate.wasEnabled==="boolean")return candidate;
    if(candidate.kind==="plan" && idOk(candidate.id) && typeof candidate.name==="string" &&
      candidate.name.trim().length>0 && candidate.name.length<=80 &&
      Number.isSafeInteger(candidate.price) && candidate.price>0 && candidate.price<=1e12 &&
      (candidate.currency==="IRT"||candidate.currency==="IRR") &&
      Number.isSafeInteger(candidate.durationDays) && candidate.durationDays>=1 && candidate.durationDays<=365 &&
      Number.isSafeInteger(candidate.quotaGb) && candidate.quotaGb>=1 && candidate.quotaGb<=1000 &&
      typeof candidate.enabled==="boolean" &&
      (typeof candidate.original==="string"||candidate.original===null))return candidate;
  } catch { /* Untrusted stale conversation state; ignore. */ }
  return null;
}
async function existingPlan(db:D1Database,id:string):Promise<Plan|null> {
  return db.prepare("SELECT id,name,price,currency,duration,enabled,quota_bytes FROM plans WHERE id=?").bind(id).first<Plan>();
}
function planMessage(p:Plan) {
  return "📦 <b>"+esc(p.name)+"</b>\n"+
    "🔖 شناسه: <code>"+esc(p.id)+"</code>\n"+
    "📊 حجم: "+(p.quota_bytes?fa(Math.round(p.quota_bytes/1e9))+" گیگابایت":"ثبت‌نشده")+"\n"+
    "⏳ مدت: "+fa(Math.round(p.duration/86400))+" روز\n"+
    "💳 قیمت: <b>"+money(p.price,p.currency)+"</b>\n"+
    "وضعیت فروش: <b>"+(p.enabled?"🟢 فعال":"⚪ غیرفعال")+"</b>";
}
export async function handleAdminStoreTelegram(env:Env,u:TelegramUpdate,now:number):Promise<boolean> {
  const id=u.message?.from?.id ?? u.callback_query?.from.id;
  const chat=u.message?.chat ?? u.callback_query?.message?.chat;
  if(!id || !chat || chat.type!=="private" || chat.id!==id)return false;
  const data=u.callback_query?.data||"";
  const text=u.message?.text?.trim()||"";
  const command=text.split(/\s+/,1)[0]?.split("@",1)[0]||"";
  if(["/start","/menu","/cancel","/support"].includes(command))return false;
  const db=env.SALES_DB,userId=String(id);
  const state=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(userId).first<string>("conversation")||"";
  if(!data.startsWith("adminstore:") && !(!!u.message && state.startsWith("adminstore:") && !command.startsWith("/")))return false;
  const role=(await resolveSalesActor(db,userId,env)).role;
  const reply=(content:string,rows:Record<string,unknown>[][],extra:Record<string,unknown>={})=>
    enqueue(db,"u"+u.update_id+":reply",userId,{
      text:content,parse_mode:"HTML",reply_markup:{inline_keyboard:rows},...extra,
    });
  if(role!=="admin") {
    await reply("⛔ این بخش فقط برای مدیر مدار است.",[[btn("🏠 منوی اصلی","rs:home")]]);
    return true;
  }
  const set=async(value:string)=>{
    await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
    await db.prepare("UPDATE users SET conversation=? WHERE id=?").bind(value,userId).run();
  };
  const draft=parseDraft(state);
  try {
    if(data==="adminstore:home") {
      await set("");
      const [plans,active,payment]=await Promise.all([
        db.prepare("SELECT COUNT(*) AS n FROM plans WHERE quota_bytes IS NOT NULL").first<number>("n"),
        db.prepare("SELECT COUNT(*) AS n FROM plans WHERE enabled=1 AND quota_bytes BETWEEN 1 AND 1000000000000").first<number>("n"),
        db.prepare("SELECT EXISTS(SELECT 1 FROM settings WHERE key='payment' AND length(trim(value))>0) AS n").first<number>("n"),
      ]);
      await reply("🛍️ <b>مدیریت فروشگاه مدار</b>\n━━━━━━━━━━━━\n"+
        "📦 پلن‌های ثبت‌شده: <b>"+fa(plans||0)+"</b>\n"+
        "🟢 پلن‌های فعال: <b>"+fa(active||0)+"</b>\n"+
        "💳 اطلاعات پرداخت: <b>"+(payment?"✅ آماده":"⚠️ تنظیم‌نشده")+"</b>\n\n"+
        "از همین ربات پلن‌ها و اطلاعات کارت‌به‌کارت را مدیریت کن. تغییر قیمت یا وضعیت پلن فقط پس از تأیید نهایی ثبت می‌شود.",[
          [btn("📦 مدیریت پلن‌ها","adminstore:plans:0")],
          [btn("🏦 اطلاعات پرداخت","adminstore:payment")],
          [btn("💳 رسیدهای مشتریان","cust:inbox:0"),btn("🔁 تمدید و حجم","cust:up:list:0")],
          home(),
        ]);
      return true;
    }
    const plansPage=data.match(/^adminstore:plans:(0|[1-9][0-9]{0,2})$/);
    if(plansPage) {
      await set("");
      const page=Number(plansPage[1]),perPage=6;
      const result=await db.prepare("SELECT id,name,price,currency,duration,enabled,quota_bytes FROM plans WHERE quota_bytes IS NOT NULL ORDER BY enabled DESC,price,id LIMIT ? OFFSET ?")
        .bind(perPage+1,page*perPage).all<Plan>();
      const rows:Record<string,unknown>[][]=result.results.slice(0,perPage).map(p=>[
        btn((p.enabled?"🟢 ":"⚪ ")+p.name.slice(0,30)+" · "+money(p.price,p.currency),"adminstore:plan:"+p.id),
      ]);
      const nav:Record<string,unknown>[]=[];
      if(page>0)nav.push(btn("◀️ قبلی","adminstore:plans:"+(page-1)));
      if(result.results.length>perPage)nav.push(btn("بعدی ▶️","adminstore:plans:"+(page+1)));
      if(nav.length)rows.push(nav);
      rows.push([btn("➕ افزودن پلن","adminstore:new")],back(),home());
      await reply("📦 <b>پلن‌های فروشگاه</b>\n\n"+(result.results.length?"برای مشاهده یا ویرایش یک پلن، روی آن بزن.":"پلنی در این صفحه وجود ندارد."),rows);
      return true;
    }
    const planMatch=data.match(/^adminstore:plan:([a-zA-Z0-9_-]{1,40})$/);
    if(planMatch) {
      await set("");
      const p=await existingPlan(db,planMatch[1]!);
      if(!p) {await reply("این پلن در دسترس نیست.",[back()]);return true;}
      await reply("🛍️ <b>جزئیات پلن مدار</b>\n\n"+planMessage(p)+"\n\nتغییرات روی خریدهای قبلی اعمال نمی‌شود.",[
        [btn("✏️ ویرایش پلن","adminstore:edit:"+p.id)],
        [btn(p.enabled?"⏸ غیرفعال‌کردن":"▶️ فعال‌کردن","adminstore:toggle:"+p.id)],
        [btn("📦 همه پلن‌ها","adminstore:plans:0")],home(),
      ]);
      return true;
    }
    const editMatch=data.match(/^adminstore:edit:([a-zA-Z0-9_-]{1,40})$/);
    if(editMatch) {
      const p=await existingPlan(db,editMatch[1]!);
      if(!p) {await reply("پلن پیدا نشد.",[back()]);return true;}
      await set("adminstore:edit:"+p.id);
      await reply("✏️ <b>ویرایش پلن "+esc(p.name)+"</b>\n\n"+
        "در یک پیام به این ترتیب بفرست:\n<code>نام پلن | حجم گیگ | مدت روز | قیمت "+(p.currency==="IRT"?"تومان":"ریال")+"</code>\n\n"+
        "نمونه:\n<code>اشتراک ماهانه | 30 | 30 | 150000</code>\n"+
        "فروش پلن هنگام ویرایش فعال/غیرفعال نمی‌شود.",[[btn("↩️ بازگشت","adminstore:plan:"+p.id)],home()]);
      return true;
    }
    if(data==="adminstore:new") {
      await set("adminstore:new");
      await reply("➕ <b>افزودن پلن جدید</b>\n\nاطلاعات را در یک پیام با این ترتیب بفرست:\n"+
        "<code>شناسه انگلیسی | نام پلن | حجم گیگ | مدت روز | قیمت تومان</code>\n\n"+
        "مثال:\n<code>monthly_30 | اشتراک ماهانه | 30 | 30 | 150000</code>\n"+
        "پلن تازه ابتدا غیرفعال ساخته می‌شود و پس از بررسی می‌توانی آن را فعال کنی.",[back(),home()]);
      return true;
    }
    const toggleMatch=data.match(/^adminstore:toggle:([a-zA-Z0-9_-]{1,40})$/);
    if(toggleMatch) {
      const p=await existingPlan(db,toggleMatch[1]!);
      if(!p){await reply("پلن پیدا نشد.",[back()]);return true;}
      await set("adminstore:draft:"+JSON.stringify({kind:"toggle",id:p.id,wasEnabled:!!p.enabled} satisfies DraftToggle));
      await reply("⚠️ <b>تأیید تغییر وضعیت پلن</b>\n\n"+planMessage(p)+"\n\n"+
        "بعد از تأیید، این پلن "+(p.enabled?"از فروشگاه مشتری حذف می‌شود.":"برای خریدهای جدید قابل انتخاب می‌شود.")+
        "\nسفارش‌ها و سرویس‌های قبلی تغییری نمی‌کنند.",[
        [btn(p.enabled?"⏸ تأیید غیرفعال‌سازی":"✅ تأیید فعال‌سازی","adminstore:toggleok")],
        [btn("↩️ انصراف","adminstore:plan:"+p.id)],
      ]);
      return true;
    }
    if(data==="adminstore:toggleok") {
      if(!draft || draft.kind!=="toggle"){await reply("این تأیید منقضی شده است.",[back()]);return true;}
      const p=await existingPlan(db,draft.id);
      if(!p || (!!p.enabled)!==draft.wasEnabled){await set("");await reply("وضعیت پلن تغییر کرده؛ برای جلوگیری از تغییر ناخواسته دوباره بررسی کن.",[back()]);return true;}
      await saveCustomerPlan(db,{telegramId:userId,role:"admin"},{
        id:p.id,name:p.name,price:p.price,currency:p.currency,
        durationDays:Math.round(p.duration/86400),quotaGb:Math.round((p.quota_bytes||0)/1e9),
        enabled:!p.enabled,
      },now);
      await set("");
      await reply("✅ وضعیت پلن به‌روزرسانی شد.",[[btn("🔎 مشاهده پلن","adminstore:plan:"+p.id)],back(),home()]);
      return true;
    }
    if(data==="adminstore:payment") {
      await set("");
      const value=await db.prepare("SELECT value FROM settings WHERE key='payment'").first<string>("value")||"";
      await reply("🏦 <b>اطلاعات پرداخت مدار</b>\n\n"+
        (value?"<blockquote>"+esc(value)+"</blockquote>":"⚠️ اطلاعات کارت‌به‌کارت ثبت نشده است.")+
        "\n\nاین اطلاعات فقط به مدیر و مشتریانی که سفارش ثبت کرده‌اند نمایش داده می‌شود.",[
        ...(value.length<=256&&value?[[{text:"📋 کپی اطلاعات پرداخت",copy_text:{text:value}}]]:[]),
        [btn("✏️ ویرایش اطلاعات پرداخت","adminstore:paymentedit")],back(),home(),
      ]);
      return true;
    }
    if(data==="adminstore:paymentedit") {
      await set("adminstore:paymentedit");
      await reply("✏️ <b>ویرایش اطلاعات پرداخت</b>\n\nشماره کارت و نام صاحب حساب را در یک پیام بفرست. "+
        "اطلاعات جدید تا زمان تأیید نهایی جایگزین اطلاعات فعلی نمی‌شود.\n\n"+
        "⚠️ فقط اطلاعات مجاز برای دریافت پرداخت را وارد کن (حداکثر ۱۰۰۰ کاراکتر).",[[btn("↩️ انصراف","adminstore:payment")],home()]);
      return true;
    }
    if(data==="adminstore:confirm") {
      if(!draft || (draft.kind!=="payment" && draft.kind!=="plan")){await reply("این پیش‌نمایش منقضی شده است؛ عملیات را از اول انجام بده.",[back()]);return true;}
      if(draft.kind==="payment") {
        await savePayment(db,{telegramId:userId,role:"admin"},draft.value,now);
        await set("");
        await reply("✅ اطلاعات پرداخت جدید ثبت شد. این تغییر برای سفارش‌های جدید نمایش داده می‌شود.",[[btn("🏦 مشاهده اطلاعات پرداخت","adminstore:payment")],back(),home()]);
        return true;
      }
      const current=await existingPlan(db,draft.id);
      if((current?signature(current):null)!==draft.original) {
        await set("");
        await reply("⚠️ اطلاعات پلن از زمان پیش‌نمایش تغییر کرده است. دوباره بررسی کن.",[[btn("📦 پلن‌ها","adminstore:plans:0")],home()]);
        return true;
      }
      await saveCustomerPlan(db,{telegramId:userId,role:"admin"},draft,now);
      await set("");
      await reply("✅ پلن ذخیره شد.\n\n"+planMessage({
        id:draft.id,name:draft.name,price:draft.price,currency:draft.currency,
        duration:draft.durationDays*86400,quota_bytes:draft.quotaGb*1e9,enabled:draft.enabled?1:0,
      }),[[btn("🔎 مشاهده پلن","adminstore:plan:"+draft.id)],back(),home()]);
      return true;
    }
    if(data==="adminstore:guide") {
      await set("");
      await reply("📖 <b>راهنمای مدیریت مدار</b>\n\n"+
        "🛍️ مدیریت فروشگاه: ایجاد/ویرایش پلن و اطلاعات پرداخت؛ هر تغییر پس از تأیید نهایی.\n"+
        "💳 رسیدها: فقط پس از تطبیق واریز واقعی در بانک، پرداخت را تأیید کن.\n"+
        "💬 پشتیبانی: پیام‌ها و تصاویر مشتری را در همین تلگرام بررسی کن.\n"+
        "🌐 سرورها: ظرفیت کانفیگ و حجم را با توجه به مصرف واقعی تنظیم کن.\n"+
        "👥 فروشندگان: سقف تعداد و حجم و گزارش تسویه را کنترل کن.\n"+
        "🔒 عملیات روی سرورها و سرویس‌های فعال به تأییدهای جداگانه نیاز دارند.",[
          [btn("🛍️ فروشگاه","adminstore:home"),btn("💬 پشتیبانی","support:admin:inbox:0")],
          home(),
        ]);
      return true;
    }
    if(!!u.message && !data && state==="adminstore:paymentedit") {
      if(!text || text.length>1000){await reply("اطلاعات پرداخت باید بین ۱ تا ۱۰۰۰ کاراکتر باشد.",[[btn("↩️ انصراف","adminstore:payment")]]);return true;}
      await set("adminstore:draft:"+JSON.stringify({kind:"payment",value:text} satisfies DraftPayment));
      await reply("🏦 <b>پیش‌نمایش اطلاعات پرداخت جدید</b>\n\n<blockquote>"+esc(text)+"</blockquote>\n"+
        "⚠️ شماره کارت و نام صاحب حساب را با دقت بررسی کن؛ هنوز ثبت نشده است.",[
          [btn("✅ تأیید و ذخیره اطلاعات پرداخت","adminstore:confirm")],
          [btn("↩️ انصراف","adminstore:payment")],
        ]);
      return true;
    }
    if(!!u.message && !data && (state==="adminstore:new"||state.startsWith("adminstore:edit:"))) {
      const editId=state.startsWith("adminstore:edit:")?state.slice("adminstore:edit:".length):null;
      const parts=text.split("|").map(p=>p.trim());
      const validParts=editId?parts.length===4:parts.length===5;
      const planId=editId||parts[0]||"";
      const offset=editId?0:1;
      const name=parts[offset]||"";
      const quota=digits(parts[offset+1]||"");
      const duration=digits(parts[offset+2]||"");
      const price=digits(parts[offset+3]||"");
      const current=editId?await existingPlan(db,editId):null;
      if(!validParts||!idOk(planId)||!name||name.length>80||
        !/^\d+$/.test(quota)||!/^\d+$/.test(duration)||!/^\d+$/.test(price)||
        Number(quota)<1||Number(quota)>1000||Number(duration)<1||Number(duration)>365||
        Number(price)<1||Number(price)>1e12||!Number.isSafeInteger(Number(price))||
        (editId&&!current)) {
        await reply("⚠️ قالب یا مقدارها معتبر نیست. از جداکننده | استفاده کن و حجم ۱ تا ۱۰۰۰ گیگ، مدت ۱ تا ۳۶۵ روز و قیمت مثبت وارد کن.",[
          [btn("↩️ انصراف",editId?"adminstore:plan:"+editId:"adminstore:plans:0")],
        ]);
        return true;
      }
      if(!editId && await existingPlan(db,planId)) {
        await reply("این شناسه قبلاً ثبت شده است؛ شناسه جدیدی انتخاب کن.",[[btn("📦 پلن‌ها","adminstore:plans:0")]]);
        return true;
      }
      const plan:DraftPlan={kind:"plan",id:planId,name,quotaGb:Number(quota),durationDays:Number(duration),
        price:Number(price),currency:current?.currency==="IRR"?"IRR":"IRT",
        enabled:!!current?.enabled,original:current?signature(current):null};
      await set("adminstore:draft:"+JSON.stringify(plan));
      await reply("🧾 <b>پیش‌نمایش پلن</b>\n\n"+planMessage({
        id:plan.id,name:plan.name,price:plan.price,currency:plan.currency,
        duration:plan.durationDays*86400,quota_bytes:plan.quotaGb*1e9,enabled:plan.enabled?1:0,
      })+"\n\nتا اینجا تغییری ذخیره نشده است.",[
        [btn("✅ تأیید و ذخیره پلن","adminstore:confirm")],
        [btn("↩️ انصراف","adminstore:plans:0")],
      ]);
      return true;
    }
    if(!!u.message && state.startsWith("adminstore:")) {
      await reply("برای ادامه، متن خواسته‌شده را بفرست یا از دکمه‌های منو استفاده کن.",[back(),home()]);
      return true;
    }
    await reply("این گزینه مدیریت فروشگاه منقضی یا نامعتبر است.",[back(),home()]);
    return true;
  } catch(error) {
    const code=error instanceof Error?error.message:"";
    if(code==="INVALID_PLAN"||code==="INVALID_PAYMENT") {
      await reply("⚠️ اطلاعات واردشده معتبر نیست. دوباره بررسی کن.",[back(),home()]);
      return true;
    }
    throw error;
  }
}

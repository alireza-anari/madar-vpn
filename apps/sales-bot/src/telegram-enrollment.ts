import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";
import { publicTarget, validatePort } from "./targets";
import { issueNonce, createProbe, createEnrollment, enrollmentJobStatus } from "./enrollment";

const btn=(label:string,callback_data:string)=>({text:label,callback_data});
const home=()=>[btn("🏠 پنل مدیر","rs:home")];
const back=()=>[btn("🌐 سرورها","rs:nodes")];
const escape=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const num=(s:string)=>s.trim().replace(/[۰-۹]/g,c=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
  .replace(/[٠-٩]/g,c=>String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
const fpPattern=/^SHA256:[A-Za-z0-9+/]{43}$/;
type Wizard={
  step:"name"|"ip"|"port"|"count"|"volume"|"probe"|"fingerprint"|"username"|"method"|"secret"|"install";
  name?:string;ip?:string;port?:number;maxAccounts?:number;maxAllocatedGb?:number;
  probeId?:string;fingerprint?:string;username?:string;method?:"password"|"key";jobId?:string;
};
function parse(raw:string):Wizard|null{
  if(!raw.startsWith("enroll:"))return null;
  try {
    const w=JSON.parse(raw.slice(7)) as Wizard;
    if(w && ["name","ip","port","count","volume","probe","fingerprint","username","method","secret","install"].includes(w.step))return w;
  }catch{/* stale state */}
  return null;
}

// Telegram is not a password manager. A secret is sealed in the authenticated
// webhook before recordUpdate() persists any data; plaintext never reaches D1.
// The Runner alone has the matching RSA private key.
export async function sealTelegramEnrollmentSecret(env:Env,update:TelegramUpdate):Promise<boolean>{
  const m=update.message;
  if(!m || !m.from || m.from.id!==m.chat.id || m.chat.type!=="private" || typeof m.text!=="string")return false;
  if(m.text.startsWith("/"))return false;
  const user=String(m.from.id);
  const conversation=await env.SALES_DB.prepare("SELECT conversation FROM users WHERE id=?").bind(user).first<string>("conversation")||"";
  const wizard=parse(conversation);
  if(wizard?.step!=="secret" || (await resolveSalesActor(env.SALES_DB,user,env)).role!=="admin")return false;
  const original=m.text;
  // Never persist arbitrary plaintext, even if encryption is unavailable.
  m.text="enroll-sealed:INVALID";
  if(original.length>12000 || !original || !env.RUNNER_PUBLIC_KEY)return true;
  try {
    let cred:Record<string,string>;
    if(wizard.method==="password") {
      if(original.length>1000 || original.includes("\n"))return true;
      cred={method:"password",password:original};
    }else if(wizard.method==="key") {
      if(!/^-----BEGIN (?:OPENSSH|RSA|EC|DSA|PRIVATE) PRIVATE KEY-----/.test(original.trim()))return true;
      cred={method:"key",key:original,passphrase:""};
    }else return true;
    const publicKey=JSON.parse(env.RUNNER_PUBLIC_KEY) as JsonWebKey;
    const rsa=await crypto.subtle.importKey("jwk",publicKey,{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);
    const aes=await crypto.subtle.generateKey({name:"AES-GCM",length:256},true,["encrypt"]);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const body=await crypto.subtle.encrypt({name:"AES-GCM",iv},aes,new TextEncoder().encode(JSON.stringify(cred)));
    const raw=await crypto.subtle.exportKey("raw",aes);
    const wrapped=await crypto.subtle.encrypt("RSA-OAEP",rsa,raw);
    const b64=(bytes:ArrayBuffer|Uint8Array)=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const sealed=JSON.stringify({v:1,key:b64(wrapped),iv:b64(iv),data:b64(body)});
    m.text=sealed.length<=20000?"enroll-sealed:"+sealed:"enroll-sealed:INVALID";
  }catch{
    m.text="enroll-sealed:INVALID";
  }
  return true;
}

export async function handleTelegramEnrollment(env:Env,u:TelegramUpdate,now:number):Promise<boolean>{
  const id=u.message?.from?.id??u.callback_query?.from.id;
  const chat=u.message?.chat??u.callback_query?.message?.chat;
  if(!id || !chat || chat.type!=="private" || chat.id!==id)return false;
  const data=u.callback_query?.data||"";
  const input=u.message?.text?.trim()||"";
  const db=env.SALES_DB,user=String(id);
  const raw=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(user).first<string>("conversation")||"";
  const wizard=parse(raw);
  const active=!!wizard;
  const isCommand=["/start","/menu","/cancel"].includes(input.split("@")[0]||"");
  if(!data.startsWith("enroll:") && !(active && !!u.message && !isCommand))return false;
  const reply=(message:string,rows:Record<string,unknown>[][])=>
    enqueue(db,"u"+u.update_id+":reply",user,{
      text:message,parse_mode:"HTML",reply_markup:{inline_keyboard:rows},
    });
  if((await resolveSalesActor(db,user,env)).role!=="admin"){
    await reply("⛔ افزودن سرور فقط برای مدیر مدار فعال است.",[home()]);
    return true;
  }
  const set=async(value:Wizard|null)=>{
    await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(user).run();
    await db.prepare("UPDATE users SET conversation=? WHERE id=?").bind(value?"enroll:"+JSON.stringify(value):"",user).run();
  };
  const cancel=[btn("❌ انصراف از افزودن سرور","enroll:cancel")];
  const statusLabel=(state:string)=>({
    pending:"⏳ در صف",queued:"⏳ در صف",leased:"🔎 در حال بررسی اتصال",
    preflight:"🔎 بررسی پیش‌نیازها",running:"⚙️ در حال نصب",installing:"⚙️ در حال نصب",
    verifying:"🔐 بررسی سلامت نهایی",ready:"✅ آماده",failed:"❌ ناموفق",
  } as Record<string,string>)[state]||"⏳ در حال بررسی";
  const error=async(s:string):Promise<boolean>=>{await reply("⚠️ "+s,[[btn("🔄 شروع مجدد","enroll:start")],back(),home()]);return true;};
  if(data==="enroll:cancel"){
    await set(null);
    await reply("↩️ افزودن سرور لغو شد. هیچ نصب جدیدی از این مرحله آغاز نشده است.",[back(),home()]);
    return true;
  }
  if(data==="enroll:start"){
    if(!env.RUNNER_PUBLIC_KEY){
      await reply("⚠️ نصب‌کننده سرور در حال حاضر تنظیم نشده است. ابتدا باید کلید عمومی Runner در Cloudflare فعال باشد.",[back(),home()]);
      return true;
    }
    await set({step:"name"});
    await reply("🌐 <b>افزودن سرور به مدار</b>\n━━━━━━━━━━━━━━━━\n"+
      "مراحل: نام سرور ← IP عمومی ← پورت SSH ← ظرفیت ← بررسی اثر انگشت ← ورود امن ← نصب خودکار.\n\n"+
      "🔒 پیام رمز یا کلید بعد از دریافت رمزگذاری و برای حذف از چت علامت‌گذاری می‌شود. تلگرام همچنان می‌تواند پیام ارسالی اولیه را دریافت کند؛ ترجیحاً از حساب SSH موقت استفاده کن.\n\n"+
      "✍️ <b>۱. نام سرور را بفرست.</b>\nمثال: Stockholm VPS 3",[cancel,back()]);
    return true;
  }
  if(!wizard){
    await error("این مرحله منقضی شده است. افزودن سرور را از نو آغاز کن.");
    return true;
  }
  const w={...wizard};
  try {
    if(u.message && !isCommand && !input.startsWith("enroll-sealed:") && w.step==="name"){
      if(!input || input.length>80)return error("نام سرور باید بین ۱ تا ۸۰ کاراکتر باشد.");
      w.name=input;w.step="ip";await set(w);
      await reply("✅ نام: <b>"+escape(w.name)+"</b>\n\n🌍 <b>۲. IP عمومی سرور را بفرست.</b>\nمثال: <code>51.21.199.245</code>\nIP خصوصی یا دامنه پذیرفته نمی‌شود.",[cancel]);
      return true;
    }
    if(u.message && w.step==="ip"){
      try{w.ip=publicTarget(input);}catch{return error("فقط IP عمومی معتبر (IPv4 یا IPv6) وارد کن.");}
      w.step="port";await set(w);
      await reply("✅ IP: <code>"+escape(w.ip)+"</code>\n\n🔌 <b>۳. پورت SSH را بفرست.</b>\nمعمولاً <code>22</code>",[cancel]);
      return true;
    }
    if(u.message && w.step==="port"){
      if(!/^\d{1,5}$/.test(num(input)))return error("پورت SSH باید عددی از ۱ تا ۶۵۵۳۵ باشد.");
      w.port=Number(num(input));try{validatePort(w.port);}catch{return error("پورت SSH معتبر نیست.");}
      w.step="count";await set(w);
      await reply("🔢 <b>۴. سقف کانفیگ‌های همزمان سرور را بفرست.</b>\nمثال: <code>20</code>\nحد مجاز ۱ تا ۱۰٬۰۰۰ است.",[cancel]);
      return true;
    }
    if(u.message && w.step==="count"){
      if(!/^\d+$/.test(num(input))||Number(num(input))<1||Number(num(input))>10000)return error("سقف کانفیگ باید عددی بین ۱ و ۱۰٬۰۰۰ باشد.");
      w.maxAccounts=Number(num(input));w.step="volume";await set(w);
      await reply("📦 <b>۵. سقف مجموع حجم فروش سرور را به گیگابایت بفرست.</b>\nمثال: <code>1000</code>\nوقتی سقف تعداد یا حجم پر شود، فروش روی این سرور متوقف می‌شود.",[cancel]);
      return true;
    }
    if(u.message && w.step==="volume"){
      if(!/^\d+$/.test(num(input))||Number(num(input))<1||Number(num(input))>1000000)return error("سقف حجم باید عددی بین ۱ تا ۱٬۰۰۰٬۰۰۰ گیگابایت باشد.");
      w.maxAllocatedGb=Number(num(input));
      const nonce=await issueNonce(db,{telegramId:user,role:"admin"},now);
      const probe=await createProbe(env,{telegramId:user,role:"admin"},{targetIp:w.ip!,port:w.port!,nonce},now);
      w.probeId=probe.jobId;w.step="probe";await set(w);
      await reply("🔎 <b>بررسی SSH شروع شد</b>\n"+
        "سرور: "+escape(w.name!)+"\nIP: <code>"+escape(w.ip!)+"</code>\n"+
        "ظرفیت: "+w.maxAccounts+" کانفیگ · "+w.maxAllocatedGb+" گیگابایت\n\n"+
        "Runner در حال بررسی اتصال و اثر انگشت SSH است. پس از چند لحظه وضعیت را تازه کن.",[
          [btn("🔄 دریافت نتیجه بررسی","enroll:probe")],cancel,
        ]);
      return true;
    }
    if(data==="enroll:probe" && (w.step==="probe"||w.step==="fingerprint")){
      const result=await enrollmentJobStatus(db,w.probeId!,user,now) as {state?:string;safe_code?:string;fingerprint?:string}|null;
      if(!result){await error("درخواست بررسی اتصال منقضی شده است؛ دوباره شروع کن.");return true;}
      if(result.state==="ready" && result.fingerprint && fpPattern.test(result.fingerprint)){
        w.step="fingerprint";w.fingerprint=result.fingerprint;await set(w);
        await reply("🔐 <b>اثر انگشت SSH سرور</b>\n"+
          "<code>"+result.fingerprint+"</code>\n\n"+
          "⚠️ آن را با اثر انگشت کلید میزبان در پنل ارائه‌دهنده یا کنسول سرور مقایسه کن. "+
          "فقط در صورت تطبیق، تأیید کن. این بررسی مانع اتصال به سرور ناشناس می‌شود.",[
            [btn("✅ اثر انگشت را مطابقت دادم","enroll:trust")],
            [btn("🔄 بررسی دوباره","enroll:probe")],cancel,
          ]);
        return true;
      }
      if(result.state==="failed"){
        await reply("❌ بررسی اتصال موفق نبود.\nکد: <code>"+escape(result.safe_code||"PROBE_FAILED")+"</code>\n"+
          "SSH، فایروال و آدرس عمومی VPS را بررسی کن.",[[btn("🔄 شروع مجدد","enroll:start")],cancel]);
        return true;
      }
      await reply("🔎 وضعیت بررسی: <b>"+statusLabel(result.state||"pending")+"</b>\nپورت SSH باید از Runner قابل‌دسترسی باشد.",[
        [btn("🔄 بررسی مجدد","enroll:probe")],cancel,
      ]);
      return true;
    }
    if(data==="enroll:trust" && w.step==="fingerprint"){
      const probe=await enrollmentJobStatus(db,w.probeId!,user,now) as {state?:string;fingerprint?:string}|null;
      if(probe?.state!=="ready"||probe.fingerprint!==w.fingerprint){
        await error("اثر انگشت بررسی‌شده دیگر معتبر نیست. دوباره اتصال را بررسی کن.");return true;
      }
      w.step="username";await set(w);
      await reply("👤 <b>۶. نام کاربر SSH سرور را بفرست.</b>\nمعمولاً <code>ubuntu</code> برای Ubuntu یا <code>root</code> برای بعضی VPSها.",[cancel]);
      return true;
    }
    if(u.message && w.step==="username"){
      if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(input))return error("نام کاربری SSH معتبر نیست. مثال: ubuntu");
      w.username=input;w.step="method";await set(w);
      await reply("🔑 <b>۷. روش ورود SSH را انتخاب کن.</b>\n"+
        "رمز عبور VPS یا کلید خصوصی SSH متنی. هیچ کلیدی در پیام‌های خروجی ربات نمایش داده نمی‌شود.",[
          [btn("🔒 رمز عبور VPS","enroll:method:password")],
          [btn("🗝️ کلید خصوصی SSH (متن PEM)","enroll:method:key")],cancel,
        ]);
      return true;
    }
    if(data.startsWith("enroll:method:") && w.step==="method"){
      const method=data.slice("enroll:method:".length);
      if(method!=="password" && method!=="key")return error("روش ورود نامعتبر است.");
      w.method=method;w.step="secret";await set(w);
      await reply("🔐 <b>۸. "+(method==="password"?"رمز موقت SSH":"متن کلید خصوصی SSH")+" را در یک پیام بفرست.</b>\n\n"+
        (method==="key"?"کل محتوای فایل PEM/OpenSSH را به‌صورت متن ارسال کن؛ فایل تصویری یا پیوست فعلاً پذیرفته نمی‌شود.\n":"رمز را به‌صورت یک خط و بدون توضیح اضافی بفرست.\n")+
        "⚠️ پیام در سمت Worker پیش از ذخیره رمزگذاری و برای حذف از چت ارسال می‌شود. "+
        "اما تلگرام متن اولیه را دریافت می‌کند؛ از حساب موقت SSH استفاده کن و پس از نصب دسترسی آن را عوض کن.\n"+
        "🔒 فقط همین مرحله اطلاعات حساس را می‌پذیرد.",[cancel]);
      return true;
    }
    if(u.message && w.step==="secret"){
      if(!input.startsWith("enroll-sealed:")||input==="enroll-sealed:INVALID"){
        await reply("⚠️ اطلاعات ورود قابل رمزگذاری نبود. کلید عمومی Runner و قالب رمز/کلید را بررسی کن؛ هیچ اطلاعات خامی ذخیره نشده است.",[cancel]);
        return true;
      }
      const encrypted=input.slice("enroll-sealed:".length);
      const nonce=await issueNonce(db,{telegramId:user,role:"admin"},now);
      const result=await createEnrollment(env,{telegramId:user,role:"admin"},{
        name:w.name!,targetIp:w.ip!,port:w.port!,maxAccounts:w.maxAccounts!,
        maxAllocatedGb:w.maxAllocatedGb!,username:w.username!,
        hostFingerprint:w.fingerprint!,probeId:w.probeId!,nonce,encryptedCredentials:encrypted,
      },now);
      w.jobId=result.jobId;w.step="install";await set(w);
      await reply("✅ <b>نصب خودکار سرور ثبت شد.</b>\n"+
        "سرور: "+escape(w.name!)+"\nIP: <code>"+escape(w.ip!)+"</code>\n"+
        "سقف: "+w.maxAccounts+" کانفیگ · "+w.maxAllocatedGb+" گیگابایت\n\n"+
        "🔒 اطلاعات ورود به‌صورت رمزگذاری‌شده و موقت فقط به Runner تحویل می‌شود.\n"+
        "وضعیت نصب را از دکمه زیر بررسی کن.",[
          [btn("🔄 وضعیت نصب","enroll:status")],back(),home(),
        ]);
      return true;
    }
    if(data==="enroll:status" && w.step==="install"){
      const status=await enrollmentJobStatus(db,w.jobId!,user,now) as {state?:string;safe_code?:string}|null;
      if(!status){await error("وضعیت نصب پیدا نشد.");return true;}
      if(status.state==="ready"){
        const nodeId=await db.prepare("SELECT node_id FROM installation_jobs WHERE id=? AND user_id=? AND kind='install'").bind(w.jobId!,user).first<string>("node_id");
        await set(null);
        await reply("✅ <b>سرور به مدار اضافه و سلامت آن تأیید شد.</b>\n"+
          "نام: "+escape(w.name!)+"\n"+
          "برای فروش، کاربرد سرور را از صفحه جزئیات تعیین کن.",nodeId?[
            [btn("🌐 جزئیات و کاربرد سرور","rs:nodedetail:"+nodeId)],back(),home(),
          ]:[back(),home()]);
        return true;
      }
      await reply("🛰️ <b>وضعیت نصب سرور</b>\n"+statusLabel(status.state||"pending")+
        (status.safe_code?"\nکد: <code>"+escape(status.safe_code)+"</code>":"")+
        (status.state==="failed"?"\n❌ نصب متوقف شد؛ اطلاعات ورود موقت پاک می‌شود. پس از بررسی خطا، دوباره اضافه کن.":"\nپس از نصب، باید سلامت سرور نیز تأیید شود."),[
          ...(status.state==="failed"?[[btn("🔄 شروع مجدد","enroll:start")]]:[[btn("🔄 تازه‌سازی وضعیت","enroll:status")]]),
          back(),home(),
        ]);
      return true;
    }
    await reply("این مرحله در حال حاضر قابل اجرا نیست. از بخش افزودن سرور دوباره شروع کن.",[
      [btn("🔄 شروع مجدد","enroll:start")],cancel,
    ]);
    return true;
  }catch(e){
    const code=e instanceof Error?e.message:"";
    const known:Record<string,string>={
      INVALID_TARGET:"آدرس عمومی سرور معتبر نیست.",
      INVALID_PORT:"پورت SSH معتبر نیست.",
      NONCE_REPLAY:"این درخواست منقضی شده؛ دوباره شروع کن.",
      FINGERPRINT_UNCONFIRMED:"اثر انگشت SSH تأیید نشده یا زمان آن گذشته است.",
      INVALID_CAPACITY:"سقف تعداد سرور معتبر نیست.",
      INVALID_ALLOCATION_CAP:"سقف حجمی سرور معتبر نیست.",
      EXISTING_NODE:"این IP از قبل در مدار ثبت شده است؛ اطلاعات سرورهای موجود را بررسی کن.",
      INVALID_CIPHERTEXT:"اطلاعات ورود قابل پردازش نیست.",
      INVALID_INPUT:"مقادیر واردشده معتبر نیست.",
    };
    await reply("⚠️ "+(known[code]||"عملیات انجام نشد؛ وضعیت نصب را بررسی کن و در صورت نیاز دوباره شروع کن."),[
      ...(w.step==="install"?[[btn("🔄 وضعیت نصب","enroll:status")]]:[]),
      [btn("🔄 شروع مجدد","enroll:start")],back(),home(),
    ]);
    return true;
  }
}

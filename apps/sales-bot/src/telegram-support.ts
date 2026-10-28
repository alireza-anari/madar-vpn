import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";

const btn=(text:string,callback_data:string)=>({text,callback_data});
const escapeHtml=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const ticketRef=(id:string)=>"#"+id.slice(0,8).toUpperCase();
const uuidPattern="[a-f0-9-]{36}";
const categories={
  connection:"🔌 مشکل اتصال",
  payment:"💳 پرداخت و سفارش",
  renewal:"🔁 تمدید اشتراک",
  usage:"📊 حجم و مصرف",
  other:"💬 سایر موارد",
} as const;
type Category=keyof typeof categories;
type Ticket={id:string;user_id:string;category:Category;state:"open"|"closed";updated_at:number;created_at:number};
const validCategory=(s:string):s is Category=>Object.prototype.hasOwnProperty.call(categories,s);
const categoryName=(s:Category)=>categories[s];
const fa=(n:number)=>n.toLocaleString("fa-IR");
const home=()=>[btn("🏠 منوی اصلی","customer:home")];
const adminHome=()=>[btn("🏠 پنل مدیر","rs:home")];

export async function handleTelegramSupport(env:Env,u:TelegramUpdate,now:number):Promise<boolean> {
  const id=u.message?.from?.id ?? u.callback_query?.from.id;
  const chat=u.message?.chat ?? u.callback_query?.message?.chat;
  if(!id || !chat || chat.type!=="private" || chat.id!==id) return false;
  const userId=String(id),db=env.SALES_DB;
  const data=u.callback_query?.data||"";
  const text=u.message?.text?.trim()||"";
  const command=text.split(/\s+/,1)[0]?.split("@",1)[0]||"";
  // Normal navigation commands are owned by the existing Telegram bot.
  if(["/start","/menu","/cancel"].includes(command)) return false;
  const actor=await resolveSalesActor(db,userId,env);
  const isAdmin=actor.role==="admin";
  const existingState=await db.prepare("SELECT conversation FROM users WHERE id=?")
    .bind(userId).first<string>("conversation");
  const state=existingState||"";
  if(data.startsWith("support:") || command==="/support" || (state.startsWith("support:") && !!u.message && !command.startsWith("/"))) {
    const reply=(value:string,rows:Record<string,unknown>[][],extra:Record<string,unknown>={})=>
      enqueue(db,"u"+u.update_id+":reply",userId,{
        text:value,parse_mode:"HTML",reply_markup:{inline_keyboard:rows},...extra,
      });
    const setState=async(value:string)=>{
      await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(userId).run();
      await db.prepare("UPDATE users SET conversation=? WHERE id=?").bind(value,userId).run();
    };
    const adminIds=[...new Set((env.ADMIN_TELEGRAM_IDS||"").split(",").map(s=>s.trim()).filter(x=>/^\d+$/.test(x)))];
    const notify=async(ticket:Ticket,body:string,file?:{kind:"photo"|"document";id:string})=>{
      const recipients=isAdmin?[ticket.user_id]:adminIds;
      for(const recipient of recipients) {
        const header=isAdmin?"💬 <b>پاسخ پشتیبانی مدار</b>":"📩 <b>درخواست پشتیبانی جدید</b>";
        const payload:Record<string,unknown>=file?{
          _method:file.kind==="photo"?"sendPhoto":"sendDocument",
          [file.kind==="photo"?"photo":"document"]:file.id,
          caption:(isAdmin?"پاسخ به درخواست ":"فایل درخواست ")+ticketRef(ticket.id),
          reply_markup:{inline_keyboard:[[btn(isAdmin?"📨 مشاهده درخواست":"🔎 بررسی درخواست",isAdmin?"support:ticket:"+ticket.id:"support:admin:ticket:"+ticket.id)]]},
        }:{
          text:header+"\nشماره: <code>"+ticketRef(ticket.id)+"</code>\n"+body,
          parse_mode:"HTML",
          reply_markup:{inline_keyboard:[[btn(isAdmin?"📨 مشاهده درخواست":"🔎 بررسی درخواست",isAdmin?"support:ticket:"+ticket.id:"support:admin:ticket:"+ticket.id)]]},
        };
        await enqueue(db,"support:"+u.update_id+":"+recipient,recipient,payload);
      }
    };
    const ticket=async(ticketId:string):Promise<Ticket|null>=>{
      const found=await db.prepare("SELECT id,user_id,category,state,created_at,updated_at FROM support_tickets WHERE id=?")
        .bind(ticketId).first<Ticket>();
      return found && (isAdmin || found.user_id===userId)?found:null;
    };
    const detail=async(t:Ticket)=>{
      const messages=await db.prepare("SELECT sender_role,message_text,file_kind,created_at FROM support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT 6")
        .bind(t.id).all<{sender_role:string;message_text:string|null;file_kind:string|null;created_at:number}>();
      const excerpt=messages.results.reverse().map(m=>
        (m.sender_role==="admin"?"👨‍💼 مدیر: ":"👤 مشتری: ")+
        escapeHtml(m.message_text?m.message_text.slice(0,180):m.file_kind==="photo"?"[تصویر پیوست]":"[فایل پیوست]"),
      ).join("\n");
      const rows:Record<string,unknown>[][]=[];
      if(t.state==="open") {
        rows.push([btn("✉️ "+(isAdmin?"پاسخ به مشتری":"ارسال پیام یا تصویر"),(isAdmin?"support:admin:reply:":"support:reply:")+t.id)]);
        if(isAdmin) rows.push([btn("✅ بستن درخواست","support:admin:close:"+t.id)]);
      } else if(!isAdmin) rows.push([btn("🔄 بازگشایی درخواست","support:reopen:"+t.id)]);
      rows.push([isAdmin?btn("📥 صندوق درخواست‌ها","support:admin:inbox:0"):btn("📋 درخواست‌های من","support:mine:0")]);
      rows.push([isAdmin?adminHome()[0]!:home()[0]!]);
      await reply("💬 <b>درخواست "+ticketRef(t.id)+"</b>\n"+
        "موضوع: "+categoryName(t.category)+"\n"+
        "وضعیت: <b>"+(t.state==="open"?"🟢 باز":"✅ بسته‌شده")+"</b>\n"+
        (isAdmin?"مشتری: <code>"+escapeHtml(t.user_id)+"</code>\n":"")+
        "\n<b>آخرین پیام‌ها:</b>\n"+(excerpt||"هنوز پیامی وجود ندارد."),rows);
    };

    if(actor.role==="seller") {
      await reply("این صندوق مخصوص مشتریان و مدیر مدار است.",[[adminHome()[0]!]]);
      return true;
    }
    if(command==="/support" || data==="support:home") {
      await setState("");
      if(isAdmin) {
        await reply("💬 <b>پشتیبانی مدار</b>\nصندوق درخواست‌های مشتریان را باز کن.",[[btn("📥 درخواست‌های باز","support:admin:inbox:0")],[btn("🗂 درخواست‌های بسته‌شده","support:admin:archive:0")],adminHome()]);
        return true;
      }
      await reply("💬 <b>پشتیبانی مدار</b>\n\nبرای مشکل اتصال، پرداخت، تمدید یا مصرف از همین ربات درخواست ثبت کن. پاسخ مدیر همین‌جا به تو می‌رسد.",[
        [btn("➕ درخواست جدید","support:new")],
        [btn("📋 درخواست‌های من","support:mine:0")],
        home(),
      ]);
      return true;
    }
    if(data==="support:new" && !isAdmin) {
      await setState("");
      await reply("📨 <b>موضوع درخواستت را انتخاب کن.</b>",[
        ...Object.entries(categories).map(([key,label])=>[btn(label,"support:category:"+key)]),
        [btn("↩️ بازگشت به پشتیبانی","support:home")],
      ]);
      return true;
    }
    const categoryMatch=data.match(/^support:category:([a-z]+)$/);
    if(categoryMatch && !isAdmin) {
      const cat=categoryMatch[1]!;
      if(!validCategory(cat)) {
        await reply("این موضوع پشتیبانی معتبر نیست.",[[btn("💬 پشتیبانی","support:home")]]);
        return true;
      }
      const open=await db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id=? AND state='open'").bind(userId).first<number>("n");
      if((open||0)>=3) {
        await reply("حداکثر سه درخواست باز می‌توانی داشته باشی. از درخواست‌های قبلی پیام جدید بفرست.",[[btn("📋 درخواست‌های من","support:mine:0")]]);
        return true;
      }
      await setState("support:new:"+cat);
      await reply("✍️ <b>"+categoryName(cat)+"</b>\n\nمشکلت را در یک پیام توضیح بده یا عکس/فایل ارسال کن. پس از ارسال، شماره پیگیری صادر می‌شود. اطلاعات خصوصی کانفیگ را نفرست.",[[btn("↩️ انصراف","support:home")]]);
      return true;
    }
    const mine=data.match(/^support:mine:(0|[1-9][0-9]{0,2})$/);
    const inbox=data.match(/^support:admin:(inbox|archive):(0|[1-9][0-9]{0,2})$/);
    if((mine && !isAdmin) || (inbox && isAdmin)) {
      await setState("");
      const page=Math.min(999,Number(mine?.[1]||inbox?.[2])),size=6;
      const archived=inbox?.[1]==="archive";
      const results=mine
        ? await db.prepare("SELECT id,user_id,category,state,updated_at,created_at FROM support_tickets WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?").bind(userId,size+1,page*size).all<Ticket>()
        : await db.prepare("SELECT id,user_id,category,state,updated_at,created_at FROM support_tickets WHERE state=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?").bind(archived?"closed":"open",size+1,page*size).all<Ticket>();
      const rows:Record<string,unknown>[][]=results.results.slice(0,size).map(t=>[
        btn((t.state==="open"?"🟢 ":"✅ ")+ticketRef(t.id)+" · "+categoryName(t.category), (isAdmin?"support:admin:ticket:":"support:ticket:")+t.id),
      ]);
      const kind=mine?"mine":archived?"admin:archive":"admin:inbox";
      const nav:Record<string,unknown>[]=[];
      if(page>0) nav.push(btn("◀️ قبلی","support:"+kind+":"+(page-1)));
      if(results.results.length>size) nav.push(btn("بعدی ▶️","support:"+kind+":"+(page+1)));
      if(nav.length) rows.push(nav);
      if(isAdmin) rows.push([btn(archived?"📥 بازها":"🗂 بسته‌شده‌ها","support:admin:"+(archived?"inbox":"archive")+":0")]);
      rows.push([btn("↩️ پشتیبانی","support:home")]);
      await reply("📋 <b>"+(isAdmin?"صندوق پشتیبانی":"درخواست‌های من")+"</b>\n"+
        (results.results.length?"یک درخواست را برای مشاهده پیام‌ها انتخاب کن.":"فعلاً درخواستی در این بخش وجود ندارد."),rows);
      return true;
    }
    const detailMatch=data.match(new RegExp("^support:(ticket|admin:ticket):("+uuidPattern+")$"));
    if(detailMatch) {
      if((detailMatch[1]==="admin:ticket")!==isAdmin) {
        await reply("این درخواست در دسترس نیست.",[[btn("💬 پشتیبانی","support:home")]]);
        return true;
      }
      const t=await ticket(detailMatch[2]!);
      if(!t) await reply("درخواست پیدا نشد.",[[btn("💬 پشتیبانی","support:home")]]);
      else {await setState("");await detail(t);}
      return true;
    }
    const replyMatch=data.match(new RegExp("^support:(reply|admin:reply):("+uuidPattern+")$"));
    if(replyMatch) {
      if((replyMatch[1]==="admin:reply")!==isAdmin) {
        await reply("این درخواست در دسترس نیست.",[[btn("💬 پشتیبانی","support:home")]]);
        return true;
      }
      const t=await ticket(replyMatch[2]!);
      if(!t || t.state!=="open") {
        await reply("درخواست بسته یا نامعتبر است.",[[btn("💬 پشتیبانی","support:home")]]);
        return true;
      }
      await setState((isAdmin?"support:adminreply:":"support:reply:")+t.id);
      await reply("✉️ <b>پاسخ به "+ticketRef(t.id)+"</b>\n\nپیام، عکس یا فایل را همین‌جا ارسال کن.",[[btn("↩️ بازگشت به درخواست",(isAdmin?"support:admin:ticket:":"support:ticket:")+t.id)]]);
      return true;
    }
    const closeMatch=data.match(new RegExp("^support:admin:close:("+uuidPattern+")$"));
    if(closeMatch && isAdmin) {
      const t=await ticket(closeMatch[1]!);
      if(!t) {await reply("درخواست پیدا نشد.",[[btn("📥 صندوق","support:admin:inbox:0")]]);return true;}
      const change=await db.prepare("UPDATE support_tickets SET state='closed',closed_at=?,updated_at=? WHERE id=? AND state='open'")
        .bind(now,now,t.id).run();
      await setState("");
      if(change.meta.changes)
        await enqueue(db,"support:closed:"+t.id,t.user_id,{
          text:"✅ درخواست پشتیبانی "+ticketRef(t.id)+" بسته شد. اگر مشکل حل نشده از «درخواست‌های من» آن را بازگشایی کن.",
          reply_markup:{inline_keyboard:[[btn("📋 درخواست‌های من","support:mine:0")]]},
        });
      await reply("✅ درخواست بسته شد.",[[btn("📥 صندوق بازها","support:admin:inbox:0")],adminHome()]);
      return true;
    }
    const reopenMatch=data.match(new RegExp("^support:reopen:("+uuidPattern+")$"));
    if(reopenMatch && !isAdmin) {
      const t=await ticket(reopenMatch[1]!);
      if(!t) {await reply("درخواست پیدا نشد.",[[btn("📋 درخواست‌ها","support:mine:0")]]);return true;}
      const changed=await db.prepare("UPDATE support_tickets SET state='open',closed_at=NULL,updated_at=? WHERE id=? AND user_id=? AND state='closed'")
        .bind(now,t.id,userId).run();
      await setState("");
      if(changed.meta.changes) for(const adminId of adminIds) await enqueue(db,"support:reopen:"+t.id+":"+now+":"+adminId,adminId,{
        text:"🔄 درخواست پشتیبانی "+ticketRef(t.id)+" دوباره باز شد.",
        reply_markup:{inline_keyboard:[[btn("🔎 بررسی","support:admin:ticket:"+t.id)]]},
      });
      await reply("🟢 درخواست باز شد. می‌توانی پیام دیگری بفرستی.",[[btn("✉️ ارسال پیام","support:reply:"+t.id)],[btn("📋 درخواست‌ها","support:mine:0")]]);
      return true;
    }

    const newCat=state.startsWith("support:new:")?state.slice(12):null;
    const activeMatch=state.match(new RegExp("^support:(reply|adminreply):("+uuidPattern+")$"));
    if((newCat && validCategory(newCat)) || activeMatch) {
      const photo=u.message?.photo?.at(-1)?.file_id;
      const document=u.message?.document?.file_id;
      const fileId=document||photo||null;
      const kind=document?"document":photo?"photo":null;
      if(!u.message || (!fileId && !text)) {
        await reply("متن پیام یا تصویر/فایل را ارسال کن.",[[btn("↩️ بازگشت","support:home")]]);
        return true;
      }
      if((text && text.length>2000) || (fileId && fileId.length>1000)) {
        await reply("متن درخواست حداکثر ۲۰۰۰ حرف است. پیام کوتاه‌تری بفرست.",[[btn("↩️ بازگشت","support:home")]]);
        return true;
      }
      const recent=await db.prepare("SELECT COUNT(*) n FROM support_messages WHERE sender_id=? AND created_at>=?")
        .bind(userId,now-60).first<number>("n");
      if((recent||0)>=10) {
        await reply("برای جلوگیری از پیام‌های تکراری، یک دقیقه بعد دوباره پیام بفرست.",[[btn("📋 درخواست‌ها","support:home")]]);
        return true;
      }
      let t:Ticket|null=null;
      if(newCat && validCategory(newCat) && !isAdmin) {
        const max=await db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE user_id=? AND state='open'").bind(userId).first<number>("n");
        const previous=await db.prepare("SELECT id FROM support_tickets WHERE created_update_id=? AND user_id=?").bind(u.update_id,userId).first<string>("id");
        if(!previous && (max||0)>=3) {
          await setState("");
          await reply("حداکثر سه درخواست باز داری. از درخواست‌های قبلی استفاده کن.",[[btn("📋 درخواست‌ها","support:mine:0")]]);
          return true;
        }
        await db.prepare("INSERT OR IGNORE INTO support_tickets(id,user_id,category,created_update_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .bind(crypto.randomUUID(),userId,newCat,u.update_id,now,now).run();
        const created=await db.prepare("SELECT id FROM support_tickets WHERE created_update_id=? AND user_id=?")
          .bind(u.update_id,userId).first<string>("id");
        t=created?await ticket(created):null;
      } else if(activeMatch && ((activeMatch[1]==="adminreply")===isAdmin)) {
        t=await ticket(activeMatch[2]!);
      }
      if(!t || t.state!=="open") {
        await setState("");
        await reply("درخواست بسته یا نامعتبر است. از فهرست درخواست‌ها وارد شو.",[[btn("💬 پشتیبانی","support:home")]]);
        return true;
      }
      const inserted=await db.prepare("INSERT OR IGNORE INTO support_messages(ticket_id,sender_id,sender_role,message_text,file_id,file_kind,telegram_update_id,created_at) SELECT id,?,?,?,?,?,?,? FROM support_tickets WHERE id=? AND state='open'")
        .bind(userId,isAdmin?"admin":"customer",fileId?null:text,fileId,kind,u.update_id,now,t.id).run();
      if(!inserted.meta.changes) {
        await setState("");
        await reply("این پیام قبلاً ثبت شده یا درخواست بسته شده است.",[[btn("📋 درخواست‌ها","support:home")]]);
        return true;
      }
      await db.prepare("UPDATE support_tickets SET updated_at=? WHERE id=?").bind(now,t.id).run();
      await setState("");
      await notify(t,fileId?"[پیوست]":escapeHtml(text.slice(0,800)),fileId&&kind?{kind,id:fileId}:undefined);
      await reply((newCat?"✅ درخواست ثبت شد.":"✅ پیام ارسال شد.")+"\nشماره پیگیری: <code>"+ticketRef(t.id)+"</code>\n"+(isAdmin?"مشتری در همین ربات مطلع می‌شود.":"پاسخ مدیر در همین ربات ارسال می‌شود."),[
        [btn("🔎 مشاهده درخواست",(isAdmin?"support:admin:ticket:":"support:ticket:")+t.id)],
        [btn("📋 درخواست‌ها",isAdmin?"support:admin:inbox:0":"support:mine:0")],
      ]);
      return true;
    }
    await reply("این گزینه پشتیبانی معتبر نیست؛ از منوی پشتیبانی وارد شو.",[[btn("💬 پشتیبانی","support:home")]]);
    return true;
  }
  return false;
}

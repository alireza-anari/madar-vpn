import type { TelegramUpdate } from "./contracts";
import { resolveSalesActor } from "./resellers";
import { enqueue } from "./telegram";
import { sellerLimits, sellerNodeStats, sellerStats } from "./seller-accounting";
import { nodeCapacities, remainingAllocation, remainingSlots } from "./node-capacity";
import { ownedAccount } from "./accounts";
import { formatBytes } from "./sales-format";

const btn=(text:string,callback_data:string)=>({text,callback_data});
const home=()=>[btn("🏠 پنل فروشنده","rs:home")];
const esc=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const fa=(v:number)=>v.toLocaleString("fa-IR");
const date=(unix:number)=>new Date(unix*1000).toLocaleDateString("fa-IR",{timeZone:"Asia/Tehran"});
const idRegex=/^[a-zA-Z0-9-]{1,100}$/;
type State={flow:"seller-search";requestedAt:number};
type AccountView={id:string;label:string;state:string;quota_bytes:number|null;used_bytes:number;valid_until:number;created_at:number;node_name:string};
type Settlement={id:string;epoch:number;started_at:number;ended_at:number;config_count:number;sold_bytes:number;used_bytes:number};
const displayState=(a:AccountView,now:number)=>{
  if(a.state==="revoked")return "⛔ لغوشده";
  if(a.state==="blocked")return a.valid_until>now?"⏸ متوقف":"⌛ منقضی";
  if(a.state==="expired"||(a.valid_until>0&&a.valid_until<=now&&a.state==="active"))return "⌛ منقضی";
  if(a.state==="exhausted"||(a.quota_bytes!==null&&a.quota_bytes<=a.used_bytes&&a.state==="active"))return "📦 پایان حجم";
  if(a.state==="active")return "🟢 فعال";
  return "⏳ در حال آماده‌سازی";
};
function filteredAccountSql(filter:string){
  if(filter==="expiring")return "AND state IN ('active','blocked') AND valid_until>? AND valid_until<=? AND (quota_bytes IS NULL OR used_bytes<quota_bytes)";
  if(filter==="exhausted")return "AND (state='exhausted' OR (state IN ('active','blocked') AND quota_bytes IS NOT NULL AND used_bytes>=quota_bytes))";
  if(filter==="active")return "AND state IN ('active','blocked','preparing') AND (valid_until=0 OR valid_until>?) AND (quota_bytes IS NULL OR used_bytes<quota_bytes)";
  return "";
}
function accountRows(list:AccountView[],now:number){
  return list.map(a=>[btn(displayState(a,now)+" · "+a.label.slice(0,25),"seller:account:"+a.id)]);
}
export async function handleSellerTelegram(env:Env,u:TelegramUpdate,now:number):Promise<boolean>{
  const id=u.message?.from?.id??u.callback_query?.from.id;
  const chat=u.message?.chat??u.callback_query?.message?.chat;
  if(!id||!chat||chat.type!=="private"||chat.id!==id)return false;
  const user=String(id),data=u.callback_query?.data||"";
  const text=u.message?.text?.trim()||"";
  const db=env.SALES_DB;
  const raw=await db.prepare("SELECT conversation FROM users WHERE id=?").bind(user).first<string>("conversation")||"";
  const searchState=raw.startsWith('{"flow":"seller-search"')&&!!u.message&&!text.startsWith("/");
  if(!data.startsWith("seller:")&&!searchState)return false;
  const role=(await resolveSalesActor(db,user,env)).role;
  const reply=(content:string,rows:Record<string,unknown>[][]= [home()])=>
    enqueue(db,"u"+u.update_id+":reply",user,{
      text:content,parse_mode:"HTML",reply_markup:{inline_keyboard:rows},
    });
  if(role!=="seller"){
    await reply("⛔ این بخش فقط برای فروشنده فعال مدار است.",[[btn("🏠 منوی اصلی","rs:home")]]);
    return true;
  }
  const set=async(value:string)=>{
    await db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").bind(user).run();
    await db.prepare("UPDATE users SET conversation=? WHERE id=?").bind(value,user).run();
  };
  const listing=async(filter:string,page:number,query?:string)=>{
    const size=7;
    const conditions=filteredAccountSql(filter);
    const params:(string|number)[]=[user];
    if(filter==="expiring")params.push(now,now+3*86400);
    else if(filter==="active")params.push(now);
    let sql="SELECT a.id,a.label,a.state,a.quota_bytes,a.used_bytes,a.valid_until,a.created_at,n.name AS node_name "+
      "FROM managed_accounts a JOIN nodes n ON n.id=a.node_id "+
      "WHERE a.seller_id=? AND a.archived_at IS NULL "+conditions;
    if(query){
      sql+=" AND instr(lower(a.label),lower(?))>0";
      params.push(query);
    }
    sql+=" ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?";
    params.push(size+1,page*size);
    const rows=await db.prepare(sql).bind(...params).all<AccountView>();
    const nav:Record<string,unknown>[]=[];
    if(page>0)nav.push(btn("◀️ قبلی","seller:clients:"+filter+":"+(page-1)));
    if(rows.results.length>size)nav.push(btn("بعدی ▶️","seller:clients:"+filter+":"+(page+1)));
    const keyboard:Record<string,unknown>[][]=accountRows(rows.results.slice(0,size),now);
    if(nav.length)keyboard.push(nav);
    keyboard.push([btn("🔎 جستجوی مشتری","seller:search")]);
    keyboard.push([btn("📋 همه","seller:clients:all:0"),btn("🟢 فعال","seller:clients:active:0")]);
    keyboard.push([btn("⏳ نزدیک انقضا","seller:clients:expiring:0"),btn("📦 پایان حجم","seller:clients:exhausted:0")]);
    keyboard.push(home());
    await reply("👥 <b>مشتریان و کانفیگ‌های من</b>\n"+
      "فیلتر: "+esc(query?"جستجو: "+query:filter==="expiring"?"انقضا تا سه روز آینده":filter==="exhausted"?"پایان حجم":filter==="active"?"در سرویس":"همه")+
      "\n\n"+(rows.results.length?"برای جزئیات، حجم، تاریخ انقضا و اقدامات روی کانفیگ بزن.":"موردی در این بخش وجود ندارد."),keyboard);
  };
  const stats=async()=>{
    const [current,all,limits,nodes,expiring,exhausted]=await Promise.all([
      sellerStats(db,user,"current",now),sellerStats(db,user,"all",now),sellerLimits(db,user,now),
      sellerNodeStats(db,user,"current",now),
      db.prepare("SELECT COUNT(*) n FROM managed_accounts WHERE seller_id=? AND state IN ('active','blocked') AND valid_until>? AND valid_until<=? AND archived_at IS NULL").bind(user,now,now+3*86400).first<number>("n"),
      db.prepare("SELECT COUNT(*) n FROM managed_accounts WHERE seller_id=? AND (state='exhausted' OR (state IN ('active','blocked') AND quota_bytes IS NOT NULL AND used_bytes>=quota_bytes)) AND archived_at IS NULL").bind(user).first<number>("n"),
    ]);
    const countLeft=limits.maxReservedAccounts===null?null:Math.max(0,limits.maxReservedAccounts-limits.reservedAccounts);
    const bytesLeft=limits.maxCommittedBytes===null?null:Math.max(0,limits.maxCommittedBytes-limits.committedBytes);
    const alerts=[
      ...((countLeft===0||bytesLeft===0||limits.uncappedAccounts>0)?["⛔ سهمیه صدور جدید نیاز به بررسی مدیر دارد."]:[]),
      ...((expiring||0)>0?["⏳ "+fa(expiring||0)+" کانفیگ تا سه روز آینده منقضی می‌شود."]:[]),
      ...((exhausted||0)>0?["📦 "+fa(exhausted||0)+" کانفیگ به پایان حجم رسیده است."]:[]),
    ];
    await reply("📊 <b>گزارش فروشنده مدار</b>\n━━━━━━━━━━━━\n"+
      "<b>📅 دوره تسویه فعلی</b>\n"+
      "تعداد صدور: "+fa(current.configCount)+"\n"+
      "حجم کانفیگ‌های صادرشده: "+formatBytes(current.soldBytes)+"\n"+
      "مصرف ثبت‌شده: "+formatBytes(current.usedBytes)+"\n\n"+
      "<b>📈 تمام دوره‌ها</b>\n"+
      "صدور: "+fa(all.configCount)+" کانفیگ · "+formatBytes(all.soldBytes)+"\n"+
      "مصرف: "+formatBytes(all.usedBytes)+"\n"+
      "در سرویس: "+fa(all.liveCount+all.blockedCount)+"\n"+
      "لغوشده/منقضی/پایان حجم: "+fa(all.revokedCount+all.expiredCount+all.exhaustedCount)+"\n\n"+
      "<b>🎯 سهمیه فعلی</b>\n"+
      "تعداد اشغال‌شده: "+fa(limits.reservedAccounts)+" / "+(limits.maxReservedAccounts===null?"نامحدود":fa(limits.maxReservedAccounts))+"\n"+
      "حجم تعهدشده: "+formatBytes(limits.committedBytes)+" / "+(limits.maxCommittedBytes===null?"نامحدود":formatBytes(limits.maxCommittedBytes))+"\n"+
      "باقی‌مانده: "+(countLeft===null?"نامحدود":fa(countLeft)+" کانفیگ")+" · "+(bytesLeft===null?"نامحدود":formatBytes(bytesLeft))+"\n\n"+
      "<b>🌐 تفکیک سرورها (این تسویه)</b>\n"+
      (nodes.length?nodes.map(n=>esc(n.nodeName)+": "+fa(n.configCount)+" کانفیگ · "+formatBytes(n.soldBytes)).join("\n"):"هنوز فروشی ثبت نشده است.")+"\n\n"+
      "<b>🔔 هشدارها</b>\n"+(alerts.join("\n")||"✅ هشدار فوری ثبت نشده است.")+"\n\n"+
      "ℹ️ این گزارش حجم کانفیگ‌ها را نشان می‌دهد؛ مبلغ درآمد و واریزی بدون ثبت مالی قابل محاسبه نیست.",[
        [btn("👥 کانفیگ‌های من","seller:clients:all:0"),btn("🔔 هشدارها","seller:alerts")],
        [btn("🧾 تسویه‌ها","seller:settlements:0"),btn("🌐 سرورهای قابل فروش","seller:nodes")],
        home(),
      ]);
  };
  if(data==="seller:overview"||data==="seller:stats"){
    await set("");
    await stats();
    return true;
  }
  if(data==="seller:alerts"){
    await set("");
    const [limits,expiring,exhausted,paused]=await Promise.all([
      sellerLimits(db,user,now),
      db.prepare("SELECT id,label,valid_until FROM managed_accounts WHERE seller_id=? AND state IN ('active','blocked') AND valid_until>? AND valid_until<=? AND archived_at IS NULL ORDER BY valid_until ASC LIMIT 6")
        .bind(user,now,now+3*86400).all<{id:string;label:string;valid_until:number}>(),
      db.prepare("SELECT id,label FROM managed_accounts WHERE seller_id=? AND (state='exhausted' OR (state IN ('active','blocked') AND quota_bytes IS NOT NULL AND used_bytes>=quota_bytes)) AND archived_at IS NULL ORDER BY created_at DESC LIMIT 6")
        .bind(user).all<{id:string;label:string}>(),
      nodeCapacities(db,now),
    ]);
    const used=limits.maxReservedAccounts===null?0:limits.reservedAccounts/limits.maxReservedAccounts;
    const usedBytes=limits.maxCommittedBytes===null?0:limits.committedBytes/limits.maxCommittedBytes;
    const rows:Record<string,unknown>[][]=[
      ...expiring.results.map(x=>[btn("⏳ "+x.label.slice(0,29),"seller:account:"+x.id)]),
      ...exhausted.results.map(x=>[btn("📦 "+x.label.slice(0,29),"seller:account:"+x.id)]),
      [btn("👥 مشتریان من","seller:clients:all:0"),btn("📊 گزارش من","seller:overview")],
      home(),
    ];
    await reply("🔔 <b>هشدارهای فروشنده</b>\n\n"+
      (used>=1||usedBytes>=1?"⛔ سقف تعداد یا حجم پر شده است.\n":used>=.8||usedBytes>=.8?"⚠️ بیش از ۸۰٪ سهمیه درگیر است.\n":"✅ وضعیت سهمیه مجاز است.\n")+
      "⏳ نزدیک انقضا (۳ روز): "+fa(expiring.results.length)+(expiring.results.length>=6?" یا بیشتر":"")+"\n"+
      "📦 پایان حجم: "+fa(exhausted.results.length)+(exhausted.results.length>=6?" یا بیشتر":"")+"\n"+
      "🌐 سرورهای آماده: "+fa(paused.filter(n=>n.operational_status==="active"&&n.healthy===1&&n.last_seen>now-90&&n.agent_capabilities.split(",").includes("quota-v2")&&(remainingSlots(n)===null||remainingSlots(n)!>0)&&(remainingAllocation(n)===null||remainingAllocation(n)!>0)).length)+
      "\n\nبرای پیگیری تمدید و حجم، کانفیگ مربوط را انتخاب کن.",rows);
    return true;
  }
  if(data==="seller:nodes"){
    await set("");
    const [nodes,limits]=await Promise.all([nodeCapacities(db,now),sellerLimits(db,user,now)]);
    const eligible=nodes.filter(n=>n.operational_status==="active" && n.healthy===1 && n.last_seen>now-90 &&
      n.agent_capabilities.split(",").includes("quota-v2")&&(remainingSlots(n)===null||remainingSlots(n)!>0)&&
      (remainingAllocation(n)===null||remainingAllocation(n)!>0));
    await reply("🌐 <b>سرورهای قابل فروش</b>\n"+
      "مناسب بودن برای حجم مشخص هنگام ثبت صدور دوباره بررسی می‌شود.\n\n"+
      (eligible.length?eligible.map(n=>"🟢 "+esc(n.name)+" · "+(remainingSlots(n)===null?"نامحدود":fa(remainingSlots(n)!))+
        " جای خالی · "+(remainingAllocation(n)===null?"حجم نامحدود":formatBytes(remainingAllocation(n)!))).join("\n"):"در حال حاضر سرور دارای ظرفیت آماده نیست.")+"\n\n"+
      "🎯 سهمیه فروشنده: "+(limits.maxReservedAccounts===null?"نامحدود":fa(Math.max(0,limits.maxReservedAccounts-limits.reservedAccounts))+" کانفیگ")+
      " · "+(limits.maxCommittedBytes===null?"نامحدود":formatBytes(Math.max(0,limits.maxCommittedBytes-limits.committedBytes))),[
        [btn("➕ صدور کانفیگ","rs:sale"),btn("📊 گزارش من","seller:overview")],home(),
      ]);
    return true;
  }
  if(data==="seller:search"){
    await set(JSON.stringify({flow:"seller-search",requestedAt:now} satisfies State));
    await reply("🔎 <b>جستجوی مشتری</b>\n\nبخشی از نام یا برچسب مشتری را بفرست (۲ تا ۶۰ نویسه). فقط کانفیگ‌های خودت جستجو می‌شوند.",[
      [btn("↩️ فهرست مشتریان","seller:clients:all:0")],home(),
    ]);
    return true;
  }
  if(searchState){
    if(text.length<2||text.length>60){
      await reply("عبارت جستجو باید بین ۲ تا ۶۰ نویسه باشد.",[[btn("↩️ انصراف","seller:clients:all:0")],home()]);
      return true;
    }
    await set("");
    await listing("all",0,text);
    return true;
  }
  const list=data.match(/^seller:clients:(all|active|expiring|exhausted):(0|[1-9][0-9]{0,3})$/);
  if(list){
    await set("");
    await listing(list[1]!,Math.min(1000,Number(list[2])));
    return true;
  }
  const accountMatch=data.match(/^seller:account:([a-zA-Z0-9-]{1,100})$/);
  if(accountMatch){
    await set("");
    const found=await db.prepare("SELECT id FROM managed_accounts WHERE id=? AND seller_id=?").bind(accountMatch[1],user).first<string>("id");
    if(!found){
      await reply("این کانفیگ در حساب شما وجود ندارد.",[[btn("👥 مشتریان","seller:clients:all:0")],home()]);
      return true;
    }
    const a=await ownedAccount(db,{telegramId:user,role:"seller"},accountMatch[1]!);
    const node=await db.prepare("SELECT name FROM nodes WHERE id=?").bind(a.node_id).first<string>("name")||"نامشخص";
    const rows:Record<string,unknown>[][]=[
      [btn("🔄 مشاهده وضعیت تازه","seller:account:"+a.id),btn("📨 پیام کانفیگ","rs:resend:"+a.id)],
      ...(a.kind==="sale"?[[btn("🔁 درخواست تمدید","seller:request:renew:"+a.id),btn("📦 درخواست حجم اضافه","seller:request:traffic:"+a.id)]]:[]),
      [btn("👥 فهرست مشتریان","seller:clients:all:0")],home(),
    ];
    await reply("👤 <b>جزئیات کانفیگ مشتری</b>\n━━━━━━━━━━━━\n"+
      "نام: <b>"+esc(a.label)+"</b>\n"+
      "وضعیت: "+displayState({...a,node_name:node},now)+"\n"+
      "سرور: "+esc(node)+"\n"+
      "حجم: "+(a.quota_bytes===null?"نامحدود":formatBytes(a.quota_bytes))+"\n"+
      "مصرف: "+formatBytes(a.used_bytes)+"\n"+
      "باقی‌مانده: "+(a.quota_bytes===null?"نامحدود":formatBytes(Math.max(0,a.quota_bytes-a.used_bytes)))+"\n"+
      "اعتبار: "+(a.valid_until?date(a.valid_until):"پس از فعال‌سازی مشخص می‌شود")+"\n\n"+
      "تمدید یا افزایش حجم ابتدا به‌عنوان درخواست برای مدیر ارسال می‌شود و تا تأیید مدیر، سرویس تغییر نمی‌کند.",rows);
    return true;
  }
  const request=data.match(/^seller:request:(renew|traffic):([a-zA-Z0-9-]{1,100})$/);
  if(request){
    await set("");
    const kind=request[1]!,accountId=request[2]!;
    const found=await db.prepare("SELECT id FROM managed_accounts WHERE id=? AND seller_id=?").bind(accountId,user).first<string>("id");
    if(!found){
      await reply("این کانفیگ در حساب شما وجود ندارد.",[[btn("👥 مشتریان","seller:clients:all:0")],home()]);
      return true;
    }
    const a=await ownedAccount(db,{telegramId:user,role:"seller"},accountId);
    if(a.kind!=="sale"||a.archived_at!==null||a.state==="revoked"){
      await reply("امکان درخواست برای این کانفیگ وجود ندارد.",[[btn("👥 مشتریان","seller:clients:all:0")],home()]);
      return true;
    }
    const pending=await db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE user_id=? AND state='open'").bind(user).first<number>("n");
    const prior=await db.prepare("SELECT id FROM support_tickets WHERE created_update_id=? AND user_id=?").bind(u.update_id,user).first<string>("id");
    if(!prior&&(pending||0)>=3){
      await reply("سه درخواست پشتیبانی باز داری. ابتدا درخواست‌های قبلی را پیگیری کن.",[[btn("💬 درخواست‌های من","support:mine:0")],home()]);
      return true;
    }
    await db.prepare("INSERT OR IGNORE INTO support_tickets(id,user_id,category,state,created_update_id,created_at,updated_at) VALUES(?,? ,?,'open',?,?,?)")
      .bind(crypto.randomUUID(),user,kind==="renew"?"renewal":"usage",u.update_id,now,now).run();
    const tid=await db.prepare("SELECT id FROM support_tickets WHERE user_id=? AND created_update_id=?").bind(user,u.update_id).first<string>("id");
    if(!tid)throw Error("SUPPORT_CREATE_FAILED");
    const body="درخواست "+(kind==="renew"?"تمدید":"افزایش حجم")+" فروشنده <code>"+esc(user)+"</code>\n"+
      "کانفیگ: <code>"+esc(accountId)+"</code>\n"+
      "برچسب: "+esc(a.label.slice(0,80))+"\n"+
      "⚠️ این درخواست به‌معنای تأیید پرداخت یا اعمال تمدید نیست.";
    const textToSave="درخواست "+(kind==="renew"?"تمدید":"افزایش حجم")+" کانفیگ "+accountId+" | "+a.label.slice(0,80);
    await db.prepare("INSERT OR IGNORE INTO support_messages(ticket_id,sender_id,sender_role,message_text,telegram_update_id,created_at) VALUES(?,?,'customer',?,?,?)")
      .bind(tid,user,textToSave,u.update_id,now).run();
    const admins=[...new Set((env.ADMIN_TELEGRAM_IDS||"").split(",").map(x=>x.trim()).filter(x=>/^\d+$/.test(x)))];
    for(const admin of admins)await enqueue(db,"seller-upgrade:"+u.update_id+":"+admin,admin,{
      text:"📩 <b>درخواست فروشنده</b>\n"+body,parse_mode:"HTML",
      reply_markup:{inline_keyboard:[[btn("🔎 بررسی درخواست","support:admin:ticket:"+tid)]]},
    });
    await reply("✅ درخواست "+(kind==="renew"?"تمدید":"حجم اضافه")+" برای مدیر ثبت شد.\n"+
      "شماره پیگیری: <code>#"+tid.slice(0,8).toUpperCase()+"</code>\n"+
      "تا تأیید و اجرای درخواست توسط مدیر، حجم و اعتبار کانفیگ تغییر نمی‌کند.",[
        [btn("💬 مشاهده و پیگیری","support:ticket:"+tid)],
        [btn("👤 جزئیات کانفیگ","seller:account:"+accountId)],home(),
      ]);
    return true;
  }
  const settlements=data.match(/^seller:settlements:(0|[1-9][0-9]{0,2})$/);
  if(settlements){
    await set("");
    const page=Math.min(999,Number(settlements[1])),size=6;
    const result=await db.prepare("SELECT id,epoch,started_at,ended_at,config_count,sold_bytes,used_bytes FROM reseller_settlements WHERE seller_id=? ORDER BY ended_at DESC,id DESC LIMIT ? OFFSET ?")
      .bind(user,size+1,page*size).all<Settlement>();
    const rows:Record<string,unknown>[][]=result.results.slice(0,size).map(s=>[
      btn("🧾 "+date(s.ended_at)+" · "+fa(s.config_count)+" کانفیگ","seller:settlement:"+s.id),
    ]);
    const nav:Record<string,unknown>[]=[];
    if(page>0)nav.push(btn("◀️ قبلی","seller:settlements:"+(page-1)));
    if(result.results.length>size)nav.push(btn("بعدی ▶️","seller:settlements:"+(page+1)));
    if(nav.length)rows.push(nav);
    rows.push([btn("📊 گزارش من","seller:overview")],home());
    await reply("🧾 <b>تاریخچه تسویه فروشنده</b>\n"+
      (result.results.length?"تسویه‌های ثبت‌شده توسط مدیر را انتخاب کن.":"هنوز تسویه نهایی ثبت نشده است.")+
      "\n\nℹ️ اعداد مربوط به تعداد و حجم صدور هستند، نه مبالغ تسویه نقدی.",rows);
    return true;
  }
  const settlement=data.match(/^seller:settlement:([a-f0-9-]{36})$/);
  if(settlement){
    await set("");
    const row=await db.prepare("SELECT id,epoch,started_at,ended_at,config_count,sold_bytes,used_bytes FROM reseller_settlements WHERE id=? AND seller_id=?")
      .bind(settlement[1],user).first<Settlement>();
    if(!row){
      await reply("این تسویه متعلق به حساب شما نیست یا پیدا نشد.",[[btn("🧾 تسویه‌ها","seller:settlements:0")],home()]);
      return true;
    }
    const nodes=await db.prepare("SELECT sn.config_count,sn.sold_bytes,sn.used_bytes,n.name FROM reseller_settlement_nodes sn JOIN nodes n ON sn.node_id=n.id WHERE sn.settlement_id=? ORDER BY n.name")
      .bind(row.id).all<{config_count:number;sold_bytes:number;used_bytes:number;name:string}>();
    await reply("🧾 <b>جزئیات تسویه</b>\n"+
      "دوره: "+date(row.started_at)+" تا "+date(row.ended_at)+"\n"+
      "کانفیگ صادرشده: "+fa(row.config_count)+"\n"+
      "حجم صادرشده: "+formatBytes(row.sold_bytes)+"\n"+
      "مصرف ثبت‌شده در زمان تسویه: "+formatBytes(row.used_bytes)+"\n\n"+
      "<b>🌐 تفکیک سرورها</b>\n"+(nodes.results.length?nodes.results.map(n=>esc(n.name)+": "+fa(n.config_count)+" · "+formatBytes(n.sold_bytes)).join("\n"):"—")+
      "\n\n💰 مبلغ پرداخت‌شده در این گزارش ذخیره نمی‌شود.",[
        [btn("🧾 همه تسویه‌ها","seller:settlements:0")],home(),
      ]);
    return true;
  }
  await reply("این گزینه در دسترس نیست. از منوی فروشنده وارد شو.",[home()]);
  return true;
}

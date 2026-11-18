/** V2 staging-only, real account end-to-end commissioning.
 * An inactive zero-price plan and one owner-only 100 MiB/day trial
 * use the ordinary signed client manifest and real Xray UUID ACK flow.
 * Never enables store, receipts, sellers or arbitrary UUID issuance.
 */
import {nodeFromRef,nodeUiRef} from './node-admin.mjs';
import {reserveApprovedOrder} from './provisioning.mjs';
import {issueCarrierLink} from './carrier-subscription.mjs';
import {activeRoutes} from './subscription.mjs';
import {carrierPair} from './carrier-subscription.mjs';
import {frameMessage,panelHeading,faNumber} from './bot-ux.mjs';

const REF=/^[a-f0-9]{24}$/;
const TEST_PLAN='v2-admin-e2e-100mb-1day';
const QUOTA=100*1024*1024;
const MAX_DAY=86400000;
const btn=(label,key)=>[{text:label,callback_data:'v2:admin:configs:e2e:'+key}];
const view=(message,buttons=[])=>({text:frameMessage(message),replyMarkup:{inline_keyboard:[
  ...buttons,[{text:'↩️ صدور کانفیگ',callback_data:'v2:admin:configs'}],
]}});
export function enabled(env) {return env.ADMIN_E2E_TEST_ENABLED==='true';}
const admin=(env,actor)=>typeof actor==='string'&&/^[0-9]{5,20}$/.test(actor)&&
  typeof env.ADMIN_TELEGRAM_IDS==='string'&&env.ADMIN_TELEGRAM_IDS.split(',').includes(actor);

async function ownerNode(env,actor,ref) {
  if(!enabled(env)||!admin(env,actor)||!REF.test(ref??'')||!env.DB)return null;
  const node=await nodeFromRef(env.DB,ref);
  if(!node)return null;
  const job=await env.DB.prepare(
    "SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?"
  ).bind(node.id).first();
  if(!job||job.state!=='installed'||job.owner_id!==actor)return null;
  return node;
}
function orderId(ref){return 'e2e-'+ref;}
async function testState(db,ref,actor) {
  return db.prepare(
    "SELECT o.id AS order_id,o.state AS order_state,o.plan_id,o.quoted_amount,"+
    "s.id AS subscription_id,s.state AS subscription_state,s.expires_at,"+
    "s.max_bytes,s.used_bytes,a.state AS allocation_state,nc.observed_ms AS client_ack "+
    "FROM orders o LEFT JOIN subscriptions s ON s.order_id=o.id "+
    "LEFT JOIN node_allocations a ON a.subscription_id=s.id "+
    "LEFT JOIN node_client_acks nc ON nc.subscription_id=s.id AND nc.node_id=a.node_id "+
    "WHERE o.id=? AND o.customer_telegram_id=? AND o.plan_id=? AND o.quoted_amount=0 LIMIT 1"
  ).bind(orderId(ref),actor,TEST_PLAN).first();
}
export async function listE2e(env,actor,nowMs=Date.now()){
  if(!enabled(env)||!admin(env,actor))return view('⛔ آزمون صدور اختصاصی در این محیط فعال نیست.');
  const rows=(await env.DB.prepare(
    "SELECT n.id FROM nodes n JOIN node_bootstrap_jobs j ON j.node_id=n.id "+
    "JOIN node_health h ON h.node_id=n.id AND h.revision=n.desired_revision "+
    "WHERE j.owner_id=? AND j.state='installed' AND n.lifecycle='ready' "+
    "AND n.desired_revision=n.acked_revision AND h.xray_healthy=1 AND h.stats_healthy=1 "+
    "AND h.observed_ms BETWEEN ? AND ? ORDER BY n.id LIMIT 12"
  ).bind(actor,nowMs-600000,nowMs).all()).results??[];
  const buttons=[];
  for(const r of rows)buttons.push(btn('🧪 '+r.id,'view:'+await nodeUiRef(r.id)));
  return view(panelHeading('🧪','آزمون واقعی صدور','بدون پرداخت و بدون فعال‌سازی فروش')+
    '\n\n📦 حجم: ۱۰۰ مگابایت · مدت: ۱ روز · قیمت: صفر'+
    '\n🔐 صرفاً برای حساب مدیر و سروری که خودش ثبت کرده است.'+
    '\n\n'+(buttons.length?'یک سرور آماده را انتخاب کنید.':'سرور آماده‌ای با سلامت تازه وجود ندارد.'),buttons);
}

export async function e2eAction(env,actor,action,ref,nowMs=Date.now()){
  const node=await ownerNode(env,actor,ref);
  if(!node)return view('⛔ سرور آماده، مالکیت مدیر یا قابلیت تست معتبر نیست.');
  const db=env.DB;
  const state=await testState(db,ref,actor);
  if(['view','start','link'].includes(action)&&
     (node.lifecycle!=='ready'||node.desired_revision!==node.acked_revision))
    return view('⏸ سرور اکنون آماده نیست؛ تست جدید یا صدور لینک مجاز نیست. لغو تست قبلی همچنان ممکن است.',[
      btn('🔄 مشاهده وضعیت','status:'+ref)]);
  if(action==='view'){
    if(state)return e2eAction(env,actor,'status',ref,nowMs);
    return view(panelHeading('🧪','تست صدور واقعی',node.id)+
      '\n\nبرای آزمون نصب یک UUID واقعی روی هر دو درگاه REALITY، یک اشتراک آزمایشی '+ 
      'رایگان با ظرفیت ۱۰۰ مگابایت و مدت ۱ روز ایجاد می‌شود.'+
      '\n\nفروش عمومی همچنان بسته است. این عملیات Xray را از طریق عامل امضاشده تغییر می‌دهد.'+
      '\n\nفقط اگر این سرور آزمایشی متعلق به خودتان است تأیید کنید.',[
        btn('✅ ساخت اشتراک آزمایشی واقعی','start:'+ref),
        btn('↩️ سرورهای آماده','list')
      ]);
  }
  if(action==='start'){
    if(!state){
      // Exact, nonpublic plan: never activate it or assign a paid price.
      const changes=await db.batch([
        db.prepare(
          "INSERT OR IGNORE INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) "+
          "VALUES(?,'تست داخلی مدار','Madar Internal Test',0,'IRT',?,1,0)"
        ).bind(TEST_PLAN,QUOTA),
        db.prepare(
          "INSERT OR IGNORE INTO orders(id,customer_telegram_id,plan_id,idempotency_key,"+
          "quoted_amount,quoted_currency,state) "+
          "SELECT ?,?,?,?,0,'IRT','approved' FROM plans p JOIN customers c ON c.telegram_id=? "+
          "WHERE p.id=? AND p.price_amount=0 AND p.active=0 AND p.quota_bytes=? "+
          "AND p.duration_days=1 AND c.state='active'"
        ).bind(orderId(ref),actor,TEST_PLAN,'admin-e2e:'+ref,actor,TEST_PLAN,QUOTA),
      ]);
      if(Number(changes[1]?.meta?.changes)!==1 &&
         !await testState(db,ref,actor))
        return view('⛔ امکان ایجاد تست رایگان وجود ندارد. وضعیت مدیر و طرح آزمایشی را بررسی کنید.');
    }
    const current=await testState(db,ref,actor);
    if(!current)return view('⛔ سفارش آزمایشی معتبر نیست.');
    if(current.order_state==='approved'&&!current.subscription_id){
      const result=await reserveApprovedOrder(env,current.order_id,nowMs,node.id);
      if(result.status!=='reserved')
        return view('⏸ درخواست ذخیره شد، اما صدور هنوز انجام نشده است. علت: '+result.status+
          '\nپس از بهبود سلامت سرور، دوباره همین آزمون را انتخاب کنید.',[
            btn('🔄 تلاش مجدد','start:'+ref)]);
    }
    return e2eAction(env,actor,'status',ref,nowMs);
  }
  if(!state)return view('⏳ هنوز آزمون واقعی برای این سرور ثبت نشده است.',[
    btn('🧪 ایجاد آزمون','view:'+ref)]);
  if(action==='end')return view(panelHeading('⚠️','لغو اشتراک آزمایشی',node.id)+
    '\n\nاین اقدام اشتراک تست را لغو و همه لینک‌هایش را باطل می‌کند.'+
    '\nعامل سرور در چرخهٔ بعدی باید UUID را از Xray حذف و حذف آن را تأیید کند.',[
      btn('✅ لغو قطعی تست','revoke:'+ref),
      btn('↩️ انصراف','status:'+ref)]);
  if(action==='revoke'){
    if(state.subscription_id){
      await db.batch([
        db.prepare("UPDATE subscriptions SET state='revoked' WHERE id=? "+
          "AND owner_telegram_id=? AND state IN ('active','pending')")
          .bind(state.subscription_id,actor),
        db.prepare("UPDATE subscription_tokens SET revoked=1 WHERE subscription_id=?")
          .bind(state.subscription_id),
      ]);
    } else if(state.order_state==='approved'){
      await db.prepare("UPDATE orders SET state='cancelled' WHERE id=? AND state='approved'")
        .bind(state.order_id).run();
    }
    return view('✅ لغو آزمایش ثبت شد. لینک‌ها باطل شدند؛ تأیید حذف UUID باید از عامل سرور دریافت شود.',[
      btn('🔄 وضعیت لغو','status:'+ref)]);
  }
  if(action==='link'){
    if(state.subscription_state!=='active'||!state.subscription_id||
       state.allocation_state!=='active')
      return view('⏳ UUID هنوز روی نود نصب و توسط عامل تأیید نشده است.',[
        btn('🔄 بررسی دوباره','status:'+ref)]);
    const routes=await activeRoutes(db,state.subscription_id,nowMs);
    if(!carrierPair(routes))return view('⏳ دو مسیر تأییدشده برای این UUID هنوز آماده نیستند.',[
      btn('🔄 بررسی دوباره','status:'+ref)]);
    const link=await issueCarrierLink(env,state.subscription_id,nowMs);
    return view(link?'✅ لینک خصوصی آزمایشی، فقط برای مدیر:\n'+link.url+
      '\n\nشامل دو مسیر همراه اول (۴۴۳) و ایرانسل (۸۴۴۳) با یک سقف مصرف مشترک.':
      '⏳ مسیر واقعی آماده است ولی سرویس لینک هنوز غیرفعال یا نامعتبر است.',[
        btn('🔄 وضعیت','status:'+ref)]);
  }
  if(action!=='status')return view('⚠️ عملیات آزمون معتبر نیست.');
  const ack=Number(state.client_ack??0)>nowMs-600000;
  const active=state.subscription_state==='active'&&state.allocation_state==='active'&&ack;
  const text=panelHeading('🧪','وضعیت تست واقعی',node.id)+
    '\n\nسفارش: '+(state.order_state??'نامشخص')+
    '\nاشتراک: '+(state.subscription_state??'در انتظار رزرو')+
    '\nنصب UUID اختصاصی: '+(ack?'✅ ACK واقعی دریافت شد':'⏳ هنوز ACK تازه دریافت نشده')+
    '\nحجم استفاده‌شده: '+faNumber(state.used_bytes??0)+' از '+faNumber(QUOTA)+' بایت'+
    '\n\n'+(active?'✅ UUID نصب و تأیید شده؛ می‌توانید لینک خصوصی بگیرید.':
      state.subscription_state==='revoked'?'⛔ تست لغو شده؛ منتظر تأیید حذف از نود.':
      '⏳ عامل مدیریت باید کانفیگ جدید را واقعاً روی Xray اعمال کند.');
  const buttons=[
    ...(active?[btn('🔗 دریافت لینک دو اپراتور','link:'+ref)]:[]),
    ...(state.subscription_state!=='revoked'&&state.order_state!=='cancelled'?
      [btn('🛑 پایان و لغو تست','end:'+ref)]:[]),
    btn('🔄 تازه‌سازی','status:'+ref),
  ];
  return view(text,buttons);
}

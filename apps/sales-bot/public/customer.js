const client = String.raw`(function () {
  "use strict";
  const tg = window.Telegram?.WebApp;
  // Telegram signs tgWebAppData on launch. Some desktop/in-app WebViews expose
  // the signed launch parameter before the telegram.org bridge script loads.
  // This is NOT a substitute for server-side HMAC + auth_date verification.
  function signedLaunchData() {
    const sdkValue = tg?.initData;
    if (sdkValue) return sdkValue;
    for (const raw of [window.location.hash.slice(1),window.location.search.slice(1)]) {
      const value = new URLSearchParams(raw).get("tgWebAppData");
      if (value && value.length <= 8192) return value;
    }
    return "";
  }
  const initData = signedLaunchData();
  const root = document.getElementById("customer-content");
  const nav = document.getElementById("customer-nav");
  const toast = document.getElementById("customer-toast");
  const state = {tab:"plans",role:"ordinary",plans:[],paymentConfigured:false,orders:[],
    selectedPlan:null,selectedNode:"",nodes:[],busy:false,pendingKey:"",configs:{},payment:""};
  const esc = v => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const digits = n => Number(n || 0).toLocaleString("fa-IR");
  const gb = bytes => digits(Number(bytes)/1e9) + " گیگابایت";
  const money = (value,currency) => digits(value)+" "+(currency==="IRT"?"تومان":"ریال");
  const stateCopy = {awaiting_receipt:"در انتظار ارسال رسید",pending_review:"در انتظار تأیید پرداخت",
    approving:"در حال ثبت کانفیگ",approved:"تأیید شده",rejected:"رد شده"};
  const errCopy = {MISSING_TELEGRAM_LAUNCH:"پنل را ببندید؛ در چت ربات /start بفرستید و فقط دکمه «🛍️ پنل خرید مشتریان» را بزنید. لینک معمولی یا صفحه ذخیره‌شده اطلاعات ورود ندارد.",INVALID_SIGNATURE:"اطلاعات ورود تلگرام معتبر نیست؛ پنل را ببندید و از دکمه داخل چت ربات دوباره باز کنید.",AUTH_EXPIRED:"نشست منقضی شد؛ پنل را دوباره از ربات باز کنید.",
    PLAN_UNAVAILABLE:"این طرح دیگر قابل خرید نیست.",NODE_UNAVAILABLE:"سرور انتخاب‌شده ظرفیت کافی ندارد.",
    NODE_FULL:"ظرفیت سرور تکمیل شده است.",NODE_ALLOCATION_FULL:"حجم سرور کافی نیست.",
    SALES_DISABLED:"اطلاعات پرداخت هنوز توسط مدیر ثبت نشده است.",ORDER_NOT_AVAILABLE:"این سفارش در این وضعیت قابل تغییر نیست.",
    KEY_REUSED:"درخواست خرید قبلی را بررسی کنید.",REQUEST_FAILED:"خطای موقت سرور؛ دوباره تلاش کنید."};
  const notify = message => {toast.textContent=message;toast.hidden=false;setTimeout(()=>{toast.hidden=true},4000)};
  async function api(path,options={}) {
    const response=await fetch(path,{...options,headers:{
      "X-Telegram-Init-Data":initData,...(options.body?{"Content-Type":"application/json"}:{}),...(options.headers||{})
    },cache:"no-store"});
    const body=await response.json().catch(()=>({error:"REQUEST_FAILED"}));
    if (!response.ok) throw Error(body.error || "REQUEST_FAILED");
    return body;
  }
  function block(title,description) {return '<section class="card empty"><h2>'+esc(title)+'</h2><p class="muted">'+esc(description)+'</p></section>';}
  function planCard(p) {
    return '<article class="card"><div class="plan-head"><h2>'+esc(p.name)+'</h2><div class="price">'+esc(money(p.price,p.currency))+'</div></div>'+
      '<div class="details"><span class="tag">'+esc(gb(p.quotaBytes))+'</span><span class="tag">'+esc(digits(p.durationSeconds/86400))+' روز</span></div>'+
      '<button class="btn wide" type="button" data-buy-plan="'+esc(p.id)+'" '+(!state.paymentConfigured?'disabled':'')+'>انتخاب این طرح</button></article>';
  }
  function picker() {
    const plan=state.plans.find(p=>p.id===state.selectedPlan);
    if (!plan) return "";
    return '<section class="card"><h2>انتخاب سرور برای '+esc(plan.name)+'</h2><p class="muted">فقط سرورهای دارای ظرفیت نمایش داده می‌شوند. صدور پس از تأیید پرداخت و بررسی مجدد ظرفیت است.</p>'+
      (state.nodes.length?'<label for="node-choice">سرور قابل فروش</label><select id="node-choice">'+
        state.nodes.map(n=>'<option value="'+esc(n.id)+'" '+(n.id===state.selectedNode?'selected':'')+'>'+esc(n.name)+'</option>').join("")+'</select>'+
        '<button type="button" class="btn wide" data-action="checkout" '+(state.busy?'disabled':'')+'>ثبت سفارش و نمایش مشخصات پرداخت</button>':
        '<p class="warning">فعلاً سروری با ظرفیت کافی وجود ندارد.</p>')+
      '<button class="btn secondary wide" type="button" data-action="cancel">بازگشت به طرح‌ها</button></section>';
  }
  function renderPlans() {
    if (state.selectedPlan) return picker();
    const warning=state.paymentConfigured?"":'<p class="warning">فروش هنوز فعال نشده؛ مدیر باید مشخصات پرداخت را تنظیم کند.</p>';
    return '<h2>طرح‌های موجود</h2>'+warning+(state.plans.length?state.plans.map(planCard).join(""):
      block("فعلاً طرحی فعال نیست","پس از ثبت طرح‌های دارای حجم و قیمت، می‌توانید از همین صفحه خرید کنید."));
  }
  function orderCard(o) {
    const paid=o.state==="approved";
    const detail=o.accountState ? '<p class="muted">وضعیت کانفیگ: '+esc(o.accountState)+' · مصرف: '+esc(gb(o.usedBytes || 0))+'</p>' : "";
    const actions=o.state==="awaiting_receipt"?
      '<button class="btn wide" data-receipt="'+esc(o.id)+'" type="button">ارسال رسید در چت ربات</button>':
      paid?'<button class="btn secondary wide" data-config="'+esc(o.id)+'" type="button">مشاهده و کپی کانفیگ</button>':"";
    const result=state.configs[o.id];
    const config=result?.ready?'<div class="note">سرور: '+esc(result.serverName)+'<p class="config" dir="ltr">'+esc(result.config)+'</p></div>'+
      '<div class="stack"><button class="btn secondary" type="button" data-copy="'+esc(o.id)+'">کپی کانفیگ</button>'+
      (result.usageUrl?'<button class="btn secondary" type="button" data-usage="'+esc(o.id)+'">مصرف و اعتبار</button>':"")+'</div>':
      result?'<p class="warning">کانفیگ هنوز آماده نیست؛ پس از تأیید سرور دوباره بررسی کنید.</p>':"";
    return '<article class="card"><div class="order-head"><strong>سفارش '+esc(o.id.slice(0,8))+'</strong><span class="state '+(paid?'active':'')+'">'+esc(stateCopy[o.state]||o.state)+'</span></div>'+
      '<div class="details"><span class="tag">'+esc(gb(o.quotaBytes))+'</span><span class="tag">'+esc(digits(o.durationSeconds/86400))+' روز</span>'+
      '<span class="tag">'+esc(money(o.price,o.currency))+'</span></div>'+detail+
      (o.reason?'<p class="warning">'+esc(o.reason)+'</p>':"")+actions+result+'</article>';
  }
  function renderOrders() {
    const pending=state.orders.some(o=>o.state==="awaiting_receipt");
    const instructions=pending && state.payment?'<section class="card"><h2>مشخصات پرداخت</h2><div class="note">'+esc(state.payment)+'</div><p class="muted">پس از واریز، برای سفارش موردنظر روی «ارسال رسید در چت ربات» بزنید.</p></section>':"";
    return '<h2>سفارش‌های من</h2>'+instructions+(state.orders.length?state.orders.map(orderCard).join(""):
      block("هنوز سفارشی ندارید","از بخش خرید اشتراک یک طرح انتخاب کنید."));
  }
  function renderAdmin() {
    return '<section class="card"><h2>تنظیمات فروش</h2>'+
      '<p class="muted">شماره کارت یا توضیحات پرداخت را وارد کنید. تنها مدیر می‌تواند آن را تغییر دهد.</p>'+
      '<label for="payment-value">اطلاعات پرداخت</label><textarea id="payment-value" maxlength="1000" placeholder="مشخصات صاحب حساب و روش پرداخت"></textarea>'+
      '<button class="btn wide" data-action="save-payment">ذخیره اطلاعات پرداخت</button></section>'+
      '<section class="card"><h2>ساخت یا ویرایش طرح</h2>'+
      '<label for="plan-id">شناسه طرح (انگلیسی)</label><input id="plan-id" maxlength="40" placeholder="monthly_30gb">'+
      '<label for="plan-name">نام طرح</label><input id="plan-name" maxlength="80" placeholder="اشتراک یک‌ماهه ۳۰ گیگ">'+
      '<label for="plan-price">قیمت (تومان)</label><input id="plan-price" type="number" min="1" inputmode="numeric">'+
      '<label for="plan-days">مدت (روز)</label><input id="plan-days" type="number" min="1" max="365" value="30">'+
      '<label for="plan-quota">حجم (گیگابایت)</label><input id="plan-quota" type="number" min="1" max="1000" value="30">'+
      '<button class="btn wide" data-action="save-plan">ثبت و فعال‌سازی طرح</button></section>'+
      '<p class="hint">رسیدهای مشتری در چت ربات برای مدیر ارسال می‌شوند. بعد از بررسی واریز، تأیید یا رد را همان‌جا انجام دهید.</p>';
  }
  function render() {
    if (!root) return;
    nav.querySelectorAll("[data-tab]").forEach(b=>b.setAttribute("aria-current",b.dataset.tab===state.tab?"page":"false"));
    if (state.role==="admin" && !nav.querySelector('[data-tab="admin"]')) {
      const button=document.createElement("button");button.type="button";button.dataset.tab="admin";button.textContent="مدیریت";nav.append(button);
    }
    root.innerHTML=state.tab==="plans"?renderPlans():state.tab==="orders"?renderOrders():
      state.tab==="admin" && state.role==="admin"?renderAdmin():
      block("راهنمای مدار","پس از انتخاب طرح، مشخصات پرداخت نمایش داده می‌شود. رسید را در چت ربات بفرستید. مدیر پس از بررسی، سرویس را روی سرور آماده می‌کند؛ کانفیگ و مصرف در بخش سفارش‌های من قابل مشاهده است.");
  }
  async function refresh() {
    try {
      if (!initData) throw Error("MISSING_TELEGRAM_LAUNCH");
      const [me,plans,orders,payment]=await Promise.all([
        api("/api/customer/me"),api("/api/customer/plans"),api("/api/customer/orders"),api("/api/customer/payment")]);
      state.role=me.role;state.plans=plans.plans;state.paymentConfigured=plans.paymentConfigured;
      state.orders=orders;state.payment=payment.payment || "";render();
    } catch(e) {root.innerHTML=block("ورود ناموفق",errCopy[e.message]||"دوباره از چت ربات باز کنید.");}
  }
  function key() {
    const data=crypto.getRandomValues(new Uint8Array(16));
    return Array.from(data,x=>x.toString(16).padStart(2,"0")).join("");
  }
  async function action(fn) {
    if (state.busy) return;
    state.busy=true;
    try {await fn()} catch(e) {notify(errCopy[e.message] || "عملیات ناموفق بود: "+e.message)}
    finally {state.busy=false;render()}
  }
  nav?.addEventListener("click",e=>{
    const button=e.target.closest("[data-tab]");if (!button) return;
    state.tab=button.dataset.tab;state.selectedPlan=null;render();
  });
  document.getElementById("refresh")?.addEventListener("click",()=>refresh());
  root?.addEventListener("change",e=>{
    if (e.target.id==="node-choice") {state.selectedNode=e.target.value;state.pendingKey="";}
  });
  root?.addEventListener("click",async e=>{
    const button=e.target.closest("button");if (!button) return;
    if (button.dataset.buyPlan) return action(async()=>{
      state.selectedPlan=button.dataset.buyPlan;
      const nodes=await api("/api/customer/nodes?planId="+encodeURIComponent(state.selectedPlan));
      state.nodes=nodes;state.selectedNode=nodes[0]?.id || "";state.pendingKey="";
    });
    if (button.dataset.action==="cancel") {state.selectedPlan=null;render();return}
    if (button.dataset.action==="checkout") return action(async()=>{
      if (!state.pendingKey) state.pendingKey=key();
      const order=await api("/api/customer/orders",{method:"POST",body:JSON.stringify({
        planId:state.selectedPlan,nodeId:state.selectedNode,requestKey:state.pendingKey,
      })});
      state.selectedPlan=null;state.pendingKey="";state.tab="orders";state.payment=order.payment || "";
      state.orders=await api("/api/customer/orders");
      notify("سفارش ثبت شد. مبلغ "+money(order.price,order.currency)+"؛ مشخصات پرداخت: "+order.payment);

    });
    if (button.dataset.receipt) return action(async()=>{
      await api("/api/customer/orders/"+encodeURIComponent(button.dataset.receipt)+"/receipt-request",
        {method:"POST",body:"{}"});
      notify("در چت ربات، عکس یا فایل رسید را بفرستید. می‌توانید به تلگرام برگردید.");
      state.orders=await api("/api/customer/orders");
    });
    if (button.dataset.config) return action(async()=>{
      state.configs[button.dataset.config]=await api("/api/customer/orders/"+encodeURIComponent(button.dataset.config)+"/config");
    });
    if (button.dataset.copy) {
      const result=state.configs[button.dataset.copy];
      if (!result?.config) return;
      try {await navigator.clipboard.writeText(result.config);notify("کانفیگ کپی شد.")}
      catch {notify("کپی خودکار ممکن نیست؛ متن کانفیگ را انتخاب و کپی کنید.")}
      return;
    }
    if (button.dataset.usage) {
      const url=state.configs[button.dataset.usage]?.usageUrl;
      if (url) tg?.openLink?.(url);
      return;
    }
    if (button.dataset.action==="save-payment") return action(async()=>{
      await api("/api/customer/admin/payment",{method:"POST",
        body:JSON.stringify({value:document.getElementById("payment-value").value})});
      state.paymentConfigured=true;notify("اطلاعات پرداخت ذخیره شد.");
    });
    if (button.dataset.action==="save-plan") return action(async()=>{
      const get=id=>document.getElementById(id).value;
      await api("/api/customer/admin/plans",{method:"POST",body:JSON.stringify({
        id:get("plan-id"),name:get("plan-name"),price:Number(get("plan-price")),
        currency:"IRT",durationDays:Number(get("plan-days")),quotaGb:Number(get("plan-quota")),enabled:true,
      })});
      state.plans=(await api("/api/customer/plans")).plans;
      notify("طرح فعال شد.");
    });
  });
  tg?.ready?.();tg?.expand?.();refresh();
})();
`;

export default client;

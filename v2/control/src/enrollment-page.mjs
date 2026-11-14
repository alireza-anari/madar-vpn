// Same-origin Mini App. Only encrypted SSH credentials leave this form.
export const enrollmentPage=String.raw`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>افزودن سرور مدار V2</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{font:16px/1.9 system-ui;background:#0c1728;color:#eef3ff;max-width:560px;margin:24px auto;padding:16px}input,select,button{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px;margin:8px 0 16px;border:1px solid #456;border-radius:12px;background:#182b43;color:inherit}button{background:#246bbe}button:disabled{opacity:.5}fieldset{border:1px solid #456;border-radius:16px}#status{white-space:pre-wrap;overflow-wrap:anywhere}#fingerprint{direction:ltr;overflow-wrap:anywhere}input[type=checkbox]{width:auto;display:inline}</style>
<h1>افزودن سرور مدار V2</h1><p>اطلاعات سرور را وارد کن؛ بررسی اتصال و نصب از همین صفحه انجام می‌شود. رمز و کلید را در پیام تلگرام نفرست.</p>
<details id="runnerPairing" hidden><summary>فعال‌سازی یک‌باره سرویس نصب V2 (فقط مدیر)</summary>
<p>این کار فقط یک‌بار روی میزبان رانر موجود انجام می‌شود، نه هنگام افزودن هر سرور. سرویس V1 تغییر نمی‌کند.</p>
<button type="button" id="pairRunner">آماده‌سازی اتصال امن رانر</button><p id="pairingStatus" role="status"></p>
</details>
<form id="form">
<label>شناسه سرور<input id="nodeId" value="test-aws01" required pattern="test-[A-Za-z0-9_-]{2,55}"></label>
<label>ارائه‌دهنده<input id="provider" value="aws" required></label><label>منطقه<input id="region" value="eu-north-1" required></label>
<label>سقف کاربر<input id="userLimit" type="number" value="20" min="1" max="100000" required></label><label>سقف حجم گیگابایت<input id="capacityGb" type="number" value="500" min="1" max="200000" required></label>
<label>IP سرور<input id="ip" dir="ltr" required></label><label>پورت SSH<input id="port" type="number" value="22" min="1" max="65535" required></label><label>نام کاربر<input id="username" value="root" dir="ltr" required></label>
<button id="probe" type="button" disabled>۱ · بررسی اتصال</button>
<fieldset id="credentials" hidden><legend>۲ · ورود امن و نصب خودکار</legend><p id="fingerprint"></p><label><input id="trust" type="checkbox">اثر انگشت را با پنل ارائه‌دهنده مطابقت دادم</label>
<label>روش ورود<select id="method"><option value="password">رمز سرور</option><option value="key">کلید خصوصی SSH</option></select></label>
<label>فایل کلید خصوصی<input id="keyfile" type="file"></label><label>رمز سرور یا رمز محافظ کلید<input id="password" type="password" autocomplete="off"></label><button id="install" type="submit">شروع نصب خودکار</button></fieldset></form><p id="status" role="status" aria-live="polite"></p>
<script>
const tg=window.Telegram?.WebApp;tg?.ready();const el=id=>document.getElementById(id),auth=tg?.initData||'';let publicKey,probeId,fingerprint,timer,busy=false;
const status=s=>el('status').textContent=s;
const errors={PAIRING_KEY_NOT_CONFIGURED:'کلید عمومی رانر فعلی هنوز تنظیم نشده است.',RUNNER_OFFLINE:'اجراکننده مستقل V2 هنوز روی میزبان AWS متصل نشده است؛ هیچ نصبی شروع نمی‌شود.',RUNNER_NOT_CONFIGURED:'اتصال اجراکننده هنوز تنظیم نشده است.',EXECUTOR_NOT_CONFIGURED:'اجرای درخواستی هنوز به‌طور امن فعال نشده است.',EXECUTOR_DISPATCH_FAILED:'اجرای نصب در GitHub شروع نشد؛ هیچ تغییری در سرور انجام نشد.',AUTH_EXPIRED:'این صفحه را ببند و از ربات دوباره باز کن.',INVALID_TARGET:'مشخصات سرور معتبر نیست.',NODE_ALREADY_EXISTS:'این شناسه قبلاً ثبت شده است.',PROBE_REQUIRED:'بررسی اتصال را دوباره انجام بده.',JOB_ALREADY_PENDING:'یک کار در حال اجرا داری.'};
async function api(path,data){const r=await fetch('/api/enrollment/'+path,{method:data?'POST':'GET',headers:{'content-type':'application/json','x-telegram-init-data':auth},...(data?{body:JSON.stringify(data)}:{})});const b=await r.json();if(!r.ok)throw Error(errors[b.error]||'عملیات انجام نشد؛ دوباره تلاش کن.');return b;}
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
function restoreSpec(spec){
  if(!spec)return;
  for(const id of ['nodeId','provider','region','ip','username'])
    if(typeof spec[id]==='string')el(id).value=spec[id];
  for(const id of ['userLimit','capacityGb','port'])
    if(Number.isInteger(spec[id]))el(id).value=String(spec[id]);
}
async function restoreJob(){
  const {job}=await api('recent');
  if(!job)return status('آماده بررسی سرور.');
  restoreSpec(job.spec);
  if(job.kind==='probe'&&job.state==='ready'&&job.fingerprint){
    probeId=job.id;fingerprint=job.fingerprint;
    el('fingerprint').textContent=fingerprint;
    el('credentials').hidden=false;
    el('install').disabled=false;
    return status('بررسی قبلی بازیابی شد. فقط پس از تطبیق اثر انگشت، نصب را ادامه بده.');
  }
  if(job.state==='queued'||job.state==='leased'){
    busy=true;el('probe').disabled=true;lock(true);
    status('درخواست قبلی بازیابی شد؛ در حال بررسی نتیجه…');
    return poll(job.id,job.kind==='probe'?'probe':'install');
  }
  if(job.state==='failed')
    return status('بررسی قبلی ناموفق بود: '+(job.safe_code||'INSTALLATION_FAILED')+'. می‌توانی دوباره بررسی کنی.');
  status('درخواست قبلی پایان یافته است؛ برای سرور دیگر، اطلاعات را تغییر بده.');
}
async function encrypt(value){const rsa=await crypto.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(JSON.stringify(value)));const key=await crypto.subtle.encrypt('RSA-OAEP',rsa,await crypto.subtle.exportKey('raw',aes));return {v:1,key:b64(key),iv:b64(iv),data:b64(data)};}
function lock(value){for(const id of ['nodeId','provider','region','userLimit','capacityGb','ip','port','username'])el(id).disabled=value;}
async function poll(id,kind){clearTimeout(timer);try{const b=await api('jobs/'+id);if(b.state==='failed'){busy=false;lock(false);el('probe').disabled=false;const detail={SSH_TIMEOUT:'اتصال به پورت SSH به مهلت زمانی رسید؛ تنظیمات Firewall یا Security Group را بررسی کن.',SSH_REFUSED:'پورت SSH اتصال را رد کرد؛ ممکن است پورت یا سرویس SSH متفاوت باشد.',SSH_UNREACHABLE:'مسیر شبکه به IP سرور در دسترس نیست.',SSH_HANDSHAKE_FAILED:'پاسخ SSH معتبر دریافت نشد؛ سرویس یا پورت SSH را بررسی کن.',PROBE_EXPIRED:'مهلت این بررسی به پایان رسید.',SSH_PROBE_FAILED:'بررسی SSH ناموفق بود؛ جزئیات شبکه باید بررسی شود.',SSH_AUTH_FAILED:'احراز هویت SSH رد شد؛ نام کاربری یا رمز ورود را با اطلاعات وب‌داده مطابقت بده.',SSH_LOGIN_FAILED:'ورود SSH تکمیل نشد؛ تنظیمات SSH و مجوز کاربر را بررسی کن.',HOST_KEY_CHANGED:'اثر انگشت SSH سرور تغییر کرده؛ نصب متوقف شد.',INVALID_SSH_KEY:'فایل کلید SSH معتبر نیست.',CREDENTIALS_EXPIRED:'اعتبار درخواست نصب تمام شده است.',CREDENTIAL_DECRYPT_FAILED:'اطلاعات ورود رمزگشایی نشد؛ صفحه را از ربات دوباره باز کن.',REMOTE_INSTALL_FAILED:'ورود SSH انجام شد ولی فرمان نصب روی VPS ناموفق بود؛ سرویس موجود یا سیستم‌عامل باید بررسی شود.',INSTALL_REPORT_FAILED:'اجرای نصب به پایان گزارش نرسید؛ وضعیت VPS باید بررسی شود.'};status('عملیات ناموفق بود: '+(detail[b.safe_code]||b.safe_code||'INSTALLATION_FAILED'));return;}if(b.state==='ready'){busy=false;if(kind==='probe'){probeId=id;fingerprint=b.fingerprint;el('fingerprint').textContent=fingerprint;el('credentials').hidden=false;el('install').disabled=false;status('اتصال بررسی شد. هویت سرور را تأیید و اطلاعات ورود را وارد کن.');}else{el('credentials').hidden=true;status('نصب ثبت شد. به ربات برگرد و «صدور کانفیگ تست» را بزن. آزمون اینترنت و سهمیه هنوز جداگانه انجام می‌شود.');}return;}status(kind==='probe'?'در حال بررسی اتصال…':'نصب در حال اجراست…');timer=setTimeout(()=>poll(id,kind),3000);}catch(e){busy=false;status(e.message);}}
el('pairRunner').onclick=async()=>{
  el('pairRunner').disabled=true;
  try{
    const r=await api('pair-runner',{});
    el('pairingStatus').textContent=r.status==='RUNNER_CONNECTED'
      ?'رانر V2 از قبل متصل است؛ صفحه را از ربات دوباره باز کن.'
      :'اتصال رمزگذاری‌شده برای ۱۰ دقیقه آماده شد. فرمان نصب یک‌باره V2 باید روی میزبان رانر قدیمی اجرا شود؛ هیچ رمز یا کلید خصوصی از آن خارج نمی‌شود.';
  }catch(e){el('pairingStatus').textContent=e.message;}
  finally{el('pairRunner').disabled=false;}
};
el('probe').onclick=async()=>{if(busy||!el('form').reportValidity())return;busy=true;el('probe').disabled=true;el('credentials').hidden=true;el('trust').checked=false;try{const b={};for(const id of ['nodeId','provider','region','ip','username'])b[id]=el(id).value.trim();for(const id of ['userLimit','capacityGb','port'])b[id]=Number(el(id).value);const job=await api('probe',b);lock(true);poll(job.id,'probe');}catch(e){busy=false;el('probe').disabled=false;status(e.message);}};
el('form').onsubmit=async e=>{e.preventDefault();if(busy||!probeId||!el('trust').checked){status('ابتدا اثر انگشت سرور را تأیید کن.');return;}busy=true;el('install').disabled=true;let credentials;try{credentials=el('method').value==='password'?{method:'password',password:el('password').value}:{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};if(credentials.method==='password'?!credentials.password:!credentials.key)throw Error('اطلاعات ورود را وارد کن.');const envelope=await encrypt(credentials);credentials=null;el('password').value='';el('keyfile').value='';const job=await api('install',{probeId,fingerprint,trust:true,envelope});poll(job.id,'install');}catch(e){busy=false;el('install').disabled=false;status(e.message);}finally{credentials=null;el('password').value='';el('keyfile').value='';}};
if(!auth)status('این صفحه را از دکمه افزودن سرور در ربات V2 باز کن.');
else api('session').then(async s=>{
  publicKey=s.publicKey;el('probe').disabled=false;
  try{await restoreJob();}catch(e){status(e.message);}
}).catch(e=>{
  el('runnerPairing').hidden=false;
  status(e.message);
});
</script></html>`;

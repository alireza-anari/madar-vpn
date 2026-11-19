// Same-origin Mini App. Only encrypted SSH credentials leave this form.
export const enrollmentPage=String.raw`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>افزودن سرور مدار V2</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{color-scheme:dark;--surface:#111f33;--surface2:#172b45;--line:#2d4564;--accent:#438df5;--muted:#a9bbd2}
*{box-sizing:border-box}
body{font:16px/1.9 system-ui,-apple-system,sans-serif;background:radial-gradient(ellipse at top,#18365a 0,#0b1628 48%,#07111f 100%);color:#eef4ff;max-width:600px;min-height:100vh;margin:0 auto;padding:28px 16px 40px}
h1{font-size:25px;line-height:1.5;margin:8px 0 12px;letter-spacing:-.4px}
body>p:first-of-type{color:#bdcce0;margin:0 0 20px}
form,details{background:linear-gradient(145deg,rgba(24,43,69,.96),rgba(14,28,46,.96));border:1px solid var(--line);border-radius:20px;padding:18px;margin:16px 0;box-shadow:0 18px 44px rgba(0,0,0,.22)}
label{display:block;font-weight:600;color:#dbe7f8}
input,select,button{box-sizing:border-box;display:block;width:100%;font:inherit;padding:12px 14px;margin:8px 0 16px;border:1px solid #385474;border-radius:13px;background:#0c1a2c;color:inherit;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{outline:none;border-color:#6aa7ff;box-shadow:0 0 0 3px rgba(67,141,245,.18)}
button{background:linear-gradient(135deg,#438df5,#2868c7);border:0;font-weight:750;cursor:pointer;box-shadow:0 8px 18px rgba(25,91,183,.22)}
button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
fieldset{border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:18px}
legend{padding:0 8px;color:#a9caff;font-weight:700}
summary{cursor:pointer;font-weight:700;color:#c7dcf7}
#status{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(8,20,35,.75);border:1px solid var(--line);border-radius:14px;padding:12px 14px;color:#d9e8ff;min-height:48px}
#fingerprint{direction:ltr;overflow-wrap:anywhere;background:#091727;border:1px dashed #54749a;border-radius:12px;padding:10px}
input[type=checkbox]{width:auto;display:inline;accent-color:#438df5}
</style>
<h1>افزودن سرور مدار V2</h1><p>اطلاعات سرور را وارد کن؛ بررسی اتصال و نصب از همین صفحه انجام می‌شود. رمز و کلید را در پیام تلگرام نفرست.</p>
<details id="runnerPairing" hidden><summary>فعال‌سازی یک‌باره سرویس نصب V2 (فقط مدیر)</summary>
<p>این کار فقط یک‌بار روی میزبان رانر موجود انجام می‌شود، نه هنگام افزودن هر سرور. سرویس V1 تغییر نمی‌کند.</p>
<button type="button" id="pairRunner">آماده‌سازی اتصال امن رانر</button><p id="pairingStatus" role="status"></p>
</details>
<form id="form">
<label>شناسه سرور<input id="nodeId" placeholder="webdade6" required minlength="3" maxlength="64" pattern="[A-Za-z][A-Za-z0-9_-]{2,63}" title="شناسه ۳ تا ۶۴ کاراکتر؛ با حرف لاتین شروع شود و فقط شامل حروف لاتین، عدد، خط تیره و زیرخط باشد."></label><small>برای مثال: webdade6 یا aws-eu1. پیشوند test- اجباری نیست؛ نام‌های رزروشده مانند production قابل استفاده نیستند.</small>
<label>ارائه‌دهنده<input id="provider" value="aws" required></label><label>منطقه<input id="region" value="eu-north-1" required></label>
<label>سقف کاربر<input id="userLimit" type="number" value="20" min="1" max="100000" required></label><label>سقف حجم گیگابایت<input id="capacityGb" type="number" value="500" min="1" max="200000" required></label>
<label>IP سرور<input id="ip" dir="ltr" required></label><label>پورت SSH<input id="port" type="number" value="22" min="1" max="65535" required></label><label>نام کاربر<input id="username" value="root" dir="ltr" required></label>
<button id="probe" type="button" disabled>۱ · بررسی اتصال</button>
<fieldset id="credentials" hidden><legend>۲ · ورود امن و نصب خودکار</legend><p id="fingerprint"></p><label><input id="trust" type="checkbox">اثر انگشت را با پنل ارائه‌دهنده مطابقت دادم</label>
<label>روش ورود<select id="method"><option value="password">رمز سرور</option><option value="key">کلید خصوصی SSH</option></select></label>
<label>فایل کلید خصوصی<input id="keyfile" type="file"></label><label>رمز سرور یا رمز محافظ کلید<input id="password" type="password" autocomplete="off"></label><button id="install" type="submit">شروع نصب خودکار</button><button id="diagnose" type="button" hidden disabled>🔎 عیب‌یابی بدون نصب (فقط بررسی)</button><button id="clearFailed" type="button" hidden disabled>پاک‌سازی ثبت نصب ناموفق و شروع دوباره</button><button id="resetInstalled" type="button" hidden>🧹 پاک‌سازی V2 از سرور و نصب دوباره</button><p id="resetNote" hidden>فقط سرویس‌ها و فایل‌های اختصاصی V2 پاک می‌شوند. پیش از اقدام، سوابق اشتراک و میزان مصرف بررسی می‌شوند؛ برای نصب جدید شناسه تازه لازم است.</p><p id="diagnoseNote" hidden>فقط اطلاعات سیستم و دسترسی دانلود بررسی می‌شود؛ هیچ نصب یا حذفی انجام نمی‌شود. اطلاعات SSH فقط به‌صورت رمزگذاری‌شده ارسال می‌شوند.</p></fieldset></form><p id="status" role="status" aria-live="polite"></p>
<script>
const tg=window.Telegram?.WebApp;tg?.ready();const el=id=>document.getElementById(id),auth=tg?.initData||'';let publicKey,probeId,fingerprint,timer,busy=false,failedInstallId=null,failedNodeId=null,installedProbe=false,runtimeDownId=null,diagnosticId=null,probeExpires=0;
const status=s=>el('status').textContent=s;
const errors={PAIRING_KEY_NOT_CONFIGURED:'کلید عمومی رانر فعلی هنوز تنظیم نشده است.',RUNNER_OFFLINE:'اجراکننده مستقل V2 هنوز روی میزبان AWS متصل نشده است؛ هیچ نصبی شروع نمی‌شود.',RUNNER_NOT_CONFIGURED:'اتصال اجراکننده هنوز تنظیم نشده است.',EXECUTOR_NOT_CONFIGURED:'اجرای درخواستی هنوز به‌طور امن فعال نشده است.',EXECUTOR_DISPATCH_FAILED:'اجرای نصب در GitHub شروع نشد؛ هیچ تغییری در سرور انجام نشد.',AUTH_EXPIRED:'این صفحه را ببند و از ربات دوباره باز کن.',INVALID_TARGET:'مشخصات سرور معتبر نیست.',NODE_ALREADY_EXISTS:'این شناسه از نصب ناموفق قبلی در مدار ثبت شده است. پیش از تلاش مجدد، عیب‌یابی بدون نصب را اجرا کن.',PROBE_REQUIRED:'مهلت بررسی اتصال تمام شده یا اثر انگشت معتبر نیست؛ دوباره «بررسی اتصال» را بزن.',CLEAN_DIAG_REQUIRED:'ابتدا نتیجه موفق عیب‌یابی بدون نصب را دریافت کن.',NODE_RESET_UNSAFE:'پاک‌سازی خودکار امن نیست؛ این سرور داده وابسته دارد و باید بررسی شود.',JOB_ALREADY_PENDING:'یک کار در حال اجرا داری.',FAILED_INSTALL_REQUIRED:'درخواست نصب ناموفق قبلی پیدا نشد؛ صفحه را از ربات دوباره باز کن.',NODE_NOT_INSTALLED:'فقط سرور نصب‌شده متعلق به این مدیر قابل پاک‌سازی است.',NODE_HAS_ACTIVE_OR_USED_ACCOUNTS:'سرور دارای اشتراک فعال یا مصرف‌شده است. پاک‌سازی بدون تعیین تکلیف مشتریان مجاز نیست.',NODE_HAS_LIVE_TRIAL:'لینک آزمایشی هنوز معتبر است؛ پس از پایان اعتبار اقدام کن.',NODE_HAS_PAID_ORDERS:'سفارش پرداخت‌شده یا رسید تأییدشده به این سرور وابسته است.',RESET_HOST_MISMATCH:'IP ثبت‌شده برای این سرور با سرور متصل‌شده مطابقت ندارد.',RESET_EXPLICIT_CONSENT_REQUIRED:'تأیید صریح نام سرور و تطبیق اثر انگشت لازم است.',RESET_QUARANTINE_FAILED:'امکان جداسازی ایمن سرور از صدور کانفیگ وجود ندارد.',RESET_BLOCKED:'پاک‌سازی روی VPS به‌دلیل وجود داده مصرف یا فایل‌های ناشناس متوقف شد.',RESET_CLEANUP_FAILED:'پاک‌سازی روی سرور کامل نشد؛ وضعیت را قبل از تلاش مجدد بررسی کن.',RESET_DB_FINALIZATION_FAILED:'پاک‌سازی سمت سرور گزارش شد ولی بستن عملیات در دیتابیس کامل نشد؛ دوباره نصب نکن.'};
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
  const {job,failedInstall}=await api('recent');
  if(!job)return status('آماده بررسی سرور.');
  restoreSpec(job.spec);
  if(job.cleanup&&job.state==='ready'&&job.safe_code==='RESET_COMPLETED'){
    installedProbe=false;
    el('credentials').hidden=true;
    const oldId=job.spec.nodeId;
    el('nodeId').value=oldId.slice(0,55)+'-new1';
    return status('پاک‌سازی اختصاصی V2 در VPS تأیید شد و سرور قبلی بازنشسته شد. اکنون شناسه جدید را بررسی کن و نصب را از ابتدا انجام بده.');
  }
  if(job.kind==='v2-install'&&job.diagnostic&&job.state==='ready'&&
     job.safe_code==='DIAG_PRECHECK_OK'&&failedInstall?.id){
    showDiagnoseForInstall(failedInstall.id,failedInstall.fingerprint,job.spec.nodeId);
    diagnosticId=job.id;
    el('diagnose').hidden=true;el('diagnoseNote').hidden=true;
    el('clearFailed').hidden=false;el('clearFailed').disabled=false;
    return status('عیب‌یابی موفق بود. اگر VPS همان سرور پاک و آماده است، ثبت نصب ناموفق را پاک کن و اتصال را دوباره بررسی کن.');
  }
  if(failedInstall?.id&&failedInstall?.fingerprint){
    showDiagnoseForInstall(failedInstall.id,failedInstall.fingerprint,job.spec.nodeId);
    return status('نصب قبلی این شناسه ناموفق بوده است: '+
      (installDetails[failedInstall.safe_code]||'مرحله نصب روی VPS شکست خورده است.')+
      ' برای جلوگیری از نصب تکراری، ابتدا «عیب‌یابی بدون نصب» را بزن.');
  }
  if(job.kind==='probe'&&job.state==='ready'&&job.fingerprint){
    if(job.expires_ms<=Date.now()+5000)
      return status('مهلت اعتبار بررسی قبلی (۱۰ دقیقه) تمام شده است. دوباره «بررسی اتصال» را بزن.');
    probeExpires=job.expires_ms;
    probeId=job.id;fingerprint=job.fingerprint;
    el('fingerprint').textContent=fingerprint;
    el('credentials').hidden=false;
    if((await api('jobs/'+job.id)).installed)return showInstalledProbe();
    el('install').disabled=false;
    return status('بررسی قبلی بازیابی شد. فقط پس از تطبیق اثر انگشت، نصب را ادامه بده.');
  }
  if(job.cleanup&&job.state==='failed'){
    installedProbe=false;
    return status('پاک‌سازی سرور کامل نشده است. سرویس ممکن است نیمه‌پاک شده باشد؛ بدون بررسی وضعیت VPS، نصب مجدد را آغاز نکن.');
  }
  if(job.kind==='v2-install'&&job.state==='failed'&&!job.diagnostic&&!job.cleanup&&job.fingerprint){
    showDiagnoseForInstall(job.id,job.fingerprint,job.spec.nodeId);
    return status('نصب قبلی ناموفق بود: '+('خطای نامشخص در نصب')+'. برای بررسی بدون نصب دوباره اطلاعات ورود را وارد کن.');
  }
  if(job.kind==='v2-install'&&job.diagnostic&&['failed','ready'].includes(job.state))
    return status(diagnosisMessage(job.safe_code));
  if(job.state==='queued'||job.state==='leased'){
    busy=true;el('probe').disabled=true;lock(true);
    status('درخواست قبلی بازیابی شد؛ در حال بررسی نتیجه…');
    return poll(job.id,job.kind==='probe'?'probe':job.cleanup?'cleanup':job.diagnostic?'diagnose':'install');
  }
  if(job.state==='failed')
    return status('بررسی قبلی ناموفق بود: '+'خطای نامشخص در بررسی'+'. می‌توانی دوباره بررسی کنی.');
  status('درخواست قبلی پایان یافته است؛ برای سرور دیگر، اطلاعات را تغییر بده.');
}
async function encrypt(value){const rsa=await crypto.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(JSON.stringify(value)));const key=await crypto.subtle.encrypt('RSA-OAEP',rsa,await crypto.subtle.exportKey('raw',aes));return {v:1,key:b64(key),iv:b64(iv),data:b64(data)};}
function lock(value){for(const id of ['nodeId','provider','region','userLimit','capacityGb','ip','port','username'])el(id).disabled=value;}
const diagnosticDetail={
  DIAG_RUNTIME_STARTED:'عامل مدار راه‌اندازی شد. وضعیت سفارش را در ربات بررسی کن.',
  DIAG_RUNTIME_START_FAILED:'عامل مدار راه‌اندازی نشد.',
  DIAG_RUNTIME_ACTIVE:'عامل و Xray فعال هستند و خطای تازه‌ای در لاگ عامل دیده نشد.',
  DIAG_RUNTIME_DOWN:'عامل مدار فعال نیست.',
  DIAG_XRAY_DOWN:'سرویس Xray فعال نیست.',
  DIAG_RUNTIME_GENERATION:'عامل تغییر پردازش Xray را تشخیص داده و شمارش مصرف نیاز به بررسی دارد.',
  DIAG_RUNTIME_ERROR:'عامل مدار اخیراً خطای اجرا یا ارتباط ثبت کرده است.',
  DIAG_EXISTING_VPN:'روی سرور فایل یا سرویس VPN قبلی وجود دارد؛ نصب ایمن نیاز به VPS تازه و خالی دارد. بدون حذف دستی، از ارائه‌دهنده بازسازی سرور را درخواست کن.',
  DIAG_PORT_443_BUSY:'پورت 443 سرور توسط سرویس دیگری اشغال شده است.',
  DIAG_PORT_8443_BUSY:'پورت 8443 سرور توسط سرویس دیگری اشغال شده است.',
  DIAG_UNSUPPORTED_OS:'سیستم‌عامل سرور Ubuntu یا Debian نیست؛ نصب آزمایشی V2 فقط این دو را پشتیبانی می‌کند.',
  DIAG_NO_ROOT:'دسترسی ریشه برای اجرای نصب وجود ندارد.',
  DIAG_SYSTEMD_MISSING:'پیش‌نیازهای systemd یا useradd روی سرور وجود ندارند.',
  DIAG_GITHUB_UNREACHABLE:'دریافت نسخه Xray از GitHub از داخل سرور ممکن نیست؛ محدودیت شبکه خروجی را بررسی کن.',
  DIAG_PRECHECK_OK:'پیش‌نیازهای اولیه برقرارند؛ شکست نصب در مرحله داخلی دیگری رخ داده است و نیاز به بررسی دقیق‌تر اسکریپت دارد.',
  DIAG_REMOTE_FAILED:'بررسی از داخل VPS کامل نشد. این پیام به معنی اجرای نصب نیست.'
};
function diagnosisMessage(code){
  return 'نتیجه عیب‌یابی بدون نصب: '+(diagnosticDetail[code]||'خطای نامشخص در عیب‌یابی رخ داد.');
}
function showDiagnoseForInstall(id,fp,nodeId=el('nodeId').value.trim()){
  failedInstallId=id;failedNodeId=nodeId;fingerprint=fp;probeId=null;probeExpires=0;
  diagnosticId=null;el('clearFailed').hidden=true;el('clearFailed').disabled=true;
  el('fingerprint').textContent=fp;
  el('credentials').hidden=false;
  el('trust').checked=false;
  el('install').disabled=true;
  el('diagnose').hidden=false;
  el('diagnose').disabled=false;
  el('diagnoseNote').hidden=false;
}
const installDetails={SSH_TIMEOUT:'مهلت اتصال SSH تمام شد.',SSH_REFUSED:'اتصال SSH رد شد.',SSH_UNREACHABLE:'مسیر SSH در دسترس نیست.',SSH_HANDSHAKE_FAILED:'پاسخ SSH معتبر دریافت نشد.',PROBE_EXPIRED:'مهلت بررسی پایان یافت.',SSH_PROBE_FAILED:'بررسی SSH ناموفق بود.',SSH_AUTH_FAILED:'نام کاربری یا رمز SSH پذیرفته نشد.',SSH_LOGIN_FAILED:'ورود SSH کامل نشد.',HOST_KEY_CHANGED:'اثر انگشت سرور تغییر کرده است.',INVALID_SSH_KEY:'کلید SSH معتبر نیست.',CREDENTIALS_EXPIRED:'اعتبار درخواست نصب پایان یافت.',CREDENTIAL_DECRYPT_FAILED:'اطلاعات ورود رمزگشایی نشد.',REMOTE_INSTALL_FAILED:'ورود SSH موفق بود اما اجرای فرمان نصب روی VPS شکست خورد.',INSTALL_REPORT_FAILED:'نتیجه نصب قابل ثبت نبود.'};
Object.assign(installDetails,{
  REMOTE_PACKAGE_FAILED:'آماده‌سازی بسته نصب روی سرور کامل نشد.',
  REMOTE_BOOTSTRAP_FAILED:'نصب اولیه یا راه‌اندازی سرویس REALITY روی پورت 8443 ناموفق بود.',
  REMOTE_DUAL_FAILED:'فعال‌سازی هم‌زمان پورت‌های 443 و 8443 ناموفق بود؛ وضعیت بازگشت باید بررسی شود.',
  REMOTE_METADATA_FAILED:'خواندن نتیجه نصب برای ثبت در مدار ناموفق بود.'
});
function showInstalledProbe(){
  installedProbe=true;
  el('resetInstalled').hidden=false;el('resetInstalled').disabled=false;
  el('resetNote').hidden=false;
  el('fingerprint').textContent=fingerprint;
  el('credentials').hidden=false;
  el('install').disabled=true;
  el('diagnose').hidden=false;el('diagnose').disabled=false;
  el('diagnoseNote').hidden=true;
  status('سرور قبلاً نصب شده است. هویت سرور را تأیید کن و برای بررسی عامل، کلید را در همین فرم وارد کن.');
}
async function poll(id,kind){
  clearTimeout(timer);
  try{
    const b=await api('jobs/'+id);
    if(b.state==='failed'){
      busy=false;lock(false);el('probe').disabled=false;
      if(kind==='install'&&b.fingerprint)showDiagnoseForInstall(id,b.fingerprint);
      status(kind==='cleanup'?'پاک‌سازی کامل نشد: '+(errors[b.safe_code]||'وضعیت سرور نیازمند بررسی است. از تکرار خودکار حذف خودداری کن.'):kind==='diagnose'?diagnosisMessage(b.safe_code):
        'عملیات ناموفق بود: '+(installDetails[b.safe_code]||'خطای نامشخص هنگام نصب رخ داد.'));
      return;
    }
    if(b.state==='ready'){
      busy=false;lock(false);el('probe').disabled=false;
      if(kind==='probe'){
        probeId=id;fingerprint=b.fingerprint;
        probeExpires=Date.now()+9*60*1000;
        if(b.installed){
          showInstalledProbe();
        }else if(failedInstallId&&failedNodeId===el('nodeId').value.trim()){
          showDiagnoseForInstall(failedInstallId,fingerprint,failedNodeId);
          status('اتصال برقرار است، اما ثبت نصب ناموفق قبلی هنوز وجود دارد. ابتدا «عیب‌یابی بدون نصب» را بزن.');
        }else{
          failedInstallId=null;failedNodeId=null;el('diagnose').hidden=true;
          el('fingerprint').textContent=fingerprint;el('credentials').hidden=false;
          el('install').disabled=false;
          status('اتصال بررسی شد. هویت سرور را تأیید و اطلاعات ورود را وارد کن.');
        }
      }else if(kind==='cleanup'){
        el('resetInstalled').disabled=false;
        el('resetInstalled').hidden=true;el('resetNote').hidden=true;
        el('credentials').hidden=true;
        installedProbe=false;runtimeDownId=null;probeId=null;probeExpires=0;
        el('nodeId').value=el('nodeId').value.slice(0,55)+'-new1';
        status('✅ پاک‌سازی اختصاصی V2 روی VPS تأیید شد. سابقه سرور قدیمی حفظ و دسترسی آن بازنشسته شد. شناسه جدید آماده است؛ دکمه «بررسی اتصال» را بزن و نصب جدید را انجام بده.');
      }else if(kind==='diagnose'){
        if(installedProbe){
          runtimeDownId=b.safe_code==='DIAG_RUNTIME_DOWN'?id:null;
          el('diagnose').textContent=runtimeDownId?'راه‌اندازی عامل مدار':'عیب‌یابی بدون نصب (فقط بررسی)';
          el('diagnose').disabled=false;
          status(diagnosisMessage(b.safe_code)+(runtimeDownId?' برای راه‌اندازی عامل، کلید را دوباره انتخاب کن.':''));
          return;
        }
        diagnosticId=b.safe_code==='DIAG_PRECHECK_OK'?id:null;
        el('clearFailed').hidden=!diagnosticId;
        el('clearFailed').disabled=!diagnosticId;
        el('diagnose').hidden=!!diagnosticId;
        el('diagnose').disabled=false;
        status(diagnosisMessage(b.safe_code)+
          (diagnosticId?' در صورت اطمینان از خالی بودن VPS، ثبت ناموفق را پاک کن.':' هیچ نصب یا حذفی اجرا نشد.'));
      }else{
        el('credentials').hidden=true;
        status('نصب ثبت شد. به ربات برگرد و «صدور کانفیگ تست» را بزن. آزمون اینترنت و سهمیه هنوز جداگانه انجام می‌شود.');
      }
      return;
    }
    status(kind==='probe'?'در حال بررسی اتصال…':kind==='cleanup'?'در حال پاک‌سازی امن V2 روی VPS…':kind==='diagnose'?'در حال عیب‌یابی فقط‌خواندنی سرور…':'نصب در حال اجراست…');
    timer=setTimeout(()=>poll(id,kind),3000);
  }catch(e){busy=false;status('ارتباط با سرویس برقرار نشد؛ دوباره تلاش کنید.');}
}
el('resetInstalled').onclick=async()=>{
  if(busy||!installedProbe||!probeId||!fingerprint||!el('trust').checked||Date.now()>=probeExpires){
    status('برای پاک‌سازی، ابتدا بررسی اتصال و تطبیق اثر انگشت SSH را انجام بده.');return;
  }
  const nodeId=el('nodeId').value.trim();
  busy=true;el('resetInstalled').disabled=true;
  let credentials=null;
  try{
    const gate=await api('reset-check?nodeId='+encodeURIComponent(nodeId));
    if(!gate.ok)throw Error(errors[gate.code]||'به علت اطلاعات وابسته روی سرور، پاک‌سازی مجاز نیست.');
    const count=gate.willCancelPending||0;
    const consent=prompt('پاک‌سازی V2 روی سرور '+nodeId+' غیرقابل بازگشت است. '+
      (count?'تعداد '+count+' سفارش آزمایشیِ نصب‌نشده لغو می‌شود. ':'')+
      'فقط فایل‌ها و سرویس‌های اختصاصی مدار حذف می‌شوند. برای تأیید، نام سرور را دقیق وارد کن:');
    if(consent!==nodeId){busy=false;el('resetInstalled').disabled=false;status('پاک‌سازی لغو شد؛ هیچ فرمانی اجرا نشد.');return;}
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('رمز یا کلید SSH را در فرم امن وارد کن.');
    const envelope=await encrypt(credentials);credentials=null;
    const job=await api('reset',{nodeId,confirmNodeId:nodeId,confirm:'RESET_V2_ONLY',
      probeId,fingerprint,trust:true,envelope});
    el('password').value='';el('keyfile').value='';
    status('درخواست پاک‌سازی امن ثبت شد؛ در حال تأیید عملیات از سرور…');
    poll(job.id,'cleanup');
  }catch(e){busy=false;el('resetInstalled').disabled=false;status('پاک‌سازی آغاز نشد: '+e.message);}
  finally{credentials=null;}
};
el('clearFailed').onclick=async()=>{
  if(busy||!failedInstallId||!diagnosticId)return;
  busy=true;el('clearFailed').disabled=true;
  try{
    const result=await api('clear-failed',{failedInstallId,diagnosticId});
    if(result.status!=='CLEARED')throw Error('پاک‌سازی تأیید نشد.');
    failedInstallId=null;failedNodeId=null;diagnosticId=null;probeId=null;probeExpires=0;fingerprint=null;
    el('credentials').hidden=true;el('clearFailed').hidden=true;
    el('keyfile').value='';el('password').value='';el('trust').checked=false;
    el('probe').disabled=false;
    status('ثبت نصب ناموفق از مدار پاک شد. دوباره «بررسی اتصال» را بزن و سپس نصب را آغاز کن.');
  }catch(e){el('clearFailed').disabled=false;status('پاک‌سازی انجام نشد: '+e.message);}
  finally{busy=false;}
};
el('diagnose').onclick=async()=>{
  if(busy||(!failedInstallId&&!installedProbe)||!fingerprint||!el('trust').checked){
    status('ابتدا اثر انگشت SSH قبلی را تأیید کن.');return;
  }
  if(runtimeDownId&&!confirm('عامل مدار روی همین سرور راه‌اندازی شود؟'))return;
  busy=true;el('diagnose').disabled=true;
  let credentials;
  try{
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('اطلاعات ورود را در فرم امن وارد کن.');
    const envelope=await encrypt(credentials);
    credentials=null;
    const job=await api(installedProbe?'diagnose-installed':'diagnose',{failedInstallId,probeId,fingerprint,trust:true,envelope,startRuntime:!!runtimeDownId,diagnosticId:runtimeDownId});
    el('password').value='';el('keyfile').value='';
    status('عیب‌یابی بدون نصب شروع شد…');
    poll(job.id,'diagnose');
  }catch(e){busy=false;el('diagnose').disabled=false;status('عیب‌یابی آغاز نشد: '+e.message+' فایل کلید را دوباره انتخاب نکن؛ همین‌جا می‌توانی تلاش کنی.');}
  finally{credentials=null;}
};

el('pairRunner').onclick=async()=>{
  el('pairRunner').disabled=true;
  try{
    const r=await api('pair-runner',{});
    el('pairingStatus').textContent=r.status==='RUNNER_CONNECTED'
      ?'رانر V2 از قبل متصل است؛ صفحه را از ربات دوباره باز کن.'
      :'اتصال رمزگذاری‌شده برای ۱۰ دقیقه آماده شد. فرمان نصب یک‌باره V2 باید روی میزبان رانر قدیمی اجرا شود؛ هیچ رمز یا کلید خصوصی از آن خارج نمی‌شود.';
  }catch(e){el('pairingStatus').textContent='اتصال امن رانر برقرار نشد؛ تنظیمات را بررسی کنید.';}
  finally{el('pairRunner').disabled=false;}
};
el('probe').onclick=async()=>{if(busy||!el('form').reportValidity())return;busy=true;if(failedNodeId!==el('nodeId').value.trim()){failedInstallId=null;failedNodeId=null;}probeId=null;probeExpires=0;installedProbe=false;runtimeDownId=null;el('resetInstalled').hidden=true;el('resetNote').hidden=true;el('diagnose').textContent='عیب‌یابی بدون نصب (فقط بررسی)';el('diagnose').hidden=true;el('diagnoseNote').hidden=true;el('probe').disabled=true;el('credentials').hidden=true;el('trust').checked=false;try{const b={};for(const id of ['nodeId','provider','region','ip','username'])b[id]=el(id).value.trim();for(const id of ['userLimit','capacityGb','port'])b[id]=Number(el(id).value);const job=await api('probe',b);lock(true);poll(job.id,'probe');}catch(e){busy=false;el('probe').disabled=false;status('بررسی اتصال آغاز نشد: '+e.message);}};
el('form').onsubmit=async e=>{
  e.preventDefault();
  if(busy||failedInstallId||installedProbe||!probeId||!el('trust').checked){
    status('ابتدا اثر انگشت سرور را تأیید کن. برای نصب قبلی ناموفق، گزینه عیب‌یابی بدون نصب را بزن.');return;
  }
  if(Date.now()>=probeExpires){
    probeId=null;el('install').disabled=true;
    status('مهلت ۱۰ دقیقه‌ای اثر انگشت پایان یافته است. پیش از ارسال کلید، دوباره «بررسی اتصال» را بزن.');return;
  }
  busy=true;el('install').disabled=true;
  let credentials;
  try{
    credentials=el('method').value==='password'
      ?{method:'password',password:el('password').value}
      :{method:'key',key:await el('keyfile').files[0]?.text(),passphrase:el('password').value};
    if(credentials.method==='password'?!credentials.password:!credentials.key)
      throw Error('اطلاعات ورود را وارد کن.');
    const envelope=await encrypt(credentials);
    credentials=null;
    const job=await api('install',{probeId,fingerprint,trust:true,envelope});
    // Clear the local file picker only after the API accepts the job.
    el('password').value='';el('keyfile').value='';
    poll(job.id,'install');
  }catch(e){
    busy=false;el('install').disabled=false;
    status('نصب آغاز نشد: '+e.message+'\nفایل کلید انتخاب‌شده حفظ شده است؛ برای تلاش مجدد نیازی به انتخاب دوباره نیست.');
  }finally{credentials=null;}
};
if(!auth)status('این صفحه را از دکمه افزودن سرور در ربات V2 باز کن.');
else api('session').then(async s=>{
  publicKey=s.publicKey;el('probe').disabled=false;
  try{await restoreJob();}catch(e){status('بازیابی وضعیت قبلی ممکن نشد؛ دوباره تلاش کنید.');}
}).catch(e=>{
  el('runnerPairing').hidden=false;
  status('نشست امن منقضی شده یا ارتباط برقرار نیست؛ صفحه را از ربات دوباره باز کنید.');
});
</script></html>`;

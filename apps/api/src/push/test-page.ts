/** Authenticated, no-store device test. Never embeds cookies, tokens or subscription material. */
export function renderPushTestPage(nonce: string, available: boolean, subscriptionCount: number): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>آزمون اعلان مدار</title>
<style nonce="${nonce}">body{background:#080d19;color:#e8eefc;font:18px system-ui;margin:0;padding:28px}main{max-width:520px;margin:auto}button{background:#3477ff;color:white;border:0;border-radius:18px;padding:18px;font:inherit}button:disabled{opacity:.5}p{line-height:1.8}</style></head><body><main><h1>آزمون اعلان مدار</h1><p>اشتراک ثبت‌شده برای حساب: ${subscriptionCount}</p><p>این آزمون مجوز اعلان درخواست نمی‌کند؛ دستگاه باید قبلاً در تنظیمات مدار فعال شده باشد.</p><button id="send" ${available && subscriptionCount > 0 ? '' : 'disabled'}>ارسال اعلان آزمایشی</button><p id="result" role="status">${available ? 'پس از ارسال، اعلان گوشی را بررسی کنید.' : 'ارسال اعلان در دسترس نیست.'}</p><a href="/settings">بازگشت به تنظیمات</a></main>
<script nonce="${nonce}">
const button=document.getElementById('send');const result=document.getElementById('result');
button.addEventListener('click',async()=>{button.disabled=true;result.textContent='در حال ارسال…';try{
const csrfResponse=await fetch('/api/auth/csrf',{credentials:'include',cache:'no-store'});if(!csrfResponse.ok)throw new Error();const csrf=await csrfResponse.json();if(typeof csrf.csrfToken!=='string')throw new Error();
const response=await fetch('/api/account/push/test',{method:'POST',credentials:'include',cache:'no-store',headers:{'x-csrf-token':csrf.csrfToken,'content-type':'application/json'},body:'{}'});if(!response.ok)throw new Error();const counts=await response.json();
if(!Number.isSafeInteger(counts.delivered)||!Number.isSafeInteger(counts.expiredRemoved)||!Number.isSafeInteger(counts.failed))throw new Error();
result.textContent='پذیرفته‌شده: '+counts.delivered+'، منقضی: '+counts.expiredRemoved+'، ناموفق: '+counts.failed+' — نمایش واقعی اعلان را روی گوشی بررسی کنید.';
}catch{result.textContent='ارسال کامل نشد؛ نشست و تنظیمات اعلان را بررسی کنید.'}finally{button.disabled=false}});
</script></body></html>`;
}

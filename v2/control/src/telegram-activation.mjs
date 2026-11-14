/** Dedicated V2 Telegram webhook bootstrap.
 *
 * Telegram allows one active webhook per token. NEVER move the legacy
 * Madar_vpn_bot token (bot ID 8905373112) away from the V1 worker.
 * A new BotFather-created bot may be activated only if its webhook is unset,
 * or is already this exact V2 URL. No token/secret values are logged.
 */
const LEGACY_BOT_ID=8905373112;
const V2_URL='https://madar-v2-staging.alirezaanari117.workers.dev/telegram/webhook';
const API='https://api.telegram.org/bot';

export async function activateIsolatedBotWebhook(env,send=fetch) {
  if(env.V2_BOT_AUTO_ACTIVATE!=='true' ||
     !env.TELEGRAM_WEBHOOK_SECRET || !env.BOT_TOKEN ||
     !/^[a-zA-Z0-9_-]{32,128}$/.test(env.TELEGRAM_WEBHOOK_SECRET) ||
     !/^\d{5,20}(?:,\d{5,20})*$/.test(env.ADMIN_TELEGRAM_IDS??''))
    return {state:'disabled'};
  const request=async(method,params={})=>{
    const url=API+env.BOT_TOKEN+'/'+method;
    const response=await send(url,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(params),signal:AbortSignal.timeout(8000),
    });
    if(!response.ok)throw Error('telegram_api_failed');
    const body=await response.json();
    if(body?.ok!==true)throw Error('telegram_api_failed');
    return body.result;
  };
  try {
    const me=await request('getMe');
    if(!Number.isSafeInteger(me?.id)||me.id===LEGACY_BOT_ID ||
       me.is_bot!==true)
      return {state:'legacy_or_invalid_bot'};
    const hook=await request('getWebhookInfo');
    if(typeof hook?.url!=='string'||
       (hook.url!==''&&hook.url!==V2_URL))
      return {state:'existing_other_webhook'};
    if(hook.url===V2_URL)return {state:'ready'};
    const installed=await request('setWebhook',{
      url:V2_URL,
      secret_token:env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates:['message','callback_query'],
      drop_pending_updates:false,
      max_connections:8,
    });
    return {state:installed===true?'installed':'failed'};
  }catch{return {state:'unavailable'};}
}

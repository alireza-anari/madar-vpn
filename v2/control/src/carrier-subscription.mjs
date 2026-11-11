/** One revocable, password-grade HTTPS subscription URL for two operator choices.
 * 
 * URL capability tokens are SHA256-only in the application's D1 table.
 * Request paths can still appear in Cloudflare/provider access logs unless
 * logging is disabled or sanitized at the platform level. v2rayNG cannot
 * attach an Authorization header to an ordinary
 * subscription URL, so this intentionally differs from the bearer-only JSON
 * API. Keep URL private, do not put it in a query string, HTML or referrer.
 */
import {activeRoutes,getSubscription,issueActiveToken} from './subscription.mjs';

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const PAIR=['mci','irancell'];
const PROFILE={mci:'مدار | همراه اول',irancell:'مدار | ایرانسل'};

const noStore=(body,status,contentType='text/plain; charset=utf-8',extra={})=>
  new Response(body,{status,headers:{
    'content-type':contentType,
    'cache-control':'private, no-store, max-age=0',
    'pragma':'no-cache',
    'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff',
    'x-robots-tag':'noindex, nofollow',
    ...extra,
  }});

export function carrierPair(routes) {
  if(!Array.isArray(routes))return null;
  const selected=[];
  for(const operator of PAIR) {
    const choices=routes.filter(r=>r?.transport==='reality'&&r.operator_hint===operator);
    if(choices.length!==1) return null;
    selected.push(choices[0]);
  }
  if(selected[0].id===selected[1].id) return null;
  // Two paths really must be distinct; never display duplicate links as
  // operator-specific paths and never turn WSS into an unverified substitute.
  const address=route=>({
    host:route.endpoint?.host??route.host,
    port:route.endpoint?.port??route.port,
  });
  const first=address(selected[0]), second=address(selected[1]);
  if(first.host===second.host && first.port===second.port)
    return null;
  return selected;
}

export function vlessLink(route,uuid) {
  const opts=new URLSearchParams({
    encryption:'none',
    security:'reality',
    type:'tcp',
    flow:'xtls-rprx-vision',
    sni:route.tls.server_name,
    fp:'chrome',
    pbk:route.tls.reality_public_key,
    sid:route.tls.short_id,
  });
  const hostname=route.endpoint.host;
  const address=hostname.includes(':')&&!hostname.startsWith('[')?'['+hostname+']':hostname;
  const label=PROFILE[route.operator_hint];
  if(!label)throw new TypeError('unknown_carrier');
  return 'vless://'+uuid+'@'+address+':'+route.endpoint.port+'?'+
    opts.toString()+'#'+encodeURIComponent(label);
}

export function base64Feed(snapshot) {
  const routes=carrierPair(snapshot.routes);
  if(!routes)return null;
  const source=routes.map(r=>vlessLink(r,snapshot.client.uuid)).join('\n')+'\n';
  const bytes=new TextEncoder().encode(source);
  return btoa(String.fromCharCode(...bytes));
}

/** Get base64 VLESS subscription feed; no cookies, redirects or HTML. */
export async function getCarrierFeed(request,env,nowMs=Date.now()) {
  if(request.method!=='GET')return noStore('Not found',404);
  const url=new URL(request.url);
  const token=url.pathname.startsWith('/s/')?url.pathname.slice(3):'';
  if(url.search || url.hash || !TOKEN.test(token))return noStore('Not found',404);
  if(env.SUBSCRIPTION_LINKS_ENABLED!=='true'||env.SUBSCRIPTION_API_ENABLED!=='true')
    return noStore('Not ready',503);
  const internal=new Request(url.origin+'/api/v2/subscription',{
    headers:{authorization:'Bearer '+token},
  });
  const response=await getSubscription(internal,env,nowMs);
  if(response.status!==200)
    return noStore(response.status===401||response.status===403?'Unavailable':'Not ready',
      response.status===401||response.status===403?403:503);
  const snapshot=await response.json();
  const body=base64Feed(snapshot);
  if(body===null)return noStore('Operator routes not ready',503);
  const info='upload=0; download='+snapshot.used_bytes+
    '; total='+snapshot.quota_bytes+'; expire='+Math.floor(snapshot.expires_at/1000);
  return noStore(body,200,'text/plain; charset=utf-8',{
    'subscription-userinfo':info,
    'profile-update-interval':'12',
    'content-disposition':'attachment; filename="Madar.txt"',
  });
}

function trustedOrigin(value) {
  if(typeof value!=='string')return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||
       url.search||url.hash||url.pathname!=='/'||url.port)
      return null;
    return url.origin;
  }catch{return null;}
}

/** Called only after Telegram ownership verification by the shop module.
 * Requires two independently field-verified, published REALITY routes and a
 * fully active quota-bearing subscription. Never issues placeholder links.
 */
export async function issueCarrierLink(env,subscriptionId,nowMs=Date.now()) {
  if(env.SUBSCRIPTION_LINKS_ENABLED!=='true' ||
     env.SUBSCRIPTION_API_ENABLED!=='true' || !env.DB)return null;
  const origin=trustedOrigin(env.SUBSCRIPTION_PUBLIC_ORIGIN);
  if(!origin)return null;
  const routes=await activeRoutes(env.DB,subscriptionId,nowMs);
  if(!carrierPair(routes.map(r=>({
    id:r.route_id,transport:r.transport,operator_hint:r.operator_hint,
    host:r.host,port:r.port,
  }))))return null;
  const issued=await issueActiveToken(env,subscriptionId,nowMs);
  return issued?{url:origin+'/s/'+issued.token,expires_at:issued.expires_at}:null;
}

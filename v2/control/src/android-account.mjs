import {tokenDigest} from './subscription.mjs';

const randomToken=()=>{
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};

/** Authenticated Telegram identity, independent of paid VPN entitlement.
 * A valid app session alone does not authorize a proxy configuration. */
export async function issueAppSession(env,telegramId,now=Date.now()){
  if(!env.DB||!/^\d{5,20}$/.test(telegramId??''))return null;
  const owner=await env.DB.prepare(
    "SELECT c.telegram_id FROM customers c JOIN telegram_bot_activations a " +
    "ON a.telegram_id=c.telegram_id WHERE c.telegram_id=? AND c.state='active' LIMIT 1"
  ).bind(telegramId).first();
  if(!owner)return null;
  const token=randomToken(),hash=await tokenDigest(token);
  const expiresAt=now+30*24*60*60*1000;
  await env.DB.prepare(
    'INSERT INTO android_app_sessions(token_hash,telegram_id,created_ms,expires_ms) VALUES(?,?,?,?)'
  ).bind(hash,telegramId,now,expiresAt).run();
  return {token,expires_at:expiresAt};
}

/** Return only the verified Telegram ID. No bearer token is persisted in plaintext. */
export async function findAppSession(db,digest,now=Date.now()){
  if(!db||!digest)return null;
  const row=await db.prepare(
    'SELECT a.telegram_id FROM android_app_sessions a JOIN customers c ' +
    "ON c.telegram_id=a.telegram_id AND c.state='active' " +
    'JOIN telegram_bot_activations b ON b.telegram_id=c.telegram_id ' +
    'WHERE a.token_hash=? AND a.revoked=0 AND a.expires_ms>? LIMIT 1'
  ).bind(digest,now).first();
  return row?.telegram_id??null;
}

export async function revokeAppSession(db,digest){
  await db.prepare(
    'UPDATE android_app_sessions SET revoked=1 WHERE token_hash=?'
  ).bind(digest).run();
}

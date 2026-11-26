import test from 'node:test';
import assert from 'node:assert/strict';
import {issueAppSession,findAppSession,revokeAppSession} from '../src/android-account.mjs';

function fixture(){
  const sessions=new Map();
  const env={DB:{prepare(sql){return {bind(...args){return {
    first:async()=>{
      if(sql.startsWith('SELECT c.telegram_id'))
        return args[0]==='1234567'?{telegram_id:args[0]}:null;
      if(sql.startsWith('SELECT a.telegram_id')){
        const row=sessions.get(args[0]);
        return row&&!row.revoked&&row.expires_ms>args[1]?{telegram_id:row.telegram_id}:null;
      }
      return null;
    },
    run:async()=>{
      if(sql.startsWith('INSERT INTO android_app_sessions'))
        sessions.set(args[0],{telegram_id:args[1],created_ms:args[2],expires_ms:args[3],revoked:0});
      if(sql.startsWith('UPDATE android_app_sessions')){
        const row=sessions.get(args[0]);if(row)row.revoked=1;
      }
      return {meta:{changes:1}};
    },
  };}};}}};
  return {env,sessions};
}

test('activated Telegram identity can sign in without owning a VPN subscription',async()=>{
  const {env,sessions}=fixture(),now=1_900_000_000_000;
  const issued=await issueAppSession(env,'1234567',now);
  assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expires_at,now+30*24*60*60*1000);
  assert.equal(sessions.size,1);
  const digest=[...sessions.keys()][0];
  assert.match(digest,/^[0-9a-f]{64}$/);
  assert.notEqual(digest,issued.token);
  assert.equal(await findAppSession(env.DB,digest,now+1000),'1234567');
  assert.equal(await findAppSession(env.DB,digest,issued.expires_at),null);
  await revokeAppSession(env.DB,digest);
  assert.equal(await findAppSession(env.DB,digest,now+1000),null);
});

test('unknown or unactivated Telegram identity cannot issue a session',async()=>{
  const {env,sessions}=fixture();
  assert.equal(await issueAppSession(env,'9999999',1_900_000_000_000),null);
  assert.equal(await issueAppSession(env,'not-a-user',1_900_000_000_000),null);
  assert.equal(sessions.size,0);
});

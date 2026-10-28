import { env } from "cloudflare:workers";
import { beforeEach,expect,test } from "vitest";
import { resetDb } from "./db";
import { handleUpdate } from "../src/menus";
import { recordUpdate } from "../src/telegram";
import worker from "../src/index";
import { sealTelegramEnrollmentSecret } from "../src/telegram-enrollment";
import m1 from "../migrations/0001.sql?raw";
import m2 from "../migrations/0002.sql?raw";
import m3 from "../migrations/0003.sql?raw";
import m4 from "../migrations/0004-reseller-accounts.sql?raw";
import m5 from "../migrations/0005-shared-node-purposes.sql?raw";
import m6 from "../migrations/0006-trial-quota.sql?raw";
import m7 from "../migrations/0007-node-capacity.sql?raw";
import m8 from "../migrations/0008-reseller-invites.sql?raw";
import m9 from "../migrations/0009-node-allocation-cap.sql?raw";
import m10 from "../migrations/0010-capacity-accounting-resellers.sql?raw";
import m11 from "../migrations/0011-node-account-slot-mode.sql?raw";

let E:Env, privateKey:CryptoKey;
const now=100;
const call=async(update_id:number,id:number,data:string)=>{
  const u={update_id,callback_query:{id:"c"+update_id,from:{id},message:{message_id:update_id,chat:{id,type:"private" as const},text:"پنل مدیریت"},data}};
  await handleUpdate(E,u,now);
  return JSON.parse(await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?").bind("u"+update_id+":reply").first<string>("payload")||"{}");
};
const say=async(update_id:number,id:number,text:string)=>{
  const u={update_id,message:{message_id:update_id,chat:{id,type:"private" as const},from:{id},text}};
  await handleUpdate(E,u,now);
  return JSON.parse(await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id=?").bind("u"+update_id+":reply").first<string>("payload")||"{}");
};

beforeEach(async()=>{
  await resetDb();
  for(const sql of [m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11])await env.SALES_DB.exec(sql);
  await env.SALES_DB.exec("INSERT INTO settings(key,value) VALUES('app_mode','reseller'); INSERT INTO resellers(telegram_id,enabled,created_at) VALUES('10',1,50);");
  const pair=await crypto.subtle.generateKey({name:"RSA-OAEP",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["encrypt","decrypt"]);
  privateKey=pair.privateKey;
  E={...env,ADMIN_TELEGRAM_IDS:"9",RUNNER_PUBLIC_KEY:JSON.stringify(await crypto.subtle.exportKey("jwk",pair.publicKey))};
});

test("only admins can open the native enrollment wizard; invalid targets and caps are rejected",async()=>{
  expect((await call(9100,10,"enroll:start")).text).toContain("فقط برای مدیر");
  expect((await call(9101,9,"enroll:start")).text).toContain("افزودن سرور");
  expect((await say(9102,9,"Test VPS")).text).toContain("IP عمومی");
  expect((await say(9103,9,"10.0.0.7")).text).toContain("IP عمومی معتبر");
  expect((await say(9104,9,"51.21.199.245")).text).toContain("پورت SSH");
  expect((await say(9105,9,"22")).text).toContain("سقف کانفیگ");
  expect((await say(9106,9,"0")).text).toContain("سقف کانفیگ");
  expect((await say(9107,9,"20")).text).toContain("سقف مجموع حجم");
  expect((await say(9108,9,"1000")).text).toContain("بررسی SSH شروع شد");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) AS n FROM installation_jobs WHERE kind='probe'").first<number>("n")).toBe(1);
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) AS n FROM nodes").first<number>("n")).toBe(0);
});

test("fingerprint consent and encrypted transient credentials create an install job, never raw SSH password",async()=>{
  await call(9200,9,"enroll:start");
  await say(9201,9,"Stockholm Test");
  await say(9202,9,"51.21.199.245");
  await say(9203,9,"22");
  await say(9204,9,"17");
  await say(9205,9,"500");
  const probeId=await env.SALES_DB.prepare("SELECT id FROM installation_jobs WHERE kind='probe'").first<string>("id");
  expect((await call(9206,9,"enroll:trust")).text).toContain("قابل اجرا نیست");
  const fp="SHA256:"+"a".repeat(43);
  await env.SALES_DB.prepare("UPDATE installation_jobs SET state='ready',fingerprint=? WHERE id=?").bind(fp,probeId).run();
  const screen=await call(9207,9,"enroll:probe");
  expect(screen.text).toContain(fp);
  expect((await call(9208,9,"enroll:trust")).text).toContain("نام کاربر");
  await say(9209,9,"ubuntu");
  const select=await call(9210,9,"enroll:method:password");
  expect(select.text).toContain("رمز موقت SSH");
  const secret="a-secret-password-to-be-encrypted-9211";
  const u={update_id:9211,message:{message_id:9211,chat:{id:9,type:"private" as const},from:{id:9},text:secret}};
  expect(await sealTelegramEnrollmentSecret(E,u)).toBe(true);
  expect(u.message.text).not.toContain(secret);
  await recordUpdate(env.SALES_DB,u);
  const persisted=await env.SALES_DB.prepare("SELECT payload FROM telegram_updates WHERE id=9211").first<string>("payload");
  expect(persisted).not.toContain(secret);
  expect(persisted).toContain("enroll-sealed:");
  await handleUpdate(E,u,now);
  const job=await env.SALES_DB.prepare("SELECT * FROM installation_jobs WHERE kind='install'").first<any>();
  expect(job).toMatchObject({username:"ubuntu",target_ip:"51.21.199.245",port:22,state:"queued",user_id:"9"});
  expect(job.encrypted_credentials).not.toContain(secret);
  const envelope=JSON.parse(job.encrypted_credentials);
  const from64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const rawAes=await crypto.subtle.decrypt("RSA-OAEP",privateKey,from64(envelope.key));
  const aes=await crypto.subtle.importKey("raw",rawAes,{name:"AES-GCM"},false,["decrypt"]);
  const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:from64(envelope.iv)},aes,from64(envelope.data));
  expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual({method:"password",password:secret});
  const n=await env.SALES_DB.prepare("SELECT name,max_accounts,max_allocated_bytes FROM nodes WHERE id=?").bind(job.node_id).first<any>();
  expect(n).toMatchObject({name:"Stockholm Test",max_accounts:17,max_allocated_bytes:500e9});
  expect((await call(9212,9,"enroll:status")).text).toContain("در صف");
  await env.SALES_DB.prepare("UPDATE installation_jobs SET state='ready' WHERE id=?").bind(job.id).run();
  await env.SALES_DB.prepare("UPDATE nodes SET healthy=1,last_seen=100,revision=1,acked_revision=1 WHERE id=?").bind(job.node_id).run();
  const done=await call(9213,9,"enroll:status");
  expect(done.text).toContain("سرور به مدار اضافه");
  expect(done.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data==="rs:nodedetail:"+job.node_id)).toBe(true);
});

test("secure webhook sealing rejects invalid secrets without storing input and preserves cancellation",async()=>{
  await call(9300,9,"enroll:start");
  await say(9301,9,"Server");
  await say(9302,9,"51.21.199.245");
  await say(9303,9,"22");
  await say(9304,9,"5");
  await say(9305,9,"100");
  const probe=await env.SALES_DB.prepare("SELECT id FROM installation_jobs WHERE kind='probe'").first<string>("id");
  await env.SALES_DB.prepare("UPDATE installation_jobs SET state='ready',fingerprint=? WHERE id=?").bind("SHA256:"+"b".repeat(43),probe).run();
  await call(9306,9,"enroll:probe");
  await call(9307,9,"enroll:trust");
  await say(9308,9,"ubuntu");
  await call(9309,9,"enroll:method:password");
  const update={update_id:9310,message:{message_id:9310,chat:{id:9,type:"private" as const},from:{id:9},text:"bad\nmultiline\npassword"}};
  expect(await sealTelegramEnrollmentSecret(E,update)).toBe(true);
  expect(update.message.text).toBe("enroll-sealed:INVALID");
  await recordUpdate(env.SALES_DB,update);
  expect((await env.SALES_DB.prepare("SELECT payload FROM telegram_updates WHERE id=9310").first<string>("payload"))).not.toContain("multiline");
  expect((await call(9311,10,"enroll:status")).text).toContain("فقط برای مدیر");
  await call(9312,9,"enroll:cancel");
  const state=await env.SALES_DB.prepare("SELECT conversation FROM users WHERE id='9'").first<string>("conversation");
  expect(state).toBe("");
  expect(await env.SALES_DB.prepare("SELECT COUNT(*) AS n FROM nodes").first<number>("n")).toBe(0);
});

test("real webhook automatically seals incoming SSH secret and queues Telegram message deletion",async()=>{
  await env.SALES_DB.prepare("INSERT INTO users(id,conversation) VALUES('9',?)").bind('enroll:'+JSON.stringify({step:"secret",method:"password"})).run();
  const secret="SENSITIVE_TG_SSH_PASSWORD_12345";
  const update={update_id:9500,message:{message_id:9500,chat:{id:9,type:"private"},from:{id:9},text:secret}};
  const response=await worker.fetch(new Request("https://example.test/webhook",{
    method:"POST",
    headers:{"X-Telegram-Bot-Api-Secret-Token":"test-secret-native-enrollment","Content-Type":"application/json"},
    body:JSON.stringify(update),
  }),{...E,TELEGRAM_WEBHOOK_SECRET:"test-secret-native-enrollment"});
  expect(response.status).toBe(200);
  const stored=await env.SALES_DB.prepare("SELECT payload FROM telegram_updates WHERE id=9500").first<string>("payload");
  expect(stored).toContain("enroll-sealed:");
  expect(stored).not.toContain(secret);
  const deletion=JSON.parse(await env.SALES_DB.prepare("SELECT payload FROM outbox WHERE id='u9500:delete'").first<string>("payload")||"{}");
  expect(deletion).toMatchObject({_method:"deleteMessage",message_id:9500});
  expect(await env.SALES_DB.prepare("SELECT chat_id FROM outbox WHERE id='u9500:delete'").first<string>("chat_id")).toBe("9");
});

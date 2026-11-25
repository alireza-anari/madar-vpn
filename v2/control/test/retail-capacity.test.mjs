import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {availableForSale,resolveBotAction} from '../src/shop.mjs';

const NOW=1800000000000;
const GB=1073741824;
function fixture(beforeOrder=()=>{}) {
  const raw=new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())
    raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const id='ready-node01',route=id+'_reality';
  raw.prepare('INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,'AWS','eu','ready',3,5*GB,1,1);
  raw.prepare('INSERT INTO routes(id,node_id,transport,state,verified_ms) VALUES(?,?,?,?,?)')
    .run(route,id,'reality','ready',NOW-1000);
  for(const [operator,port] of [['mci',443],['irancell',8443]])
    raw.prepare('INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(route,operator,'198.51.100.10',port,'www.cloudflare.com','A'.repeat(43),'abcd',1,NOW-1000);
  raw.prepare("INSERT INTO node_acks(node_id,revision,digest,status,observed_ms) VALUES(?,1,?,'accepted',?)")
    .run(id,'a'.repeat(64),NOW-1000);
  raw.prepare("INSERT INTO node_health(node_id,revision,observed_ms,xray_healthy,stats_healthy) VALUES(?,1,?,1,1)")
    .run(id,NOW-1000);
  const DB={prepare(sql){
    return {bind(...args){return {
      run:async()=>{
        if(sql.startsWith('INSERT INTO orders'))beforeOrder(raw);
        return {meta:{changes:raw.prepare(sql).run(...args).changes}};
      },
      first:async()=>raw.prepare(sql).get(...args)??null,
      all:async()=>({results:raw.prepare(sql).all(...args)}),
    };}};
  }};
  const check=()=>availableForSale(DB,{quota_bytes:GB},NOW);
  return {DB,raw,id,route,check};
}
test('retail offers capacity only after two current carrier routes, signed ACK and stats health',async()=>{
  const {raw,check}=fixture();
  try{assert.equal(await check(),true);}
  finally{raw.close();}
});
test('missing IranCell publication fails closed despite ready node and 443 listener',async()=>{
  const {raw,route,check}=fixture();
  try{
    raw.prepare("UPDATE route_carrier_variants SET published=0 WHERE route_id=? AND operator='irancell'").run(route);
    assert.equal(await check(),false);
  }finally{raw.close();}
});
test('stale signed health fails closed even when routes are published',async()=>{
  const {raw,id,check}=fixture();
  try{
    raw.prepare('UPDATE node_health SET observed_ms=? WHERE node_id=?').run(NOW-600001,id);
    assert.equal(await check(),false);
  }finally{raw.close();}
});
test('negative stats health fails closed',async()=>{
  const {raw,id,check}=fixture();
  try{
    raw.prepare('UPDATE node_health SET stats_healthy=0 WHERE node_id=?').run(id);
    assert.equal(await check(),false);
  }finally{raw.close();}
});
test('outdated signed node acceptance fails closed',async()=>{
  const {raw,id,check}=fixture();
  try{
    raw.prepare('UPDATE node_acks SET observed_ms=? WHERE node_id=?').run(NOW-600001,id);
    assert.equal(await check(),false);
  }finally{raw.close();}
});
test('node revision mismatch and quarantine fail closed',async()=>{
  const {raw,id,check}=fixture();
  try{
    raw.prepare('UPDATE nodes SET desired_revision=2 WHERE id=?').run(id);
    assert.equal(await check(),false);
    raw.prepare("UPDATE nodes SET desired_revision=1,lifecycle='quarantined' WHERE id=?").run(id);
    assert.equal(await check(),false);
  }finally{raw.close();}
});
test('capacity never oversells allocated bytes and user slots',async()=>{
  const {raw,id,check}=fixture();
  try{
    assert.equal(await availableForSale({prepare(sql) {
      return {bind(...args){return {first:async()=>raw.prepare(sql).get(...args)??null};}};
    }},{quota_bytes:6*GB},NOW),false);
    raw.prepare("UPDATE nodes SET user_limit=0 WHERE id=?").run(id);
    assert.equal(await check(),false);
  }finally{raw.close();}
});

for(const [scenario,change,expected] of [
  ['available',()=>{},1],
  ['withdrawn plan',raw=>raw.exec('UPDATE plans SET active=0'),0],
  ['changed price',raw=>raw.exec('UPDATE plans SET price_amount=150'),0],
  ['lost capacity',raw=>raw.exec('UPDATE nodes SET user_limit=0'),0],
]){
  test('checkout at insertion with '+scenario,async()=>{
    const {DB,raw}=fixture(change);
    try{
      raw.prepare("INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days,active) VALUES('monthly','ماهانه','Monthly',100,'IRT',?,30,1)").run(GB);
      const payment='Payment destination for fixture only';
      const env={DB,ADMIN_TELEGRAM_IDS:'100',SHOP_ENABLED:'true',PROVISIONING_ENABLED:'true',
        SUBSCRIPTION_LINKS_ENABLED:'true',SUBSCRIPTION_API_ENABLED:'true',PAYMENT_INSTRUCTIONS:payment};
      const reply=await resolveBotAction(env,{actorId:'100',key:'buy:monthly',updateId:123},NOW);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n,expected);
      assert.equal(reply.text.includes(payment),expected===1);
    }finally{raw.close();}
  });
}

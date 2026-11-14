import test from 'node:test';
import assert from 'node:assert/strict';
import {carrierPair,base64Feed,vlessLink,issueCarrierLink,getCarrierFeed}
  from '../src/carrier-subscription.mjs';
import {wrapClientUuid,tokenDigest} from '../src/subscription.mjs';

const uuid='123e4567-e89b-42d3-a456-426614174000';
const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/=+$/,'');
const port=(operator_hint,port)=>({
  id:'node_'+operator_hint,operator_hint,protocol:'vless',transport:'reality',
  endpoint:{host:'86.54.42.66',port},
  tls:{server_name:'www.cloudflare.com',reality_public_key:'A'.repeat(43),short_id:'abcd1234'},
});
const plain=(r)=>({
  route_id:r.id,operator_hint:r.operator_hint,transport:r.transport,
  host:r.endpoint.host,port:r.endpoint.port,server_name:r.tls.server_name,
  reality_public_key:r.tls.reality_public_key,reality_short_id:r.tls.short_id,
});
const routes=[port('mci',443),port('irancell',8443)];
const now=1800000000000;

test('one feed decodes to exactly two distinct, named VLESS REALITY choices',()=>{
  const serialized=base64Feed({client:{uuid},routes:routes.slice().reverse()});
  const links=atob(serialized).trim().split('\n');
  assert.equal(links.length,2);
  assert.match(decodeURIComponent(links[0].split('#')[1]),/همراه اول/);
  assert.match(decodeURIComponent(links[1].split('#')[1]),/ایرانسل/);
  assert.match(links[0],/@86\.54\.42\.66:443\?/);
  assert.match(links[1],/@86\.54\.42\.66:8443\?/);
  for(const line of links) {
    assert.ok(line.startsWith('vless://'+uuid+'@'));
    assert.match(line,/security=reality/);
    assert.match(line,/flow=xtls-rprx-vision/);
    assert.match(line,/pbk=A{43}/);
  }
});

test('no single-port duplicates, WSS substitutions or partial carrier feeds',()=>{
  assert.equal(carrierPair([routes[0]]),null);
  assert.equal(carrierPair([routes[0],routes[0],routes[1]]),null);
  assert.equal(carrierPair([routes[0],{...routes[1],endpoint:{...routes[1].endpoint,port:443}}]),null);
  assert.equal(carrierPair([routes[0],{...routes[1],transport:'wss'}]),null);
  assert.equal(base64Feed({client:{uuid},routes:[routes[0]]}),null);
});

test('token feed is gated, without URL queries or redirects',async()=>{
  const raw='B'.repeat(43);
  const req=new Request('https://sub.madar.test/s/'+raw);
  assert.equal((await getCarrierFeed(req,{})).status,503);
  assert.equal((await getCarrierFeed(new Request(req.url+'?key=exposed'),{})).status,404);
  assert.equal((await getCarrierFeed(new Request('https://sub.madar.test/s/bad'),{})).status,404);
  assert.equal((await getCarrierFeed(new Request(req.url,{method:'POST'}),{})).status,404);
});

test('inactive/bad origin cannot issue a URL',async()=>{
  assert.equal(await issueCarrierLink({},'sub'),null);
  assert.equal(await issueCarrierLink({SUBSCRIPTION_LINKS_ENABLED:'true',
    SUBSCRIPTION_API_ENABLED:'true',SUBSCRIPTION_PUBLIC_ORIGIN:'http://unsafe.test',DB:{}},'sub'),null);
  assert.equal(await issueCarrierLink({SUBSCRIPTION_LINKS_ENABLED:'true',
    SUBSCRIPTION_API_ENABLED:'true',SUBSCRIPTION_PUBLIC_ORIGIN:'https://x.test/path',DB:{}},'sub'),null);
});

test('a single issued link is hash-stored, authorized and returns only two profiles',async()=>{
  const secret=await wrapClientUuid(uuid,key);
  let issuedHash=null;
  const db={
    prepare(sql) {
      return {bind(...args) {
        return {
          first:async()=>{
            if(sql.includes('FROM subscriptions s ')&&sql.includes('EXISTS('))
              return {id:'sub-1',expires_at:now+3600000};
            if(sql.includes('FROM subscription_tokens t'))
              return issuedHash===args[0]?{
                id:'sub-1',state:'active',max_bytes:1000000000,used_bytes:50000,
                expires_at:now+3600000,
              }:null;
            if(sql.includes('FROM subscription_credentials'))
              return secret;
            return null;
          },
          all:async()=>sql.includes('FROM node_allocations a ')
            ?{results:routes.map(plain)}:{results:[]},
          run:async()=>{
            if(sql.startsWith('INSERT INTO subscription_tokens'))issuedHash=args[0];
            return {meta:{changes:1}};
          },
        };
      }};
    },
  };
  const env={
    DB:db,SUBSCRIPTION_API_ENABLED:'true',SUBSCRIPTION_LINKS_ENABLED:'true',
    SUBSCRIPTION_PUBLIC_ORIGIN:'https://sub.madar.test',
    SUBSCRIPTION_CREDENTIAL_KEY:key,
  };
  const issued=await issueCarrierLink(env,'sub-1',now);
  assert.ok(issued);
  assert.match(issued.url,/^https:\/\/sub\.madar\.test\/s\/[A-Za-z0-9_-]{43}$/);
  assert.equal(issuedHash,await tokenDigest(issued.url.split('/').pop()));
  assert.ok(!issuedHash.includes(issued.url.split('/').pop()));
  const req=new Request(issued.url);
  const response=await getCarrierFeed(req,env,now);
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.match(response.headers.get('subscription-userinfo'),/total=1000000000/);
  const decoded=atob(await response.text()).trim().split('\n');
  assert.equal(decoded.length,2);
  assert.match(decoded[0],/443/);
  assert.match(decoded[1],/8443/);
});

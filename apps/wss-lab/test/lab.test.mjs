import test from "node:test";
import assert from "node:assert/strict";
import handler from "../src/index.mjs";

const origin = "https://madar-wss-lab.example.workers.dev";
const path = "/madar-2df6f8c9ae154b2381da7590";
const req = (suffix, headers={}) => new Request(origin+suffix,{headers});
const env = { RELAY_PATH:path };

test("Cloudflare edge health is truthful without an upstream",async()=>{
  const response=await handler.fetch(req("/healthz"),env);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.edge,"available");
  assert.equal(body.tunnelConfigured,false);
  assert.equal(body.vpnReady,false);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
});

test("WS origin is disabled, no guessed VMess config is ever usable",async()=>{
  const response=await handler.fetch(
    req(path,{Upgrade:"websocket"}),env);
  assert.equal(response.status,503);
});

test("no open proxy: arbitrary paths, arbitrary methods and origin spoofing refused",async()=>{
  const wrong=["/anything","/","/madar-"+"a".repeat(24),"/malicious"];
  for (const suffix of wrong) {
    const response=await handler.fetch(req(suffix,{Upgrade:"websocket"}),env);
    assert.equal(response.status,404,suffix);
  }
  assert.equal((await handler.fetch(
    new Request(origin+path,{method:"POST",headers:{Upgrade:"websocket"}}),env
  )).status,404);
  assert.equal((await handler.fetch(req(path),env)).status,426);
  for (const host of [
    "127.0.0.1","example.com","a.trycloudflare.com.evil.net",
    "a.trycloudflare.com:443","a.trycloudflare.com/other",
    "trycloudflare.com","A.TRYCLOUDFLARE.COM",
  ]) {
    const r=await handler.fetch(req("/healthz"),{...env,UPSTREAM_HOST:host});
    assert.equal((await r.json()).tunnelConfigured,false,host);
  }
});

test("Only a fully qualified approved Quick Tunnel host enables proxy readiness hint",async()=>{
  const r=await handler.fetch(req("/healthz"),{
    ...env,UPSTREAM_HOST:"probe-bridge.trycloudflare.com",
  });
  const j=await r.json();
  assert.equal(j.tunnelConfigured,true);
  assert.equal(j.vpnReady,false);
});

test("Probe requires an actual WebSocket upgrade",async()=>{
  const r=await handler.fetch(req("/__probe"),env);
  assert.equal(r.status,426);
});

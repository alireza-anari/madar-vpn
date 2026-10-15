import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../public/enroll.html',import.meta.url),'utf8');
const source=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function page({sdk,hash='' }={}){
 const elements=new Map();const requests=[];
 const context={window:{...(sdk?{Telegram:{WebApp:{initData:sdk,ready(){}}}}:{})},location:{hash},URLSearchParams,document:{getElementById(id){if(!elements.has(id))elements.set(id,{hidden:false,value:'',textContent:''});return elements.get(id);}},fetch:async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>({})};},setInterval,clearInterval};
 runInNewContext(source,context);return {context,elements,requests};
}
test('signed launch data is sent unmodified when Telegram SDK is unavailable',async()=>{
 const raw='auth_date=100&user=%7B%22id%22%3A9%7D&hash=signature%2Bvalue';
 const p=page({hash:'#tgWebAppData='+encodeURIComponent(raw)+'&tgWebAppVersion=8.0'});
 assert.equal(p.elements.get('form')?.hidden??false,false);
 await p.context.api('session');
 assert.equal(p.requests[0].options.headers['X-Telegram-Init-Data'],raw);
});
test('SDK data remains preferred over the fragment',async()=>{const p=page({sdk:'sdk-data',hash:'#tgWebAppData=fragment-data'});await p.context.api('session');assert.equal(p.requests[0].options.headers['X-Telegram-Init-Data'],'sdk-data');});
test('ordinary browser without Telegram data keeps credentials form hidden',()=>{const p=page();assert.equal(p.elements.get('form').hidden,true);});

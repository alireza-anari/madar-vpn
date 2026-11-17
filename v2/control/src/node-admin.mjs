/** مدیریت فارسی سرورها و مسیرهای پیش‌نویس در محیط V2. */
import {sectionNavigation,frameMessage,faStatus,faNumber,statusSymbol,panelHeading} from './bot-ux.mjs';

const NODE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const PROVIDER=/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const REGION=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const HOST=/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,252}$/;
const NAT=/^(0|[1-9]\d*)$/;
const MAX_GB=200000;
const gbToBytes=n=>n*1073741824;

function panel(message) {
  return {text:frameMessage(message),replyMarkup:{inline_keyboard:sectionNavigation('admin')}};
}

export function parseNodeAdd(input) {
  if(typeof input!=='string')return null;
  const parts=input.replace(/^\/node_add(?:@\w+)?\s*/,'').trim().split('|').map(x=>x.trim());
  if(parts.length!==5)return null;
  const [id,provider,region,usersRaw,gbRaw]=parts;
  if(!NODE_ID.test(id)||!PROVIDER.test(provider)||!REGION.test(region)||
     !NAT.test(usersRaw)||!NAT.test(gbRaw))return null;
  const users=Number(usersRaw),gb=Number(gbRaw);
  if(!Number.isSafeInteger(users)||users<1||users>100000||
     !Number.isSafeInteger(gb)||gb<1||gb>MAX_GB)return null;
  return {id,provider,region,userLimit:users,byteLimit:gbToBytes(gb)};
}

export function parseRouteAdd(input) {
  if(typeof input!=='string')return null;
  const parts=input.replace(/^\/node_route(?:@\w+)?\s*/,'').trim().split('|').map(x=>x.trim());
  const [nodeId,transport,portRaw,hostname,path]=parts;
  if(!NODE_ID.test(nodeId??'')||!['reality','wss'].includes(transport)||
     !NAT.test(portRaw??''))return null;
  const port=Number(portRaw);
  if(!Number.isSafeInteger(port)||port<1||port>65535)return null;
  if(transport==='reality'&&parts.length===3)
    return {nodeId,transport,port,hostname:null,path:null,id:nodeId+'_reality',operatorHint:null};
  if(transport==='reality'&&parts.length===4&&['mci','irancell'].includes(hostname))
    return {nodeId,transport,port,hostname:null,path:null,id:nodeId+'_reality_'+hostname,operatorHint:hostname};
  if(transport==='wss'&&parts.length===5&&HOST.test(hostname??'')&&
     typeof path==='string'&&path.startsWith('/')&&path.length<=256&&!/[\r\n?&#]/.test(path))
    return {nodeId,transport,port,hostname,path,id:nodeId+'_wss',operatorHint:null};
  return null;
}

export async function enrollNode(db,actor,input) {
  const data=parseNodeAdd(input);
  if(!data)return panel('قالب ثبت دستی سرور:\n/node_add شناسه|ارائه‌دهنده|منطقه|سقف کاربر|ظرفیت گیگابایت');
  const {id,provider,region,userLimit,byteLimit}=data;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) "+
        "VALUES(?,?,?,'enrolling',?,?,1,0)"
      ).bind(id,provider,region,userLimit,byteLimit),
      db.prepare(
        "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
      ).bind('node:add:'+id,actor,'node',id,'enroll'),
    ]);
    return panel('✅ سرور '+id+' ثبت شد، اما هنوز آماده استفاده نیست.\nبرای تعریف مسیر از دستور /node_route استفاده کنید. نصب عامل امن و آزمون واقعی اتصال نیز لازم است.');
  } catch {
    return panel('⚠️ سرور از قبل ثبت شده یا اطلاعات آن معتبر نیست؛ هیچ تغییری انجام نشد.');
  }
}

export async function addRoute(db,actor,input) {
  const data=parseRouteAdd(input);
  if(!data)return panel(
    'قالب تعریف مسیر:\n'+
    '/node_route شناسه_سرور|reality|443|mci\n'+
    '/node_route شناسه_سرور|reality|8443|irancell\n'+
    '/node_route شناسه_سرور|wss|8443|دامنه|/ws');
  const node=await db.prepare(
    "SELECT id,lifecycle,desired_revision FROM nodes WHERE id=?"
  ).bind(data.nodeId).first();
  if(!node||!['enrolling','provisioning','degraded'].includes(node.lifecycle))
    return panel('سرور پیدا نشد یا ممکن است اشتراک فعال داشته باشد؛ مسیر تغییری نکرد.');
  if(node.desired_revision>=2147483647)return panel('حد مجاز نسخه تنظیمات سرور به پایان رسیده است.');
  if(data.operatorHint) {
    const parent=await db.prepare(
      "SELECT r.id,re.host,re.server_name,re.reality_public_key,re.reality_short_id "+
      "FROM routes r JOIN route_endpoints re ON re.route_id=r.id "+
      "WHERE r.node_id=? AND r.transport='reality' LIMIT 1"
    ).bind(data.nodeId).first();
    if(!parent||!HOST.test(parent.host??'')||!HOST.test(parent.server_name??'')||
       !/^[A-Za-z0-9_-]{43}$/.test(parent.reality_public_key??'')||
       !/^[a-fA-F0-9]{0,16}$/.test(parent.reality_short_id??''))
      return panel('اطلاعات عمومی مسیر اصلی REALITY کامل نیست؛ مسیر اپراتور جدید ساخته نشد.');
    try {
      await db.batch([
        db.prepare(
          "INSERT INTO route_carrier_variants("+
          "route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) "+
          "VALUES(?,?,?,?,?,?,?,0,NULL)"
        ).bind(parent.id,data.operatorHint,parent.host,data.port,parent.server_name,
          parent.reality_public_key,parent.reality_short_id),
        db.prepare(
          "UPDATE nodes SET desired_revision=desired_revision+1,lifecycle='provisioning' "+
          "WHERE id=? AND desired_revision=? AND lifecycle IN ('enrolling','provisioning','degraded')"
        ).bind(data.nodeId,node.desired_revision),
        db.prepare(
          "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
        ).bind('node:carrier:'+parent.id+':'+data.operatorHint,actor,'route',parent.id,
          'stage:carrier:'+data.operatorHint),
      ]);
    } catch {
      return panel('این مسیر اپراتور قبلاً ثبت شده یا به‌روزرسانی پذیرفته نشد؛ تغییری انجام نشد.');
    }
    return panel('✅ مسیر '+(data.operatorHint==='mci'?'همراه اول':'ایرانسل')+
      ' روی درگاه '+faNumber(data.port)+' به‌صورت پیش‌نویس ثبت شد.\n'+
      'هیچ تغییری روی سرویس‌های VPS اعمال نشده است. برای انتشار، عامل امضاشده و آزمون مستقل اتصال لازم است.');
  }
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO routes(id,node_id,transport,state,listen_port,tls_hostname,ws_path,operator_hint) "+
        "VALUES(?,?,?,'draft',?,?,?,?)"
      ).bind(data.id,data.nodeId,data.transport,data.port,data.hostname,data.path,data.operatorHint),
      db.prepare(
        "UPDATE nodes SET desired_revision=desired_revision+1,lifecycle='provisioning' "+
        "WHERE id=? AND desired_revision=? AND lifecycle IN ('enrolling','provisioning','degraded')"
      ).bind(data.nodeId,node.desired_revision),
      db.prepare(
        "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
      ).bind('node:route:'+data.id,actor,'route',data.id,'enroll:draft'),
    ]);
  } catch {
    return panel('این مسیر از قبل ثبت شده یا به‌روزرسانی رد شد؛ هیچ تغییری انجام نشد.');
  }
  return panel('✅ مسیر '+data.transport.toUpperCase()+' برای سرور '+data.nodeId+
    ' به‌صورت پیش‌نویس ثبت شد.\nتا تأیید عامل امضاشده و موفقیت آزمون ترافیک واقعی، فروش این مسیر مجاز نیست.');
}

const NODE_REF=/^[a-f0-9]{24}$/;
const PAGE_SIZE=6;
const FILTERS={
  all:{title:'همه',sql:'1=1'},
  ready:{title:'آماده',sql:"n.lifecycle='ready'"},
  setup:{title:'در حال نصب',sql:"n.lifecycle IN ('enrolling','provisioning') AND NOT EXISTS (SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.state='installed')"},
  testing:{title:'آماده آزمون',sql:"n.lifecycle='provisioning' AND EXISTS (SELECT 1 FROM node_bootstrap_jobs j WHERE j.node_id=n.id AND j.state='installed')"},
  attention:{title:'نیازمند بررسی',sql:"n.lifecycle='degraded'"},
  quarantine:{title:'قرنطینه',sql:"n.lifecycle='quarantined'"},
  archive:{title:'بایگانی',sql:"n.lifecycle='retired'"},
};
const statusOrder="CASE n.lifecycle WHEN 'ready' THEN 0 WHEN 'enrolling' THEN 1 "+
  "WHEN 'provisioning' THEN 2 WHEN 'degraded' THEN 3 WHEN 'quarantined' THEN 4 ELSE 5 END";
const nodeButton=(text,key)=>[{text,callback_data:'v2:'+key}];
const short=(value,max=32)=>String(value).length>max?String(value).slice(0,max-1)+'…':String(value);
const formatCount=(n)=>faNumber(Number(n??0));

/** Stable short callback identifiers also work for a 64-character node ID. */
export async function nodeUiRef(id){
  if(!NODE_ID.test(String(id??'')))return null;
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)));
  return Array.from(digest.slice(0,12),b=>b.toString(16).padStart(2,'0')).join('');
}
async function resolveNodeRef(db,ref){
  if(!NODE_REF.test(String(ref??'')))return null;
  // Fail closed on ambiguity or unusually large node registries.
  const list=(await db.prepare("SELECT id FROM nodes ORDER BY id LIMIT 5001").all()).results??[];
  if(list.length>5000)return null;
  let result=null;
  for(const row of list){
    if(await nodeUiRef(row.id)!==ref)continue;
    if(result)return null;
    result=row.id;
  }
  return result;
}
async function countNodes(db,sql){
  const row=await db.prepare(sql).first();
  return Number(row?.n??0);
}
function filterMenu(filter){
  const f=(name,title)=>({text:(filter===name?'✅ ':'')+title,callback_data:'v2:admin:nodes:'+name+':0'});
  return [
    [f('all','همه'),f('ready','آماده'),f('setup','در حال نصب')],
    [f('testing','آماده آزمون'),f('attention','نیازمند بررسی'),f('quarantine','قرنطینه')],
    [f('archive','بایگانی')],
  ];
}
/** A completed installer is not a ready route: it is waiting for field tests. */
export function nodeStatusPresentation(lifecycle,installState){
  if(lifecycle==='provisioning'&&installState==='installed')
    return {label:'آماده آزمون',symbol:'🧪'};
  return {label:faStatus(lifecycle),symbol:statusSymbol(lifecycle)};
}

/** Overview is intentionally short: each node gets one separate Telegram button. */
export async function nodeOverview(db,{filter='all',page=0}={}){
  if(!Object.hasOwn(FILTERS,filter))filter='all';
  page=Number.isSafeInteger(page)&&page>=0&&page<=1000?page:0;
  const sql=FILTERS[filter].sql;
  const [total,ready,setup,testing,attention,quarantine,archived,filtered]=await Promise.all([
    countNodes(db,'SELECT COUNT(*) AS n FROM nodes'),
    countNodes(db,"SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='ready'"),
    countNodes(db,'SELECT COUNT(*) AS n FROM nodes n WHERE '+FILTERS.setup.sql),
    countNodes(db,'SELECT COUNT(*) AS n FROM nodes n WHERE '+FILTERS.testing.sql),
    countNodes(db,"SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='degraded'"),
    countNodes(db,"SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='quarantined'"),
    countNodes(db,"SELECT COUNT(*) AS n FROM nodes n WHERE n.lifecycle='retired'"),
    countNodes(db,'SELECT COUNT(*) AS n FROM nodes n WHERE '+sql),
  ]);
  const maxPage=Math.max(0,Math.ceil(filtered/PAGE_SIZE)-1);
  page=Math.min(page,maxPage);
  const list=(await db.prepare(
    'SELECT n.id,n.provider,n.region,n.lifecycle,j.state AS install_state FROM nodes n '+
    'LEFT JOIN node_bootstrap_jobs j ON j.node_id=n.id WHERE '+sql+
    ' ORDER BY '+statusOrder+',n.created_at DESC,n.id LIMIT ? OFFSET ?'
  ).bind(PAGE_SIZE,page*PAGE_SIZE).all()).results??[];
  const text=panelHeading('🖥','مدیریت سرورها','هر سرور یک صفحه اختصاصی دارد')+
    '\n\n📊 کل: '+formatCount(total)+'  |  ✅ آماده: '+formatCount(ready)+
    '\n🛠 در حال نصب: '+formatCount(setup)+'  |  🧪 آماده آزمون: '+formatCount(testing)+
    '\n⚠️ بررسی: '+formatCount(attention)+
    '\n🔴 قرنطینه: '+formatCount(quarantine)+'  |  🗄 بایگانی: '+formatCount(archived)+
    '\n\n🔎 فیلتر: '+FILTERS[filter].title+' · صفحه '+formatCount(page+1)+
    ' از '+formatCount(maxPage+1)+
    '\n\n'+(list.length?'برای مدیریت، نام سرور را انتخاب کنید.':'در این دسته سروری وجود ندارد.');
  const items=[];
  for(const n of list){
    const ref=await nodeUiRef(n.id);
    const status=nodeStatusPresentation(n.lifecycle,n.install_state);
    items.push(nodeButton(status.symbol+' '+short(n.id,33)+' · '+status.label,
      'admin:node:view:'+ref));
  }
  const pages=[];
  if(page>0)pages.push({text:'◀️ قبلی',callback_data:'v2:admin:nodes:'+filter+':'+(page-1)});
  if(page<maxPage)pages.push({text:'بعدی ▶️',callback_data:'v2:admin:nodes:'+filter+':'+(page+1)});
  return {text:frameMessage(text),replyMarkup:{inline_keyboard:[
    ...filterMenu(filter),
    ...items,
    ...(pages.length?[pages]:[]),
    nodeButton('➕ افزودن سرور','admin:node:new'),
    nodeButton('🧪 آزمون سرورها','admin:node:trials'),
    ...sectionNavigation('admin'),
  ]}};
}

async function nodeRecord(db,ref){
  const id=await resolveNodeRef(db,ref);
  if(!id)return null;
  return db.prepare(
    'SELECT id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision FROM nodes WHERE id=?'
  ).bind(id).first();
}
async function activeAllocations(db,id){
  const row=await db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(quota_bytes),0) AS bytes FROM node_allocations "+
    "WHERE node_id=? AND state IN ('reserved','active')"
  ).bind(id).first();
  return {n:Number(row?.n??0),bytes:Number(row?.bytes??0)};
}
function quotaLabel(value){
  return formatCount((Number(value??0)/1073741824).toFixed(1))+' گیگابایت';
}
function managementButtons(node,ref,active,jobState){
  const installing=['pending','dispatching','dispatched'].includes(jobState);
  if(node.lifecycle==='retired')return [];
  if(node.lifecycle==='quarantined')return [
    nodeButton('🔄 بازگردانی به بررسی','admin:node:confirm:restore:'+ref),
    ...(active===0&&!installing?[nodeButton('🗄 بایگانی سرور','admin:node:confirm:retire:'+ref)]:[]),
  ];
  return [
    nodeButton('🛡 قرنطینه سرور','admin:node:confirm:quarantine:'+ref),
    ...(['enrolling','provisioning','degraded'].includes(node.lifecycle)&&active===0&&!installing?
      [nodeButton('🗄 بایگانی سرور','admin:node:confirm:retire:'+ref)]:[]),
  ];
}
export async function nodeDetails(db,ref,actor){
  const n=await nodeRecord(db,ref);
  if(!n)return panel('⚠️ سرور یافت نشد یا لینک انتخاب منقضی شده است.');
  const [alloc,job,routes,variants]=await Promise.all([
    activeAllocations(db,n.id),
    db.prepare('SELECT state,owner_id FROM node_bootstrap_jobs WHERE node_id=?').bind(n.id).first(),
    db.prepare("SELECT id,transport,state,listen_port,operator_hint FROM routes WHERE node_id=? ORDER BY id LIMIT 16").bind(n.id).all(),
    db.prepare("SELECT cv.operator,cv.port,cv.published,cv.verified_ms FROM route_carrier_variants cv "+
      "JOIN routes r ON r.id=cv.route_id WHERE r.node_id=? ORDER BY cv.operator LIMIT 10").bind(n.id).all(),
  ]);
  const routeRows=routes.results??[],variantRows=variants.results??[];
  const presentation=nodeStatusPresentation(n.lifecycle,job?.state);
  const waitingForFieldTest=n.lifecycle==='provisioning'&&job?.state==='installed';
  const routeText=routeRows.length?routeRows.map(r=>
    statusSymbol(r.state)+' '+r.transport.toUpperCase()+
    (r.operator_hint?' · '+(r.operator_hint==='mci'?'همراه اول':'ایرانسل'):'')+
    (r.listen_port?' :'+formatCount(r.listen_port):'')+
    ' · '+faStatus(r.state)).join('\n'):'هنوز مسیری ثبت نشده است.';
  const carriers=variantRows.map(v=>
    (v.operator==='mci'?'همراه اول':'ایرانسل')+
    ' :'+formatCount(v.port)+' · '+(v.published&&v.verified_ms?'منتشر و تأییدشده':'آزمایشی')).join('\n');
  const text=panelHeading('🖥','پرونده سرور',n.id)+
    '\n\n🌍 ارائه‌دهنده: '+n.provider+
    '\n📍 منطقه: '+n.region+
    '\n'+presentation.symbol+' وضعیت: '+presentation.label+
    '\n⚙️ نصب: '+(job?faStatus(job.state):'ثبت نشده')+
    '\n👤 ظرفیت: '+formatCount(alloc.n)+' / '+formatCount(n.user_limit)+
    '\n📦 حجم تخصیص‌یافته: '+quotaLabel(alloc.bytes)+' / '+quotaLabel(n.byte_limit)+
    '\n\n🔀 مسیرهای سرور\n'+routeText+
    (carriers?'\n\n📱 مسیرهای اپراتورها\n'+carriers:'')+
    (waitingForFieldTest?'\n\n🧪 نصب سرور موفق بوده است. برای ادامه، لینک تست را باز کنید و اتصال هر دو اپراتور را از گوشی بررسی کنید. تا تأیید آزمون، مسیر منتشر نمی‌شود.':'')+
    '\n\n🔐 تغییر وضعیت فقط پس از تأیید انجام می‌شود؛ این بخش به VPS فرمان حذف نمی‌دهد.';
  const buttons=[
    nodeButton('🔄 تازه‌سازی همین سرور','admin:node:view:'+ref),
    ...(job?.state==='installed'&&job.owner_id===actor&&n.lifecycle!=='retired'&&n.lifecycle!=='quarantined'?
      [nodeButton('🧪 لینک تست این سرور','admin:node:trialref:'+ref)]:[]),
    ...managementButtons(n,ref,alloc.n,job?.state),
    nodeButton('↩️ فهرست سرورها','admin:nodes'),
  ];
  return {text:frameMessage(text),replyMarkup:{inline_keyboard:buttons}};
}
const transition={
  quarantine:{to:'quarantined',from:['enrolling','provisioning','ready','degraded'],label:'قرنطینه'},
  restore:{to:'degraded',from:['quarantined'],label:'بازگردانی به بررسی'},
  retire:{to:'retired',from:['enrolling','provisioning','degraded','quarantined'],label:'بایگانی'},
};
export async function nodeManagement(db,actor,ref,operation,apply=false,updateId=null){
  const t=transition[operation];
  if(!t)return panel('⚠️ عملیات مدیریت سرور شناخته نشد.');
  const n=await nodeRecord(db,ref);
  if(!n)return panel('⚠️ سرور پیدا نشد.');
  const alloc=await activeAllocations(db,n.id);
  const job=operation==='retire'?await db.prepare(
    'SELECT state FROM node_bootstrap_jobs WHERE node_id=?'
  ).bind(n.id).first():null;
  const installing=['pending','dispatching','dispatched'].includes(job?.state);
  if(!t.from.includes(n.lifecycle) || (operation==='retire'&&(alloc.n>0||installing)))
    return {text:frameMessage('⛔ تغییر وضعیت مجاز نیست. وضعیت سرور یا اشتراک‌های تخصیص‌یافته را بررسی کنید.'),
      replyMarkup:{inline_keyboard:[nodeButton('↩️ پرونده سرور','admin:node:view:'+ref)]}};
  if(!apply){
    const description=operation==='quarantine'
      ?'قرنطینه، سرور را از فهرست آماده خارج می‌کند و ممکن است بر سرویس‌های فعال اثر بگذارد.'
      :operation==='restore'
        ?'سرور فقط به وضعیت «نیازمند بررسی» بازمی‌گردد؛ آماده فروش نمی‌شود.'
        :'سرور در مدار بایگانی می‌شود؛ VPS و فایل‌ها حذف نمی‌شوند.';
    return {text:frameMessage(panelHeading('⚠️','تأیید '+t.label,n.id)+
      '\n\nوضعیت فعلی: '+faStatus(n.lifecycle)+
      '\nاشتراک‌های تخصیص‌یافته: '+formatCount(alloc.n)+
      '\n\n'+description+
      '\n\nبرای انجام این تغییر، تأیید را انتخاب کنید.'),
      replyMarkup:{inline_keyboard:[
        nodeButton('✅ تأیید '+t.label,'admin:node:apply:'+operation+':'+ref),
        nodeButton('↩️ انصراف','admin:node:view:'+ref),
      ]}};
  }
  if(!Number.isSafeInteger(updateId)||updateId<0)
    return panel('⛔ درخواست تغییر معتبر نیست.');
  const allowed=t.from.map(x=>"'"+x+"'").join(',');
  const sql="UPDATE nodes SET lifecycle=? WHERE id=? AND lifecycle IN ("+allowed+")"+
    (operation==='retire'?
      " AND NOT EXISTS (SELECT 1 FROM node_allocations WHERE node_id=? AND state IN ('reserved','active'))"+
      " AND NOT EXISTS (SELECT 1 FROM node_bootstrap_jobs WHERE node_id=? AND state IN ('pending','dispatching','dispatched'))":'');
  const params=operation==='retire'?[t.to,n.id,n.id,n.id]:[t.to,n.id];
  const results=await db.batch([
    db.prepare(sql).bind(...params),
    db.prepare("INSERT OR IGNORE INTO audit_events(event_id,actor_id,object_type,object_id,verb) "+
      "SELECT ?,?,'node',?,? WHERE EXISTS (SELECT 1 FROM nodes WHERE id=? AND lifecycle=?)")
      .bind('node:management:'+updateId,actor,n.id,'lifecycle:'+operation,n.id,t.to),
  ]);
  if(results[0]?.meta?.changes!==1)
    return panel('⏳ وضعیت سرور هم‌زمان تغییر کرد؛ لطفاً صفحه سرور را تازه‌سازی کنید.');
  return {text:frameMessage('✅ '+(operation==='retire'?'سرور بایگانی شد: ':'وضعیت سرور تغییر کرد: ')+n.id+
    '\nوضعیت جدید: '+faStatus(t.to)+
    '\n\nاین تغییر به معنای تأیید اتصال یا حذف VPS نیست.'),
    replyMarkup:{inline_keyboard:[nodeButton('🖥 مشاهده سرور','admin:node:view:'+ref)]}};
}
export async function nodeFromRef(db,ref){
  return nodeRecord(db,ref);
}

export async function nodeAdminAction(db,actor,key,input) {
  if(key==='/node_add')return enrollNode(db,actor,input);
  if(key==='/node_route')return addRoute(db,actor,input);
  if(key==='/nodes')return nodeOverview(db);
  return null;
}

/** مدیریت فارسی سرورها و مسیرهای پیش‌نویس در محیط V2. */
import {adminMenu,frameMessage,faStatus,faNumber} from './bot-ux.mjs';

const NODE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const PROVIDER=/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const REGION=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const HOST=/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,252}$/;
const NAT=/^(0|[1-9]\d*)$/;
const MAX_GB=200000;
const gbToBytes=n=>n*1073741824;

function panel(message) {
  return {text:frameMessage(message),replyMarkup:adminMenu()};
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
  if(!data)return panel('قالب ثبت دستی سرور:\\n/node_add شناسه|ارائه‌دهنده|منطقه|سقف کاربر|ظرفیت گیگابایت');
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
    return panel('✅ سرور '+id+' ثبت شد، اما هنوز آماده استفاده نیست.\\nبرای تعریف مسیر از دستور /node_route استفاده کنید. نصب عامل امن و آزمون واقعی اتصال نیز لازم است.');
  } catch {
    return panel('⚠️ سرور از قبل ثبت شده یا اطلاعات آن معتبر نیست؛ هیچ تغییری انجام نشد.');
  }
}

export async function addRoute(db,actor,input) {
  const data=parseRouteAdd(input);
  if(!data)return panel(
    'قالب تعریف مسیر:\\n'+
    '/node_route شناسه_سرور|reality|443|mci\\n'+
    '/node_route شناسه_سرور|reality|8443|irancell\\n'+
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
      ' روی درگاه '+faNumber(data.port)+' به‌صورت پیش‌نویس ثبت شد.\\n'+
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
    ' به‌صورت پیش‌نویس ثبت شد.\\nتا تأیید عامل امضاشده و موفقیت آزمون ترافیک واقعی، فروش این مسیر مجاز نیست.');
}

export async function nodeOverview(db) {
  const rows=(await db.prepare(
    "SELECT n.id,n.provider,n.region,n.lifecycle,n.desired_revision,n.acked_revision,"+
    "COUNT(r.id) AS routes FROM nodes n LEFT JOIN routes r ON r.node_id=n.id "+
    "GROUP BY n.id ORDER BY n.created_at DESC,n.id LIMIT 30"
  ).all()).results??[];
  if(!rows.length)return panel('هنوز سروری در مدار V2 ثبت نشده است. برای افزودن سرور از پنل مدیریت اقدام کنید.');
  return panel('🖥  فهرست سرورهای مدار\\n━━━━━━━━━━━━━━━━━━\\n'+rows.map(n=>
    n.id+'\\nارائه‌دهنده: '+n.provider+'  |  منطقه: '+n.region+
    '\\nوضعیت: '+faStatus(n.lifecycle)+
    '\\nنسخه تنظیمات: '+faNumber(n.desired_revision)+
    '  |  تأیید عامل: '+faNumber(n.acked_revision)+
    '  |  مسیرها: '+faNumber(n.routes)
  ).join('\\n\\n'));
}

export async function nodeAdminAction(db,actor,key,input) {
  if(key==='/node_add')return enrollNode(db,actor,input);
  if(key==='/node_route')return addRoute(db,actor,input);
  if(key==='/nodes')return nodeOverview(db);
  return null;
}

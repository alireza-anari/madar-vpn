/** Owner-only staging-safe node enrollment and desired-state route editing.
 * Nothing here touches a VPS. "enrolling" and "draft" must never qualify
 * for sales, configuration issuance or "connected" labels.
 */
import { botMenu } from './bot-ux.mjs';

const NODE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const PROVIDER=/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
const REGION=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const HOST=/^[a-zA-Z0-9][a-zA-Z0-9.-]{2,252}$/;
const NAT=/^(0|[1-9]\d*)$/;
const MAX_GB=200000;
const gbToBytes=n=>n*1073741824;

function panel(message,locale='fa') {
  return {text:message,replyMarkup:botMenu(locale)};
}

export function parseNodeAdd(input) {
  if(typeof input!=='string') return null;
  const parts=input.replace(/^\/node_add(?:@\w+)?\s*/, '').trim().split('|').map(x=>x.trim());
  if(parts.length!==5) return null;
  const [id,provider,region,usersRaw,gbRaw]=parts;
  if(!NODE_ID.test(id) || !PROVIDER.test(provider) || !REGION.test(region) ||
     !NAT.test(usersRaw)||!NAT.test(gbRaw)) return null;
  const users=Number(usersRaw),gb=Number(gbRaw);
  if(!Number.isSafeInteger(users)||users<1||users>100000 ||
     !Number.isSafeInteger(gb)||gb<1||gb>MAX_GB) return null;
  return {id,provider,region,userLimit:users,byteLimit:gbToBytes(gb)};
}

export function parseRouteAdd(input) {
  if(typeof input!=='string') return null;
  const parts=input.replace(/^\/node_route(?:@\w+)?\s*/, '').trim().split('|').map(x=>x.trim());
  const [nodeId,transport,portRaw,hostname,path]=parts;
  if(!NODE_ID.test(nodeId??'') || !['reality','wss'].includes(transport) ||
     !NAT.test(portRaw??'')) return null;
  const port=Number(portRaw);
  if(!Number.isSafeInteger(port)||port<1||port>65535) return null;
  if(transport==='reality' && parts.length===3)
    return {nodeId,transport,port,hostname:null,path:null,id:nodeId+'_reality',operatorHint:null};
  if(transport==='reality' && parts.length===4 && ['mci','irancell'].includes(hostname))
    return {nodeId,transport,port,hostname:null,path:null,
      id:nodeId+'_reality_'+hostname,operatorHint:hostname};
  if(transport==='wss' && parts.length===5 && HOST.test(hostname??'') &&
     typeof path==='string' && path.startsWith('/') && path.length<=256 &&
     !/[\r\n?&#]/.test(path))
    return {nodeId,transport,port,hostname,path,id:nodeId+'_wss',operatorHint:null};
  return null;
}

export async function enrollNode(db,actor,input) {
  const data=parseNodeAdd(input);
  if(!data) return panel('Usage: /node_add ID|provider|region|users|capacityGB');
  const {id,provider,region,userLimit,byteLimit}=data;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit,desired_revision,acked_revision) " +
        "VALUES(?,?,?,'enrolling',?,?,1,0)"
      ).bind(id,provider,region,userLimit,byteLimit),
      db.prepare(
        "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) " +
        "VALUES(?,?,?,?,?)"
      ).bind('node:add:'+id,actor,'node',id,'enroll'),
    ]);
    return panel('✅ Node '+id+' enrolled, NOT ready.\nAssign a route with /node_route. A separate agent and field acceptance are required.');
  } catch {
    return panel('Node already exists or failed validation; no changes made.');
  }
}

export async function addRoute(db,actor,input) {
  const data=parseRouteAdd(input);
  if(!data) return panel(
    'Usage:\n/node_route NODE_ID|reality|443|mci\n/node_route NODE_ID|reality|8443|irancell\n/node_route NODE_ID|wss|8443|vpn.example.com|/ws');
  const node=await db.prepare(
    "SELECT id,lifecycle,desired_revision FROM nodes WHERE id=?"
  ).bind(data.nodeId).first();
  if(!node || !['enrolling','provisioning','degraded'].includes(node.lifecycle))
    return panel('Node not found or may have live allocations; route unchanged.');
  if(node.desired_revision>=2147483647) return panel('Revision limit reached.');
  if(data.operatorHint) {
    // The legacy routes table has UNIQUE(node_id,transport). A second
    // carrier is a draft variant of the *same* parent REALITY route,
    // never an extra billed node allocation or an overlapping route.
    const parent=await db.prepare(
      "SELECT r.id,re.host,re.server_name,re.reality_public_key,re.reality_short_id " +
      "FROM routes r JOIN route_endpoints re ON re.route_id=r.id " +
      "WHERE r.node_id=? AND r.transport='reality' LIMIT 1"
    ).bind(data.nodeId).first();
    if(!parent || !HOST.test(parent.host??'') ||
       !HOST.test(parent.server_name??'') ||
       !/^[A-Za-z0-9_-]{43}$/.test(parent.reality_public_key??'') ||
       !/^[a-fA-F0-9]{0,16}$/.test(parent.reality_short_id??''))
      return panel('Parent REALITY route has no complete public metadata; no carrier variant created.');
    try {
      await db.batch([
        db.prepare(
          "INSERT INTO route_carrier_variants(" +
          "route_id,operator,host,port,server_name,reality_public_key,reality_short_id,published,verified_ms) " +
          "VALUES(?,?,?,?,?,?,?,0,NULL)"
        ).bind(parent.id,data.operatorHint,parent.host,data.port,parent.server_name,
          parent.reality_public_key,parent.reality_short_id),
        db.prepare(
          "UPDATE nodes SET desired_revision=desired_revision+1,lifecycle='provisioning' " +
          "WHERE id=? AND desired_revision=? AND lifecycle IN ('enrolling','provisioning','degraded')"
        ).bind(data.nodeId,node.desired_revision),
        db.prepare(
          "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) VALUES(?,?,?,?,?)"
        ).bind('node:carrier:'+parent.id+':'+data.operatorHint,actor,'route',parent.id,
          'stage:carrier:'+data.operatorHint),
      ]);
    } catch {
      return panel('Carrier variant already staged or update rejected; no changes made.');
    }
    return panel('✅ '+data.operatorHint.toUpperCase()+' port '+data.port+
      ' staged as unpublished variant. VPS listeners are NOT changed. '+
      'Signed agent support and independent external authenticated carrier acceptance required.');
  }
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO routes(id,node_id,transport,state,listen_port,tls_hostname,ws_path,operator_hint) " +
        "VALUES(?,?,?,'draft',?,?,?,?)"
      ).bind(data.id,data.nodeId,data.transport,data.port,data.hostname,data.path,data.operatorHint),
      db.prepare(
        "UPDATE nodes SET desired_revision=desired_revision+1, lifecycle='provisioning' " +
        "WHERE id=? AND desired_revision=? AND lifecycle IN ('enrolling','provisioning','degraded')"
      ).bind(data.nodeId,node.desired_revision),
      db.prepare(
        "INSERT INTO audit_events(event_id,actor_id,object_type,object_id,verb) " +
        "VALUES(?,?,?,?,?)"
      ).bind('node:route:'+data.id,actor,'route',data.id,'enroll:draft'),
    ]);
  } catch {return panel('Route already exists or update was rejected; no changes made.');}
  return panel('✅ '+data.transport.toUpperCase()+' draft registered on '+data.nodeId+
    '. The signed agent must ACK, then authenticated external traffic tests must pass before it can be sold.');
}

export async function nodeOverview(db) {
  const rows=(await db.prepare(
    "SELECT n.id,n.provider,n.region,n.lifecycle,n.desired_revision,n.acked_revision," +
    "COUNT(r.id) AS routes FROM nodes n LEFT JOIN routes r ON r.node_id=n.id " +
    "GROUP BY n.id ORDER BY n.created_at DESC,n.id LIMIT 30"
  ).all()).results??[];
  if(!rows.length) return panel('No V2 nodes enrolled. Use /node_add.');
  return panel('🖥 Madar V2 nodes (not connection validation):\n'+rows.map(n=>
    n.id+' · '+n.provider+'/'+n.region+' · '+n.lifecycle+'\n'+
    'desired '+n.desired_revision+' / ACK '+n.acked_revision+' · routes '+n.routes
  ).join('\n\n'));
}

export async function nodeAdminAction(db,actor,key,input) {
  if(key==='/node_add') return enrollNode(db,actor,input);
  if(key==='/node_route') return addRoute(db,actor,input);
  if(key==='/nodes') return nodeOverview(db);
  return null;
}

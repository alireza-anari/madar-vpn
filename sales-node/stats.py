"""Strict, non-resetting per-account counters from the loopback Xray API."""
import json,re,subprocess,tempfile
MAX_OUTPUT=1048576
MAX_INTEGER=9007199254740991

def parse_counters(raw,account_ids):
    if len(raw)>MAX_OUTPUT:raise ValueError('STATS_TOO_LARGE')
    data=json.loads(raw);items=data.get('stat',[])
    if not isinstance(items,list):raise ValueError('INVALID_STATS')
    expected={f'user>>>{a}>>>traffic>>>{direction}':a for a in account_ids for direction in ('uplink','downlink')}
    values={};totals={a:0 for a in account_ids}
    for item in items:
        name=item.get('name');value=item.get('value',0)
        if isinstance(value,str) and re.fullmatch(r'[0-9]{1,16}',value):value=int(value)
        if name not in expected or name in values or type(value) is not int or not 0<=value<=MAX_INTEGER:raise ValueError('INVALID_STATS')
        values[name]=value;totals[expected[name]]+=value
    if set(values)!=set(expected) or any(v>MAX_INTEGER for v in totals.values()):raise ValueError('MISSING_STATS')
    return totals

def read_counters(server,account_ids,binary='/opt/madar-sales-node/xray',allow_unregistered=False):
    if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}',server):raise ValueError('INVALID_STATS_SERVER')
    with tempfile.TemporaryFile() as output:
        subprocess.run([binary,'api','statsquery','--server='+server,'-timeout','1','-pattern','user>>>'],stdout=output,stderr=subprocess.DEVNULL,check=True,timeout=2)
        output.seek(0);raw=output.read(MAX_OUTPUT+1)
    if allow_unregistered and len(raw)<=MAX_OUTPUT and json.loads(raw) in ({},{"stat":[]}):return None
    return parse_counters(raw,account_ids)

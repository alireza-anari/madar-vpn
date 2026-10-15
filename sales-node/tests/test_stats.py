import json
import pytest
from stats import parse_counters

def payload(items):return json.dumps({'stat':[{'name':f'user>>>a>>>traffic>>>{k}','value':v} for k,v in items]})
def test_both_directions():assert parse_counters(payload([('uplink',5),('downlink',7)]),['a'])=={'a':12}
@pytest.mark.parametrize('items',[[('uplink',-1),('downlink',7)],[('uplink',True),('downlink',0)],[('uplink',1)],[('uplink',1),('downlink',0),('other',5)],[('uplink',1),('uplink',2),('downlink',0)]])
def test_invalid_stats(items):
    with pytest.raises(ValueError):parse_counters(payload(items),['a'])
def test_output_limit():
    with pytest.raises(ValueError):parse_counters(' '*1048577,['a'])

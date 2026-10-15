import pytest
from quota import QuotaStore

def account(**kw):return dict(accountId='a',quotaEpoch=1,quotaBytes=100,usedBytes=0,validUntil=1000,generation='epoch1',**kw)
def test_shared_total_durable_report_and_no_double_count(tmp_path):
    p=tmp_path/'quota.sqlite';s=QuotaStore(p);s.reconcile_policy({'revision':1,'clients':[account()]},100)
    s.observe('a','process1',0,100);s.observe('a','process1',30,101);s.observe('a','process1',30,102)
    assert s.remaining('a')==70
    report=s.pending_reports()[-1];s.close();s=QuotaStore(p)
    assert s.remaining('a')==70 and report in s.pending_reports()
    s.ack_report('a',report['sequence']);assert not s.pending_reports()
    s.observe('a','process1',110,103);assert s.remaining('a')==0 and not s.allowed('a',103)
def test_reset_and_policy_replay_fail_closed(tmp_path):
    s=QuotaStore(tmp_path/'q');p={'revision':1,'clients':[account()]};s.reconcile_policy(p,100);s.observe('a','p',0,100);s.observe('a','p',20,101)
    with pytest.raises(ValueError):s.observe('a','other',0,102)
    assert not s.allowed('a',102)
    s.reconcile_policy({'revision':2,'clients':[account()]},102);assert not s.allowed('a',102)
    with pytest.raises(ValueError):s.reconcile_policy(p,102)
def test_counter_decrease_and_expiry(tmp_path):
    s=QuotaStore(tmp_path/'q');s.reconcile_policy({'revision':1,'clients':[account()]},100);s.observe('a','p',0,100);s.observe('a','p',40,101)
    with pytest.raises(ValueError):s.observe('a','p',39,102)
    assert not s.allowed('a',102)
    assert not s.allowed('a',1000)

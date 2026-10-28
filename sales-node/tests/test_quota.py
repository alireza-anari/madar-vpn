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


def test_idle_samples_do_not_rewrite_or_duplicate_quota_reports(tmp_path):
    s=QuotaStore(tmp_path/'quota.sqlite')
    s.reconcile_policy({'revision':1,'clients':[account()]},100)
    s.observe('a','proc',0,100)
    initial=s.pending_reports()[0]
    s.ack_report('a',initial['sequence'])
    for now in range(101,151):s.observe('a','proc',0,now)
    assert s.pending_reports()==[]
    assert s.db.execute("SELECT sequence FROM accounts WHERE id='a'").fetchone()[0]==initial['sequence']
    s.observe('a','proc',25,151)
    updated=s.pending_reports()[0]
    assert updated['totalBytes']==25
    assert updated['sequence']==initial['sequence']+1
    for now in range(152,161):s.observe('a','proc',25,now)
    assert s.pending_reports()==[updated]
    assert s.remaining('a')==75
    s.close()


def test_idle_noop_does_not_hide_counter_reset_or_new_process(tmp_path):
    s=QuotaStore(tmp_path/'quota.sqlite')
    s.reconcile_policy({'revision':1,'clients':[account()]},100)
    s.observe('a','proc1',0,100)
    s.observe('a','proc1',30,101)
    s.observe('a','proc1',30,102)
    with pytest.raises(ValueError,match='COUNTER_CONTINUITY_LOST'):
        s.observe('a','proc2',30,103)
    assert not s.allowed('a',103)
    s.close()

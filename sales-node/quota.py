"""Durable cumulative quota accounting. Unproven continuity never grants traffic."""
import json,os,pathlib,sqlite3
MAX=9007199254740991

def integer(value):
    if type(value) is not int or not 0<=value<=MAX:raise ValueError('INVALID_INTEGER')
    return value

class QuotaStore:
    def __init__(self,path):
        path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=sqlite3.connect(path);os.chmod(path,0o600);self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA journal_mode=DELETE');self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY,revision INTEGER); INSERT OR IGNORE INTO meta VALUES(1,0); CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,epoch INTEGER,cap INTEGER,used INTEGER,until_time INTEGER,policy_generation TEXT,process_generation TEXT,counter INTEGER,sequence INTEGER DEFAULT 0,blocked INTEGER DEFAULT 0,present INTEGER DEFAULT 1); CREATE TABLE IF NOT EXISTS reports(account TEXT PRIMARY KEY,payload TEXT NOT NULL);')
    def close(self):self.db.close()
    def reconcile_policy(self,policy,now):
        revision=integer(policy['revision'])
        if revision<self.db.execute('SELECT revision FROM meta').fetchone()[0]:raise ValueError('POLICY_ROLLBACK')
        with self.db:
            self.db.execute('UPDATE accounts SET present=0')
            for a in policy['clients']:
                ident=a['accountId'];epoch=integer(a['quotaEpoch']);used=integer(a['usedBytes']);until=integer(a['validUntil']);cap=a['quotaBytes']
                if cap is not None:integer(cap)
                old=self.db.execute('SELECT * FROM accounts WHERE id=?',(ident,)).fetchone()
                if old:
                    if epoch!=old['epoch'] or a['generation']!=old['policy_generation'] or cap!=old['cap']:raise ValueError('ACCOUNT_EPOCH_CHANGED')
                    self.db.execute('UPDATE accounts SET used=MAX(used,?),until_time=?,present=1 WHERE id=?',(used,until,ident))
                else:self.db.execute('INSERT INTO accounts(id,epoch,cap,used,until_time,policy_generation,present) VALUES(?,?,?,?,?,?,1)',(ident,epoch,cap,used,until,a['generation']))
            self.db.execute('UPDATE meta SET revision=?',(revision,))
    def block(self,ident):
        with self.db:
            self.db.execute('UPDATE accounts SET blocked=1 WHERE id=?',(ident,))
            row=self.db.execute('SELECT * FROM accounts WHERE id=?',(ident,)).fetchone()
            if row:
                seq=row['sequence']+1
                self.db.execute('UPDATE accounts SET sequence=? WHERE id=?',(seq,ident))
                report={'accountId':ident,'quotaEpoch':row['epoch'],'sequence':seq,'totalBytes':row['used'],'observedAt':__import__('time').time_ns()//1000000000,'generation':row['policy_generation'],'blocked':True}
                self.db.execute('INSERT OR REPLACE INTO reports VALUES(?,?)',(ident,json.dumps(report)))
    def observe(self,ident,generation,counter,now):
        counter=integer(counter);integer(now)
        row=self.db.execute('SELECT * FROM accounts WHERE id=?',(ident,)).fetchone()
        if not row or not generation:raise ValueError('UNKNOWN_ACCOUNT')
        if (row['process_generation'] is not None and row['process_generation']!=generation) or (row['counter'] is not None and counter<row['counter']):
            self.block(ident);raise ValueError('COUNTER_CONTINUITY_LOST')
        # The first observation must be a verified zero baseline before listeners open.
        if row['counter'] is None and counter!=0:
            self.block(ident);raise ValueError('MISSING_ZERO_BASELINE')
        delta=0 if row['counter'] is None else counter-row['counter'];total=integer(row['used']+delta);sequence=row['sequence']+1
        report={'accountId':ident,'quotaEpoch':row['epoch'],'sequence':sequence,'totalBytes':total,'observedAt':now,'generation':row['policy_generation']}
        with self.db:
            self.db.execute('UPDATE accounts SET process_generation=?,counter=?,used=?,sequence=? WHERE id=?',(generation,counter,total,sequence,ident))
            self.db.execute('INSERT OR REPLACE INTO reports VALUES(?,?)',(ident,json.dumps(report)))
    def checkpoint_restart(self,ident,generation,counter,now):
        self.observe(ident,generation,counter,now)
        with self.db:self.db.execute('UPDATE accounts SET process_generation=NULL,counter=NULL WHERE id=?',(ident,))
    def remaining(self,ident):
        r=self.db.execute('SELECT cap,used FROM accounts WHERE id=?',(ident,)).fetchone()
        return None if r['cap'] is None else max(0,r['cap']-r['used'])
    def allowed(self,ident,now):
        r=self.db.execute('SELECT * FROM accounts WHERE id=?',(ident,)).fetchone()
        return bool(r and r['present'] and not r['blocked'] and r['until_time']>now and (r['cap'] is None or r['used']<r['cap']))
    def pending_reports(self):return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM reports ORDER BY account')]
    def ack_report(self,ident,sequence):
        with self.db:self.db.execute("DELETE FROM reports WHERE account=? AND json_extract(payload,'$.sequence')<=?",(ident,sequence))

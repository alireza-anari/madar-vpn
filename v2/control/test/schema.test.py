import pathlib
import sqlite3
import unittest
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[1]
MIGRATIONS=sorted((ROOT/'migrations').glob('*.sql'))


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        for migration in MIGRATIONS:
            self.db.executescript(migration.read_text())
        self.db.execute('INSERT INTO nodes(id,provider,region,lifecycle,user_limit,byte_limit) VALUES(?,?,?,?,?,?)',
            ('node-1','provider-a','eu','ready',2,1000))
        for n in range(4):
            self.db.execute('INSERT INTO subscriptions(id,owner_telegram_id,state,expires_at) VALUES(?,?,?,?)',
                (f'sub-{n}',str(n),'active',2000000000000))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def reserve(self, index, bytes_):
        self.db.execute('INSERT INTO node_allocations(id,node_id,subscription_id,quota_bytes,state) VALUES(?,?,?,?,?)',
            (f'alloc-{index}','node-1',f'sub-{index}',bytes_,'reserved'))

    def test_capacity_rejects_byte_oversell_and_user_oversell(self):
        self.reserve(0,650)
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'NODE_BYTE_CAP_REACHED'):
            self.reserve(1,500)
        self.reserve(1,350)
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'NODE_USER_CAP_REACHED'):
            self.reserve(2,1)

    def test_updates_cannot_evade_capacity(self):
        self.reserve(0,600)
        self.reserve(1,300)
        with self.assertRaisesRegex(sqlite3.IntegrityError,'NODE_BYTE_CAP_REACHED'):
            self.db.execute("UPDATE node_allocations SET quota_bytes=450 WHERE id='alloc-1'")

    def test_released_allocations_allow_reuse(self):
        self.reserve(0,750)
        self.db.execute("UPDATE node_allocations SET state='released' WHERE id='alloc-0'")
        self.reserve(1,900)

    def test_duplicate_purchase_idempotency_key_is_rejected(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES ('101')")
        self.db.execute("""INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days)
            VALUES ('trial','آزمایشی','Trial',0,'IRT',100,1)""")
        v=lambda id: (id,'101','trial','same-key',0,'IRT')
        self.db.execute("""INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency)
            VALUES(?,?,?,?,?,?)""",v('one'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency)
                VALUES(?,?,?,?,?,?)""",v('two'))

    def test_prevents_order_fulfillment_without_provisioning(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES ('101')")
        self.db.execute("""INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days)
            VALUES ('trial','آزمایشی','Trial',0,'IRT',100,1)""")
        self.db.execute("""INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency)
            VALUES ('order-1','101','trial','key',0,'IRT')""")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'FULFILLMENT_REQUIRES_PROVISIONING'):
            self.db.execute("UPDATE orders SET state='fulfilled' WHERE id='order-1'")

if __name__=='__main__':
    unittest.main()

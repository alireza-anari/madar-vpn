import pathlib
import sqlite3
import unittest

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
        with self.assertRaisesRegex(sqlite3.IntegrityError,'ORDER_STATE_TRANSITION_REJECTED'):
            self.db.execute("UPDATE orders SET state='fulfilled' WHERE id='order-1'")

    def test_one_open_checkout_prevents_ambiguous_receipts(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("""INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days)
            VALUES ('trial','آزمایشی','Trial',1000,'IRT',100,1)""")
        statement=("INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency)"
                   " VALUES(?,?,?,?,?,?)")
        self.db.execute(statement,('o1','101','trial','req1',1000,'IRT'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(statement,('o2','101','trial','req2',1000,'IRT'))

    def test_receipt_is_owned_and_requires_pending_order(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101'),('202')")
        self.db.execute("""INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days)
            VALUES ('trial','آزمایشی','Trial',1000,'IRT',100,1)""")
        self.db.execute("""INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency)
            VALUES('o1','101','trial','req1',1000,'IRT')""")
        sql=("INSERT INTO receipts(id,order_id,telegram_file_id,upload_by_telegram_id)"
             " VALUES(?,?,?,?)")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'RECEIPT_REQUIRES_OWN_PENDING_ORDER'):
            self.db.execute(sql,('r0','o1','image-file','202'))
        self.db.execute(sql,('r1','o1','image-file','101'))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql,('r2','o1','another-file','101'))
        self.db.execute("UPDATE orders SET state='receipt_submitted' WHERE id='o1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'RECEIPT_REQUIRES_OWN_PENDING_ORDER'):
            self.db.execute(sql,('r3','o1','third-file','101'))
        self.db.execute("UPDATE orders SET state='approved' WHERE id='o1'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'ORDER_STATE_TRANSITION_REJECTED'):
            self.db.execute("UPDATE orders SET state='pending' WHERE id='o1'")

    def test_inbox_deduplicates_telegram_updates(self):
        sql=("INSERT INTO telegram_inbox(update_id,chat_id,event_json,due_ms)"
             " VALUES(?,?,?,?)")
        self.db.execute(sql,(300,'100','{}',0))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql,(300,'100','{}',0))

    def test_referral_requires_active_seller_and_is_immutable(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES ('101'),('202'),('303')")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'SELLER_NOT_ACTIVE'):
            self.db.execute("UPDATE customers SET seller_telegram_id='202' WHERE telegram_id='101'")
        self.db.execute("INSERT INTO staff_roles(telegram_id,role,granted_by) VALUES('202','seller','owner')")
        self.db.execute("UPDATE customers SET seller_telegram_id='202' WHERE telegram_id='101'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'REFERRAL_LINK_IMMUTABLE'):
            self.db.execute("UPDATE customers SET seller_telegram_id='303' WHERE telegram_id='101'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'SELF_REFERRAL_REJECTED'):
            self.db.execute("UPDATE customers SET seller_telegram_id='202' WHERE telegram_id='202'")

    def test_subscription_usage_never_exceeds_quota(self):
        self.db.execute("UPDATE subscriptions SET max_bytes=1000,used_bytes=800 WHERE id='sub-0'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'SUBSCRIPTION_QUOTA_EXCEEDED'):
            self.db.execute("UPDATE subscriptions SET used_bytes=1100 WHERE id='sub-0'")

    def test_order_link_is_unique_when_present(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("""INSERT INTO plans(id,title_fa,title_en,price_amount,price_currency,quota_bytes,duration_days)
            VALUES('trial','آزمایشی','Trial',0,'IRT',100,1)""")
        self.db.execute("""INSERT INTO orders(id,customer_telegram_id,plan_id,idempotency_key,quoted_amount,quoted_currency)
            VALUES('order-1','101','trial','req-1',0,'IRT')""")
        self.db.execute("UPDATE subscriptions SET order_id='order-1' WHERE id='sub-0'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE subscriptions SET order_id='order-1' WHERE id='sub-1'")

    def test_closed_support_ticket_cannot_reopen(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("INSERT INTO support_tickets(id,customer_telegram_id,state,subject) VALUES('tg-1','101','closed','Help')")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'SUPPORT_TICKET_CLOSED'):
            self.db.execute("UPDATE support_tickets SET state='open' WHERE id='tg-1'")

if __name__=='__main__':
    unittest.main()

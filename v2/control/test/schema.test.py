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

    def test_two_carrier_ports_share_one_parent_route_and_allocation(self):
        # Original UNIQUE(node_id, transport) is retained for backwards
        # compatibility. Two REALITY ports belong to one route, not two nodes.
        self.db.execute("""INSERT INTO routes(id,node_id,transport,state,operator_hint)
            VALUES('r-main','node-1','reality','draft',NULL)""")
        values=("r-main", "mci","vpn.example.com",443,"www.cloudflare.com","A"*43,"abcd")
        sql=("INSERT INTO route_carrier_variants(route_id,operator,host,port,server_name,"
             "reality_public_key,reality_short_id) VALUES(?,?,?,?,?,?,?)")
        self.db.execute(sql,values)
        self.db.execute(sql,("r-main","irancell","vpn.example.com",8443,
                             "www.cloudflare.com","A"*43,"abcd"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql,values)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(sql,("r-main","unknown","vpn.example.com",9443,
                                 "www.cloudflare.com","A"*43,"abcd"))
        self.reserve(0,300)
        count=self.db.execute(
            "SELECT COUNT(*) FROM node_allocations WHERE node_id='node-1'"
        ).fetchone()[0]
        self.assertEqual(count,1)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM route_carrier_variants WHERE route_id='r-main'"
        ).fetchone()[0],2)

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

    def test_support_retention_is_based_on_actual_closure_date(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("INSERT INTO support_tickets(id,customer_telegram_id,state,subject) VALUES('tg-77','101','open','Network help')")
        self.db.execute("UPDATE support_tickets SET state='closed' WHERE id='tg-77'")
        row=self.db.execute("SELECT closed_at FROM support_tickets WHERE id='tg-77'").fetchone()
        self.assertTrue(row[0], 'closure date must be stamped')

    def test_bot_activation_requires_a_known_customer_and_records_channel_verification(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("""INSERT INTO telegram_bot_activations
            (telegram_id,channel_id,activated_ms,last_verified_ms)
            VALUES(?,?,?,?)""",('101','-1001234567890',1000,2000))
        row=self.db.execute("""SELECT channel_id,activated_ms,last_verified_ms
            FROM telegram_bot_activations WHERE telegram_id='101'""").fetchone()
        self.assertEqual(row,('-1001234567890',1000,2000))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""INSERT INTO telegram_bot_activations
                (telegram_id,channel_id,activated_ms,last_verified_ms)
                VALUES(?,?,?,?)""",('999','-1001234567890',1000,1000))

    def test_android_identity_session_is_linked_to_verified_customer(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("""INSERT INTO android_app_sessions
            (token_hash,telegram_id,created_ms,expires_ms) VALUES(?,?,?,?)""",
            ('B'*64,'101',1000,2000))
        self.db.execute("UPDATE android_app_sessions SET revoked=1 WHERE telegram_id='101'")
        row=self.db.execute("""SELECT revoked FROM android_app_sessions WHERE telegram_id='101'""").fetchone()
        self.assertEqual(row,(1,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""INSERT INTO android_app_sessions
                (token_hash,telegram_id,created_ms,expires_ms) VALUES(?,?,?,?)""",
                ('C'*64,'999',1000,2000))

    def test_android_login_otp_is_short_lived_and_attempt_limited(self):
        self.db.execute("INSERT INTO customers(telegram_id) VALUES('101')")
        self.db.execute("""INSERT INTO android_login_challenges
            (id,verifier_hash,telegram_id,state,created_ms,expires_ms)
            VALUES(?,?,?,?,?,?)""",
            ('A'*24,'B'*64,'101','pending',1000,301000))
        self.db.execute("""UPDATE android_login_challenges SET
            state='code_sent',otp_hash=?,otp_nonce=?,otp_ciphertext=?,
            otp_expires_ms=?,otp_attempts=5 WHERE id=?""",
            ('C'*64,'D'*16,'E'*30,181000,'A'*24))
        row=self.db.execute("""SELECT state,otp_hash,otp_expires_ms,otp_attempts
            FROM android_login_challenges WHERE id=?""",('A'*24,)).fetchone()
        self.assertEqual(row,('code_sent','C'*64,181000,5))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE android_login_challenges SET otp_attempts=6 WHERE id='"+
                            'A'*24+"'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE android_login_challenges SET state='unknown' WHERE id='"+
                            'A'*24+"'")

    def test_field_evidence_rejects_mislabelled_operator_ports(self):
        self.db.execute("""INSERT INTO field_probes
          (id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes)
          VALUES(?,?,?,?,?,?,?,?)""",
          ('field-one','node-1','mci',443,1,1000,1024,1024))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""INSERT INTO field_probes
              (id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes)
              VALUES(?,?,?,?,?,?,?,?)""",
              ('field-two','node-1','irancell',443,1,1000,1024,1024))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""INSERT INTO field_probes
              (id,node_id,operator,port,revision,observed_ms,upload_bytes,download_bytes)
              VALUES(?,?,?,?,?,?,?,?)""",
              ('field-three','node-1','irancell',8443,1,1000,0,1024))

    def test_rotating_customer_uuid_revokes_old_node_ack(self):
        self.db.execute("""INSERT INTO subscription_credentials
            (subscription_id,ciphertext_b64,nonce_b64,key_version)
            VALUES('sub-1',?,?,1)""",('A'*40,'B'*16))
        self.db.execute("""INSERT INTO node_client_acks
            (node_id,subscription_id,revision,credential_sha256,observed_ms)
            VALUES('node-1','sub-1',1,?,1000)""",('c'*64,))
        self.db.execute("""UPDATE subscription_credentials
            SET ciphertext_b64=? WHERE subscription_id='sub-1'""",('D'*40,))
        count=self.db.execute("""SELECT count(*) FROM node_client_acks
            WHERE subscription_id='sub-1'""").fetchone()[0]
        self.assertEqual(count,0)

if __name__=='__main__':
    unittest.main()

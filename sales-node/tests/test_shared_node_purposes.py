import pathlib,sqlite3

def test_same_node_can_serve_sale_and_trial_without_losing_old_assignment():
    db=sqlite3.connect(':memory:')
    root=pathlib.Path(__file__).parents[2]/'apps/sales-bot/migrations'
    for path in sorted(root.glob('*.sql')):
        if path.name.startswith('0005'):continue
        db.executescript(path.read_text())
    db.execute("INSERT INTO nodes(id,name,target_ip) VALUES('personal','Personal','1.1.1.1')")
    db.execute("INSERT INTO node_purposes VALUES('sale','personal')")
    for path in sorted(root.glob('0005*.sql')):db.executescript(path.read_text())
    db.execute("INSERT INTO node_purposes VALUES('trial','personal')")
    assert db.execute('SELECT purpose FROM node_purposes ORDER BY purpose').fetchall()==[('sale',),('trial',)]

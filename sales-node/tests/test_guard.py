import guard

def fresh_frontend(clients=None):
 return {'inbounds':[{'listen':'0.0.0.0','port':443,'protocol':'vless','settings':{'clients':clients or [],'decryption':'none'},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'serverNames':['www.cloudflare.com'],'shortIds':['abcd'],'privateKey':'private'}}}]}

def test_fresh_zero_user_shared_frontend_marker_is_authorized():
 config={'nodeId':'node','shared443':True,'frontendManaged':True}
 marker={'mode':'shared-frontend','nodeId':'node'}
 assert guard.guard_allowed(config,marker,fresh_frontend(),100)

def test_frontend_marker_never_authorizes_non_shared_runtime():
 marker={'mode':'shared-frontend','nodeId':'node'}
 assert not guard.guard_allowed({'nodeId':'node'},marker,fresh_frontend(),100)

def test_frontend_only_guard_rejects_static_managed_client():
 config={'nodeId':'node','shared443':True,'frontendManaged':True}
 marker={'mode':'shared-frontend','nodeId':'node'}
 client={'id':'11111111-1111-4111-8111-111111111111','email':'madar-20000','flow':''}
 assert not guard.guard_allowed(config,marker,fresh_frontend([client]),100)

def test_legacy_authorization_requires_unexpired_nonempty_clients():
 config={}
 frontend=None
 assert guard.guard_allowed(config,{'expiresAt':200,'clients':[{'id':'x'}]},frontend,100)
 assert not guard.guard_allowed(config,{'expiresAt':100,'clients':[{'id':'x'}]},frontend,100)
 assert not guard.guard_allowed(config,{'expiresAt':200,'clients':[]},frontend,100)

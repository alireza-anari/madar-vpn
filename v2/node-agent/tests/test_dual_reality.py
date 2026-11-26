import copy
import unittest
from agent.dual_reality import dual_config,CAPABILITIES,authorize
from agent.reconciler import ReconcileError
UID="123e4567-e89b-42d3-a456-426614174000"
def baseline():
    a={"tag":"madar-reality","listen":"0.0.0.0","port":8443,"protocol":"vless",
       "settings":{"users":[{"id":UID,"flow":"xtls-rprx-vision"}]},
       "streamSettings":{"network":"raw","security":"reality",
                         "realitySettings":{"privateKey":"A"*43}}}
    b={"tag":"madar-ws-loopback","listen":"127.0.0.1","port":10443,
       "protocol":"vless","streamSettings":{"network":"ws"}}
    return {"inbounds":[a,b],"outbounds":[{"protocol":"freedom","tag":"direct"}]}
class DualTests(unittest.TestCase):
    def test_preserves_existing_8443_and_all_user_keys(self):
        before=baseline();saved=copy.deepcopy(before)
        after=dual_config(before)
        self.assertEqual(before,saved)
        self.assertEqual(after["inbounds"][0],saved["inbounds"][0])
        self.assertEqual([x["port"] for x in after["inbounds"]],[8443,443])
        self.assertEqual([x["tag"] for x in after["inbounds"]],
                         ["madar-reality","madar-reality-mci"])
        self.assertEqual(after["inbounds"][0]["settings"],after["inbounds"][1]["settings"])
        self.assertEqual(after["inbounds"][0]["streamSettings"],after["inbounds"][1]["streamSettings"])
    def test_refuses_unexpected_ports_or_transport(self):
        for edit in (lambda x:x["inbounds"][0].update(port=443),
                     lambda x:x["inbounds"][0]["streamSettings"].update(security="tls"),
                     lambda x:x["inbounds"][1].update(listen="0.0.0.0"),
                     lambda x:x["inbounds"].append({"tag":"other","port":22}),
                     lambda x:x["inbounds"][0]["settings"].update(users=[])):
            x=baseline();edit(x)
            with self.assertRaises(ReconcileError):dual_config(x)
    def test_only_limited_port_capability_and_test_node(self):
        self.assertIn("CapabilityBoundingSet=CAP_NET_BIND_SERVICE",CAPABILITIES)
        self.assertNotIn("PRIVATE KEY",CAPABILITIES)
        for node,ip in (("Node1","86.54.42.66"),("test-aria01","1.1.1.1")):
            with self.assertRaisesRegex(ReconcileError,"dedicated Aria"):
                authorize(None,node,ip)
if __name__=="__main__":unittest.main()

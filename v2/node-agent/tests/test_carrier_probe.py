import socket
import struct
import unittest
from agent.carrier_probe import decode_ipv4_tcp,capture_counts,PORTS

def packet(src_port,dst_port,flags,payload=b"",ip_proto=6,fragment=0):
    eth=b"\x00"*12+struct.pack("!H",0x0800)
    total=20+20+len(payload)
    ip=(bytes([0x45,0,])+struct.pack("!H",total)+b"\x00\x00"+
        struct.pack("!H",fragment)+bytes([64,ip_proto])+b"\x00\x00"+
        bytes([198,51,100,2,86,54,42,66]))
    tcp=(struct.pack("!HHII",src_port,dst_port,0,0)+
         bytes([0x50,flags])+b"\x00\x00\x00\x00\x00\x00")
    return eth+ip+tcp+payload

class CarrierPassiveTests(unittest.TestCase):
    def test_inbound_443_and_8443(self):
        self.assertEqual(decode_ipv4_tcp(packet(50000,443,0x02),"in"),(443,"in_syn"))
        self.assertEqual(decode_ipv4_tcp(packet(50000,8443,0x10),"in"),(8443,"in_ack"))
        self.assertEqual(decode_ipv4_tcp(packet(50000,443,0x18,b"hello"),"in"),(443,"in_data_segments"))
        self.assertEqual(decode_ipv4_tcp(packet(443,50000,0x12),"out"),(443,"out_synack"))
        self.assertEqual(decode_ipv4_tcp(packet(443,50000,0x18,b"world"),"out"),(443,"out_data_segments"))

    def test_ignore_unrelated_and_malformed(self):
        self.assertIsNone(decode_ipv4_tcp(packet(50000,22,0x02),"in"))
        self.assertIsNone(decode_ipv4_tcp(packet(50000,443,0x02,ip_proto=17),"in"))
        self.assertIsNone(decode_ipv4_tcp(packet(50000,443,0x02,fragment=0x2000),"in"))
        self.assertIsNone(decode_ipv4_tcp(b"no packets","in"))
        self.assertIsNone(decode_ipv4_tcp(packet(443,50000,0x12),"in"))
        self.assertIsNone(decode_ipv4_tcp(packet(50000,443,0x02),"other"))

    def test_no_IP_private_credential_or_payload_in_report(self):
        class Fake:
            def __init__(self):self.iter=iter([
                (packet(43210,443,0x02),("eth0",0,0)),
                (packet(443,43210,0x12),("eth0",0,4)),
                (packet(43210,443,0x18,b"SECRET_DO_NOT_SHOW"),("eth0",0,0)),
            ])
            def settimeout(self,*args):pass
            def recvfrom(self,*args):
                try:return next(self.iter)
                except StopIteration:raise socket.timeout
            def close(self):pass
        t=iter([0,0,0,0,12])
        result=capture_counts(duration=10,socket_factory=lambda *args:Fake(),now=lambda:next(t))
        import json
        body=json.dumps(result)
        self.assertNotIn("SECRET_DO_NOT_SHOW",body)
        self.assertNotIn("198.51.100",body)
        self.assertNotIn("43210",body)
        self.assertEqual(result["ports"]["443"]["in_syn"],1)
        self.assertEqual(result["ports"]["443"]["out_synack"],1)
        self.assertEqual(result["ports"]["443"]["in_data_segments"],1)
        self.assertFalse(result["carrier_verified"])
if __name__=="__main__":unittest.main()

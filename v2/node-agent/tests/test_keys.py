import base64
import os
import stat
import tempfile
import unittest
from agent.keys import derive_node_secret,write_node_secret

class KeyTests(unittest.TestCase):
    def test_matches_webcrypto_hkdf_test_vector(self):
        key=derive_node_secret(bytes([37])*32,"node_01")
        self.assertEqual(base64.urlsafe_b64encode(key).rstrip(b"=").decode(),
                         "V_0jBHeY1k48nlTMDSlzNDU_BiVYTZwlA0RWvY6KC7s")
        self.assertNotEqual(key,derive_node_secret(bytes([37])*32,"node_02"))

    def test_keyfile_created_exclusively_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path=os.path.join(folder,"node.key")
            write_node_secret(path,b"X"*32)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode),0o600)
            with self.assertRaises(FileExistsError):
                write_node_secret(path,b"Y"*32)

    def test_invalid_nodes_or_master_rejected(self):
        with self.assertRaises(ValueError):
            derive_node_secret(b"short","node_01")
        with self.assertRaises(ValueError):
            derive_node_secret(bytes([1])*32,"../../root")

if __name__=="__main__":
    unittest.main()

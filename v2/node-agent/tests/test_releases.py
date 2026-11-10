import hashlib
import io
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from agent import releases

def zip_binary(content=b"BINARY"):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w") as zipout:
        zipout.writestr("xray",content)
    return stream.getvalue()

def tar_binary(content=b"BINARY",name="caddy",typecode=None):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode="w:gz") as tarout:
        info=tarfile.TarInfo(name)
        if typecode is not None: info.type=typecode
        if typecode is None: info.size=len(content)
        tarout.addfile(info,io.BytesIO(content) if typecode is None else None)
    return stream.getvalue()

class PinnedReleasesTests(unittest.TestCase):
    def test_pins_are_sha256_and_https_only(self):
        for arch in ("amd64","arm64"):
            for url,digest,kind in releases.PINS[arch].values():
                self.assertTrue(url.startswith("https://github.com/"))
                self.assertEqual(len(digest),64)
                self.assertIn(kind,("zip","tar.gz"))
        self.assertEqual(releases.host_arch("x86_64"),"amd64")
        self.assertEqual(releases.host_arch("aarch64"),"arm64")
        with self.assertRaises(releases.ReleaseError):
            releases.host_arch("ppc64")

    def test_checksum_mismatch_is_fatal_before_extraction(self):
        with self.assertRaisesRegex(releases.ReleaseError,"SHA256 mismatch"):
            releases.verified_release("xray","amd64",lambda url: zip_binary())

    def test_zip_and_tar_validation_extracts_only_fixed_member(self):
        self.assertEqual(releases._extract_binary(zip_binary(),"zip","xray"),b"BINARY")
        self.assertEqual(releases._extract_binary(tar_binary(),"tar.gz","caddy"),b"BINARY")
        with self.assertRaises(releases.ReleaseError):
            releases._extract_binary(tar_binary(name="../caddy"),"tar.gz","caddy")
        with self.assertRaises(releases.ReleaseError):
            releases._extract_binary(tar_binary(typecode=tarfile.SYMTYPE),"tar.gz","caddy")
        with self.assertRaises(releases.ReleaseError):
            releases._extract_binary(zip_binary(),"zip","not-xray")

    def test_executables_are_atomic_and_not_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            path=releases.place_executable(root,"xray",b"one")
            self.assertEqual(path.read_bytes(),b"one")
            self.assertEqual(path.stat().st_mode&0o777,0o755)
            with self.assertRaises(releases.ReleaseError):
                releases.place_executable(root,"xray",b"two")
            self.assertEqual(path.read_bytes(),b"one")
            with self.assertRaises(releases.ReleaseError):
                releases.place_executable(root,"../xray",b"two")

if __name__=="__main__":
    unittest.main()

"""CI acceptance against verified pinned Xray, never a system executable."""
import os,pathlib,subprocess,sys,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'sales-runner'))
from artifacts import download,VERSION
with tempfile.TemporaryDirectory() as temp:
    base=pathlib.Path(temp)
    for name,data in download('x86_64',VERSION).items():(base/name).write_bytes(data)
    binary=base/'xray';binary.chmod(0o700)
    subprocess.run([sys.executable,str(ROOT/'sales-node/tests/probe_live_stats.py'),str(binary),'23450'],check=True,timeout=35)

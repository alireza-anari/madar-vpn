import ast,hashlib,json,pathlib,re
ROOT=pathlib.Path(__file__).resolve().parents[2]
def test_bootstrap_source_manifest_matches_packaged_sources():
    source=(ROOT/'sales-runner/bootstrap.sh').read_text();manifest=ast.literal_eval(re.search(r'^manifest=(\{.*\})$',source,re.M).group(1))
    for name,digest in manifest.items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest,name
    for name in ('stats.py','quota.py','quota_runtime.py','update_owned.py'):assert 'sales-node/'+name in manifest

def test_owned_updater_manifest_matches_all_modules():
    manifest=json.loads((ROOT/'sales-node/source-manifest.json').read_text())
    for name,digest in manifest.items():assert hashlib.sha256((ROOT/'sales-node'/name).read_bytes()).hexdigest()==digest,name

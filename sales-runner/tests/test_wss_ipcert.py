"""Fail-closed tests for independent public IP-SAN WSS certificate preparation."""
import pytest

from wss_ipcert import ipcert_paths, parse_preparation, preparation_script, validate_ip


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "0.0.0.0", "10.0.0.1", "192.168.0.1",
    "169.254.5.3", "198.51.100.1", "203.0.113.42",
    "example.org", "8.8.8.8; rm -rf /", "8.8.8.8/24",
])
def test_reject_private_or_untrusted_ip(ip):
    with pytest.raises(ValueError, match="WSS_INVALID_PUBLIC_IP"):
        validate_ip(ip)


def test_ip_certificate_payload_requires_exact_attestation():
    assert validate_ip("8.8.8.8") == "8.8.8.8"
    script = preparation_script("8.8.8.8")
    assert "--preferred-profile','shortlived" in script
    assert "--ip-address',ip" in script
    assert "for port in (80,2087)" in script
    assert "ssl.cert_time_to_seconds" in script
    assert "systemctl" not in script
    paths = ipcert_paths("8.8.8.8")
    assert paths == {
        "wssIpAddress": "8.8.8.8",
        "wssTlsCert": "/etc/letsencrypt/live/8.8.8.8/fullchain.pem",
        "wssTlsKey": "/etc/letsencrypt/live/8.8.8.8/privkey.pem",
    }
    result = '{"verified":true,"ip":"8.8.8.8","port":2087}'
    assert parse_preparation(result,"8.8.8.8") == paths
    for value in [
        '{"verified":false,"ip":"8.8.8.8","port":2087}',
        '{"verified":true,"ip":"1.1.1.1","port":2087}',
        '{"verified":true,"ip":"8.8.8.8","port":443}',
        '{"verified":true,"ip":"8.8.8.8","port":2087,"extra":"x"}',
        'INSTALLED',
    ]:
        with pytest.raises(ValueError, match="WSS_CERT_NOT_VERIFIED"):
            parse_preparation(value,"8.8.8.8")

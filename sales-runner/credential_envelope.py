"""Hybrid browser RSA-OAEP/AES-GCM envelope; no persistent plaintext."""
import base64,json
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def decrypt_credentials(encrypted,private_key,now,expires_at):
    if now>=expires_at:raise ValueError('CREDENTIALS_EXPIRED')
    try:
        data=json.loads(encrypted)
        if data['v']!=1:raise ValueError()
        decode=lambda key:base64.b64decode(data[key],validate=True)
        iv=decode('iv')
        if len(iv)!=12:raise ValueError()
        aes=private_key.decrypt(decode('key'),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
        value=json.loads(AESGCM(aes).decrypt(iv,decode('data'),None))
        if value.get('method') not in ('key','password'):raise ValueError()
        return value
    except Exception:raise ValueError('INVALID_CREDENTIAL_ENVELOPE') from None

"""Pinned, independently verified release loader for an isolated Madar test VPS.

Only two audited official release URLs (per architecture) are accepted.
Never extract arbitrary archive members or execute downloaded install scripts.
"""
import hashlib
import io
import os
import platform
import stat
import tarfile
import tempfile
import urllib.request
import urllib.parse
import zipfile
from pathlib import Path

MAX_DOWNLOAD_BYTES=70*1024*1024
MAX_BINARY_BYTES=65*1024*1024
X_VER="v26.11.9"
C_VER="v2.11.9"
# Executable digests extracted only after verifying the official archive pins.
XRAY_BINARY_SHA256={
    'amd64':'e87bce586acdb9136aa5b1f1d9c8db9f1ea1d145b6d86368c7f6f662f9f6a66d',
    'arm64':'c2d1e66a130556d32089adcf38202fcb6f9027e41fb456cc2cda9a5fabdc093a',
}
PINS={
    "amd64":{
        "xray":("https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip",
                "b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82","zip"),
        "caddy":("https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz",
                 "5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb","tar.gz"),
    },
    "arm64":{
        "xray":("https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-arm64-v8a.zip",
                "64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be","zip"),
        "caddy":("https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_arm64.tar.gz",
                 "5e377cff994fc9362a6fcf695c53f226cfca3a3ef85bd3a3687cf252d6310165","tar.gz"),
    },
}


class ReleaseError(RuntimeError):
    pass


def host_arch(machine=None):
    machine=(machine or platform.machine()).lower()
    result={"x86_64":"amd64","amd64":"amd64","aarch64":"arm64","arm64":"arm64"}.get(machine)
    if result is None:
        raise ReleaseError("unsupported CPU architecture")
    return result


def _get(url):
    request=urllib.request.Request(url,headers={"User-Agent":"Madar-V2-TestNode/1"})
    with urllib.request.urlopen(request,timeout=45) as response:
        final=urllib.parse.urlsplit(response.geturl())
        if final.scheme!="https" or not final.hostname:
            raise ReleaseError("release redirect must remain HTTPS")
        raw=response.read(MAX_DOWNLOAD_BYTES+1)
    if not raw or len(raw)>MAX_DOWNLOAD_BYTES:
        raise ReleaseError("release archive exceeds bounded size")
    return raw


def xray_binary_sha256():
    return XRAY_BINARY_SHA256[host_arch()]


def _extract_binary(archive,kind,member):
    try:
        if kind=="zip":
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                files=[i for i in z.infolist() if i.filename==member]
                if len(files)!=1 or files[0].is_dir() or not 0<files[0].file_size<=MAX_BINARY_BYTES:
                    raise ReleaseError("missing or oversized pinned executable")
                with z.open(files[0]) as stream:
                    result=stream.read(MAX_BINARY_BYTES+1)
        elif kind=="tar.gz":
            with tarfile.open(fileobj=io.BytesIO(archive),mode="r:gz") as tf:
                files=[i for i in tf.getmembers() if i.name in (member,"./"+member)]
                if len(files)!=1 or not files[0].isfile() or not 0<files[0].size<=MAX_BINARY_BYTES:
                    raise ReleaseError("missing or unsafe pinned executable")
                stream=tf.extractfile(files[0])
                if stream is None:
                    raise ReleaseError("executable not regular file")
                result=stream.read(MAX_BINARY_BYTES+1)
        else:
            raise ReleaseError("invalid release archive format")
    except (OSError,ValueError,zipfile.BadZipFile,tarfile.TarError) as exc:
        raise ReleaseError("invalid pinned release archive") from exc
    if not result or len(result)>MAX_BINARY_BYTES:
        raise ReleaseError("extracted executable exceeds bound")
    return result


def verified_release(component,arch=None,downloader=_get):
    arch=arch or host_arch()
    if arch not in PINS or component not in ("xray","caddy"):
        raise ReleaseError("unsupported pinned release")
    url,expected,kind=PINS[arch][component]
    content=downloader(url)
    if not isinstance(content,bytes) or not content:
        raise ReleaseError("invalid archive download")
    if hashlib.sha256(content).hexdigest()!=expected:
        raise ReleaseError("release SHA256 mismatch; refusing installation")
    data=_extract_binary(content,kind,component)
    return data,hashlib.sha256(data).hexdigest()


def place_executable(directory,name,data):
    if name not in ("xray","caddy") or not isinstance(data,bytes) or not data:
        raise ReleaseError("unexpected binary")
    dest=Path(directory)
    info=dest.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022 or dest.is_symlink():
        raise ReleaseError("binary directory must be a non-symlink safe directory")
    target=dest/name
    if target.exists() or target.is_symlink():
        raise ReleaseError("refusing to overwrite existing binary")
    fd,p=tempfile.mkstemp(prefix="."+name+"-",dir=dest)
    try:
        os.fchmod(fd,0o755)
        with os.fdopen(fd,"wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(p,target)
        return target
    finally:
        if os.path.exists(p): os.unlink(p)

# Third-party software notices

Madar V2 Android packages an XTLS/libXray Android AAR built from pinned
upstream source in CI with one Madar-specific Android TUN FD binding extension. The exact source revision is pinned in
\`.github/workflows/v2-checks.yml\`.

## XTLS/libXray

- Version: \`v26.11.9\`
- Commit: \`5a0f7d8d1c28b34afb5727b04b26a10f6dbac7e3\`
- License: MIT
- Source: https://github.com/XTLS/libXray/tree/v26.11.9
- License text: \`licenses/MIT-libXray.txt\`

## XTLS/Xray-core

- Version embedded by the pinned libXray release: \`v26.11.9\`
- License: Mozilla Public License 2.0 (MPL-2.0)
- Source: https://github.com/XTLS/Xray-core/tree/v26.11.9
- License text: \`licenses/MPL-2.0-Xray-core.txt\`

The MPL-2.0-covered source form and modifications must remain available under
MPL-2.0 when distributing the executable form. This repository points to the
exact upstream source revision and preserves the complete license text.
A full transitive Go-module license inventory and attribution review is still
a release gate; this notice is not a substitute for that audit.

## Local Android TUN FD binding

The sole overlay is `v2/android/native-overlay/madar_tun_fd_android.go`, copied
into upstream libXray before `gomobile bind`. It exports `SetTunFd` and
`ResetTunFd`, which use Go `os.Setenv` / `os.Unsetenv`. This ensures Xray-core's
Android TUN inbound receives the `xray.tun.fd` value through `os.LookupEnv`.
The upstream commit remains pinned and the overlay is always available as source.

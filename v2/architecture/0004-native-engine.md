# Android native VPN engine integration decision

**Status: guarded placeholder**, not a functional VPN yet.

- Native Android platform API: \`VpnService.prepare\` (user consent),
  \`VpnService.Builder.establish\` (creates TUN), \`protect(socket)\` for the
  transport socket, foreground service notification, \`onRevoke\` shutdown.
- Preferred vetted engine: Xray-core native TUN through pinned libXray
  gomobile AAR, to avoid building a custom VPN protocol or tun2socks shim.
  Xray-core is MPL-2.0. libXray warns its API is unstable; pin both versions
  and review complete dependency licenses before shipping.
- Currently the APK registers a VpnService but the **default native adapter
  refuses to start**, so no TUN is created and no traffic is intercepted.
  The connect button remains disabled in the UI.
- A production engine adapter must hand the Android TUN fd to Xray (Android
  \`xray.tun.fd\` semantics), protect control sockets to avoid recursive VPN
  routing, supply DNS/routing safely and surface a verified tunneled HTTPS
  probe before declaring \`Connected\`.
- Bind the exact AAR digest in CI; build arm64-v8a and x86_64 and run an
  instrumented Android end-to-end test for consent, shutdown, failover and
  process restart. Test real Irancell, MCI, Rightel and broadband clients.
- Do not declare the VPN release ready on a green unit test alone.

Primary references:
https://developer.android.com/reference/android/net/VpnService
https://github.com/XTLS/libXray
https://pkg.go.dev/github.com/xtls/xray-core/proxy/tun

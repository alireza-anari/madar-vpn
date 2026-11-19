//go:build android

package libXray

import (
	"errors"
	"os"
	"strconv"
)

// SetTunFd is a narrowly scoped Android extension to the pinned XTLS/libXray
// source. Xray-core's Android TUN inbound reads this OS environment key from
// Go code, not from a JSON config or Android's libc environment.
func SetTunFd(fd int) error {
	if fd <= 0 {
		return errors.New("invalid TUN file descriptor")
	}
	return os.Setenv("xray.tun.fd", strconv.Itoa(fd))
}

// ResetTunFd prevents a stopped VPN instance from retaining an old descriptor.
func ResetTunFd() error {
	return os.Unsetenv("xray.tun.fd")
}

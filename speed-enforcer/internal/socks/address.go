package socks

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
)

const (
	atypIPv4   = 0x01
	atypDomain = 0x03
	atypIPv6   = 0x04
)

type Address struct {
	ATYP byte
	Host string
	Port uint16
}

func readAddress(r io.Reader) (Address, error) {
	return readAddressWithZeroPort(r, false)
}

func readAddressWithZeroPort(r io.Reader, allowZeroPort bool) (Address, error) {
	var atyp [1]byte
	if _, err := io.ReadFull(r, atyp[:]); err != nil {
		return Address{}, err
	}
	var host string
	switch atyp[0] {
	case atypIPv4:
		buf := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(r, buf); err != nil {
			return Address{}, err
		}
		host = net.IP(buf).String()
	case atypIPv6:
		buf := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(r, buf); err != nil {
			return Address{}, err
		}
		host = net.IP(buf).String()
	case atypDomain:
		var length [1]byte
		if _, err := io.ReadFull(r, length[:]); err != nil {
			return Address{}, err
		}
		if length[0] == 0 {
			return Address{}, errors.New("empty domain")
		}
		buf := make([]byte, int(length[0]))
		if _, err := io.ReadFull(r, buf); err != nil {
			return Address{}, err
		}
		host = string(buf)
	default:
		return Address{}, fmt.Errorf("unsupported address type %d", atyp[0])
	}
	var portBytes [2]byte
	if _, err := io.ReadFull(r, portBytes[:]); err != nil {
		return Address{}, err
	}
	port := binary.BigEndian.Uint16(portBytes[:])
	if port == 0 && !allowZeroPort {
		return Address{}, errors.New("invalid zero port")
	}
	return Address{ATYP: atyp[0], Host: host, Port: port}, nil
}

func encodeAddress(a Address) ([]byte, error) {
	if a.Port == 0 {
		return nil, errors.New("invalid zero port")
	}
	out := []byte{a.ATYP}
	switch a.ATYP {
	case atypIPv4:
		ip := net.ParseIP(a.Host).To4()
		if ip == nil {
			return nil, errors.New("invalid IPv4 address")
		}
		out = append(out, ip...)
	case atypIPv6:
		ip := net.ParseIP(a.Host)
		if ip == nil || ip.To4() != nil {
			return nil, errors.New("invalid IPv6 address")
		}
		out = append(out, ip.To16()...)
	case atypDomain:
		if len(a.Host) == 0 || len(a.Host) > 255 {
			return nil, errors.New("invalid domain length")
		}
		out = append(out, byte(len(a.Host)))
		out = append(out, []byte(a.Host)...)
	default:
		return nil, errors.New("unsupported address type")
	}
	out = binary.BigEndian.AppendUint16(out, a.Port)
	return out, nil
}

func addressFromNetAddr(addr net.Addr) Address {
	host, portText, err := net.SplitHostPort(addr.String())
	if err != nil {
		return Address{ATYP: atypIPv4, Host: "127.0.0.1", Port: 1}
	}
	var port int
	_, _ = fmt.Sscanf(portText, "%d", &port)
	if port <= 0 || port > 65535 {
		port = 1
	}
	ip := net.ParseIP(host)
	if ip4 := ip.To4(); ip4 != nil {
		return Address{ATYP: atypIPv4, Host: ip4.String(), Port: uint16(port)}
	}
	if ip != nil {
		return Address{ATYP: atypIPv6, Host: ip.String(), Port: uint16(port)}
	}
	return Address{ATYP: atypDomain, Host: host, Port: uint16(port)}
}

package socks

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/alireza-anari/madar-vpn/speed-enforcer/internal/limit"
)

func startUDPEcho(t *testing.T, network, address string) (net.PacketConn, string) {
	t.Helper()
	pc, err := net.ListenPacket(network, address)
	if err != nil {
		t.Skipf("%s unavailable: %v", network, err)
	}
	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteTo(buf[:n], addr)
		}
	}()
	return pc, pc.LocalAddr().String()
}

func udpAssociate(t *testing.T, control net.Conn) Address {
	t.Helper()
	req := []byte{5, 3, 0, 1, 0, 0, 0, 0, 0, 0}
	if _, err := control.Write(req); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 3)
	if _, err := io.ReadFull(control, head); err != nil {
		t.Fatal(err)
	}
	if head[1] != 0 {
		t.Fatalf("UDP ASSOCIATE reply=%d", head[1])
	}
	a, err := readAddress(control)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func udpPacket(t *testing.T, frag byte, host string, port int, payload []byte) []byte {
	t.Helper()
	atyp := byte(3)
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() != nil {
			atyp = 1
		} else {
			atyp = 4
		}
	}
	addr, err := encodeAddress(Address{ATYP: atyp, Host: host, Port: uint16(port)})
	if err != nil {
		t.Fatal(err)
	}
	out := []byte{0, 0, frag}
	out = append(out, addr...)
	out = append(out, payload...)
	return out
}

func udpRoundTrip(t *testing.T, client *net.UDPConn, relay *net.UDPAddr, packet []byte) ([]byte, Address, error) {
	t.Helper()
	if _, err := client.WriteToUDP(packet, relay); err != nil {
		return nil, Address{}, err
	}
	_ = client.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 65535)
	n, _, err := client.ReadFromUDP(buf)
	if err != nil {
		return nil, Address{}, err
	}
	if n < 4 || buf[0] != 0 || buf[1] != 0 || buf[2] != 0 {
		return nil, Address{}, errors.New("malformed relay response")
	}
	r := bytes.NewReader(buf[3:n])
	a, err := readAddress(r)
	if err != nil {
		return nil, Address{}, err
	}
	payload, err := io.ReadAll(r)
	return payload, a, err
}

func newUDPAssociation(t *testing.T, cfgBurst int64) (net.Listener, net.Conn, *net.UDPConn, *net.UDPAddr, *instantClock) {
	t.Helper()
	clock := newInstantClock()
	cfg := serverConfig("opaque", "secret", cfgBurst)
	registry, err := limit.NewRegistry(cfg, clock)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(cfg, registry, nil, &captureLogger{})
	go func() { _ = s.Serve(ln) }()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if authenticate(t, c, "opaque", "secret") != 0 {
		t.Fatal("auth failed")
	}
	bound := udpAssociate(t, c)
	relay, err := net.ResolveUDPAddr("udp", net.JoinHostPort(bound.Host, strconv.Itoa(int(bound.Port))))
	if err != nil {
		t.Fatal(err)
	}
	udpClient, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	return ln, c, udpClient, relay, clock
}

func TestUDPAssociateIPv4RoundTripAndLimit(t *testing.T) {
	echo, target := startUDPEcho(t, "udp4", "127.0.0.1:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	ln, control, client, relay, clock := newUDPAssociation(t, 4)
	defer ln.Close()
	defer control.Close()
	defer client.Close()
	payload := []byte("hello")
	got, source, err := udpRoundTrip(t, client, relay, udpPacket(t, 0, host, port, payload))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("got=%q", got)
	}
	if source.Port != uint16(port) {
		t.Fatalf("source=%#v", source)
	}
	if clock.Slept() == 0 {
		t.Fatal("expected shared limiter to delay payload beyond burst")
	}
}

func TestUDPAssociateDomainDestination(t *testing.T) {
	v6, target := startUDPEcho(t, "udp6", "[::1]:0")
	defer v6.Close()
	_, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	v4, err := net.ListenPacket("udp4", net.JoinHostPort("127.0.0.1", portText))
	if err == nil {
		defer v4.Close()
		go func() {
			buf := make([]byte, 65535)
			for {
				n, a, e := v4.ReadFrom(buf)
				if e != nil {
					return
				}
				_, _ = v4.WriteTo(buf[:n], a)
			}
		}()
	}
	ln, control, client, relay, _ := newUDPAssociation(t, 64)
	defer ln.Close()
	defer control.Close()
	defer client.Close()
	payload := []byte("domain")
	got, _, err := udpRoundTrip(t, client, relay, udpPacket(t, 0, "localhost", port, payload))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("got=%q", got)
	}
}

func TestUDPAssociateIPv6Destination(t *testing.T) {
	echo, target := startUDPEcho(t, "udp6", "[::1]:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	ln, control, client, relay, _ := newUDPAssociation(t, 64)
	defer ln.Close()
	defer control.Close()
	defer client.Close()
	payload := []byte("ipv6")
	got, _, err := udpRoundTrip(t, client, relay, udpPacket(t, 0, host, port, payload))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("got=%q", got)
	}
}

func TestUDPFragmentAndMalformedDatagramsAreDropped(t *testing.T) {
	echo, target := startUDPEcho(t, "udp4", "127.0.0.1:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	ln, control, client, relay, _ := newUDPAssociation(t, 64)
	defer ln.Close()
	defer control.Close()
	defer client.Close()
	for _, packet := range [][]byte{udpPacket(t, 1, host, port, []byte("frag")), {0, 0, 0, 1, 127}} {
		if _, err := client.WriteToUDP(packet, relay); err != nil {
			t.Fatal(err)
		}
		_ = client.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		buf := make([]byte, 32)
		if _, _, err := client.ReadFromUDP(buf); err == nil {
			t.Fatalf("invalid packet unexpectedly relayed: %v", packet)
		}
	}
}

func TestUDPAssociationClosesWithAuthenticatedControlConnection(t *testing.T) {
	echo, target := startUDPEcho(t, "udp4", "127.0.0.1:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	ln, control, client, relay, _ := newUDPAssociation(t, 64)
	defer ln.Close()
	defer client.Close()
	_ = control.Close()
	time.Sleep(40 * time.Millisecond)
	_, err := client.WriteToUDP(udpPacket(t, 0, host, port, []byte("orphan")), relay)
	if err != nil {
		return
	}
	_ = client.SetReadDeadline(time.Now().Add(120 * time.Millisecond))
	buf := make([]byte, 64)
	if _, _, err := client.ReadFromUDP(buf); err == nil {
		t.Fatal("orphan UDP remained authorized after control close")
	}
}

func TestTCPAndUDPConsumeSameAliasUploadBucket(t *testing.T) {
	clock := newInstantClock()
	cfg := serverConfig("opaque", "secret", 4)
	registry, _ := limit.NewRegistry(cfg, clock)
	if err := registry.WaitUpload(context.Background(), "opaque", 4); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	s := NewServer(cfg, registry, nil, &captureLogger{})
	go func() { _ = s.Serve(ln) }()
	control, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	if authenticate(t, control, "opaque", "secret") != 0 {
		t.Fatal("auth failed")
	}
	bound := udpAssociate(t, control)
	relay, _ := net.ResolveUDPAddr("udp", net.JoinHostPort(bound.Host, strconv.Itoa(int(bound.Port))))
	client, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	echo, target := startUDPEcho(t, "udp4", "127.0.0.1:0")
	defer echo.Close()
	host, portText, _ := net.SplitHostPort(target)
	port, _ := strconv.Atoi(portText)
	before := clock.Slept()
	if _, _, err := udpRoundTrip(t, client, relay, udpPacket(t, 0, host, port, []byte("x"))); err != nil {
		t.Fatal(err)
	}
	if clock.Slept() <= before {
		t.Fatal("UDP did not consume the already-exhausted shared upload bucket")
	}
}

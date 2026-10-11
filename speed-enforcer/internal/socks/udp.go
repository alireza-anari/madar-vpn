package socks

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

const maxUDPDatagram = 65535

type udpAssociation struct {
	server *Server
	alias  string
	relay  *net.UDPConn
	up4    *net.UDPConn
	up6    *net.UDPConn
	mu     sync.RWMutex
	client *net.UDPAddr
	touch  chan struct{}
}

func (s *Server) handleUDPAssociation(control net.Conn, alias string) error {
	relay, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		return err
	}
	up4, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		relay.Close()
		return err
	}
	up6, _ := net.ListenUDP("udp6", &net.UDPAddr{IP: net.IPv6zero, Port: 0})
	assoc := &udpAssociation{server: s, alias: alias, relay: relay, up4: up4, up6: up6, touch: make(chan struct{}, 1)}
	defer relay.Close()
	defer up4.Close()
	if up6 != nil {
		defer up6.Close()
	}
	if err := writeReply(control, 0x00, addressFromNetAddr(relay.LocalAddr())); err != nil {
		return err
	}
	if err := control.SetDeadline(time.Time{}); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{}, 1)
	go func() {
		assoc.relayLoop(ctx)
		select {
		case done <- struct{}{}:
		default:
		}
	}()
	go assoc.upstreamLoop(ctx, up4)
	if up6 != nil {
		go assoc.upstreamLoop(ctx, up6)
	}
	controlDone := make(chan struct{}, 1)
	go func() {
		var one [1]byte
		_, _ = control.Read(one[:])
		select {
		case controlDone <- struct{}{}:
		default:
		}
	}()
	idle := s.udpIdleTimeout
	if idle <= 0 {
		idle = 120 * time.Second
	}
	timer := time.NewTimer(idle)
	defer timer.Stop()
	for {
		select {
		case <-controlDone:
			return nil
		case <-done:
			return nil
		case <-assoc.touch:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idle)
		case <-timer.C:
			return nil
		}
	}
}

func (a *udpAssociation) relayLoop(ctx context.Context) {
	buf := make([]byte, maxUDPDatagram)
	for {
		n, from, err := a.relay.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if !from.IP.IsLoopback() {
			continue
		}
		if !a.acceptClient(from) {
			continue
		}
		a.signalActivity()
		packet := append([]byte(nil), buf[:n]...)
		a.handleClientDatagram(ctx, packet)
	}
}

func (a *udpAssociation) acceptClient(from *net.UDPAddr) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client == nil {
		a.client = cloneUDPAddr(from)
		return true
	}
	return a.client.Port == from.Port && a.client.IP.Equal(from.IP)
}

func cloneUDPAddr(in *net.UDPAddr) *net.UDPAddr {
	if in == nil {
		return nil
	}
	ip := append(net.IP(nil), in.IP...)
	return &net.UDPAddr{IP: ip, Port: in.Port, Zone: in.Zone}
}

func (a *udpAssociation) handleClientDatagram(ctx context.Context, packet []byte) {
	if len(packet) < 4 || packet[0] != 0 || packet[1] != 0 || packet[2] != 0 {
		return
	}
	r := bytes.NewReader(packet[3:])
	target, err := readAddress(r)
	if err != nil {
		return
	}
	payload, err := io.ReadAll(r)
	if err != nil || len(payload) == 0 {
		return
	}
	burst, err := a.server.registry.UploadBurst(a.alias)
	if err != nil || waitPayload(ctx, len(payload), burst, func(n int) error { return a.server.registry.WaitUpload(ctx, a.alias, n) }) != nil {
		return
	}
	ips := resolveTarget(ctx, target.Host)
	for _, ip := range ips {
		remote := &net.UDPAddr{IP: ip, Port: int(target.Port)}
		var conn *net.UDPConn
		if ip.To4() != nil {
			conn = a.up4
		} else {
			conn = a.up6
		}
		if conn == nil {
			continue
		}
		if _, err := conn.WriteToUDP(payload, remote); err == nil {
			return
		}
	}
}

func resolveTarget(ctx context.Context, host string) []net.IP {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}
	}
	items, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil
	}
	out := make([]net.IP, 0, len(items))
	for _, item := range items {
		out = append(out, item.IP)
	}
	return out
}

func (a *udpAssociation) upstreamLoop(ctx context.Context, conn *net.UDPConn) {
	buf := make([]byte, maxUDPDatagram)
	for {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		a.mu.RLock()
		client := cloneUDPAddr(a.client)
		a.mu.RUnlock()
		if client == nil || n == 0 {
			continue
		}
		burst, err := a.server.registry.DownloadBurst(a.alias)
		if err != nil || waitPayload(ctx, n, burst, func(size int) error { return a.server.registry.WaitDownload(ctx, a.alias, size) }) != nil {
			continue
		}
		atyp := byte(atypIPv6)
		host := from.IP.String()
		if from.IP.To4() != nil {
			atyp = atypIPv4
			host = from.IP.To4().String()
		}
		encoded, err := encodeAddress(Address{ATYP: atyp, Host: host, Port: uint16(from.Port)})
		if err != nil {
			continue
		}
		packet := make([]byte, 0, 3+len(encoded)+n)
		packet = append(packet, 0, 0, 0)
		packet = append(packet, encoded...)
		packet = append(packet, buf[:n]...)
		if _, err := a.relay.WriteToUDP(packet, client); err == nil {
			a.signalActivity()
		}
	}
}

func (a *udpAssociation) signalActivity() {
	select {
	case a.touch <- struct{}{}:
	default:
	}
}

func waitPayload(ctx context.Context, total int, burst int64, wait func(int) error) error {
	if total < 0 || burst <= 0 {
		return errors.New("invalid limiter request")
	}
	remaining := total
	for remaining > 0 {
		chunk := remaining
		if int64(chunk) > burst {
			chunk = int(burst)
		}
		if err := wait(chunk); err != nil {
			return err
		}
		remaining -= chunk
	}
	return nil
}

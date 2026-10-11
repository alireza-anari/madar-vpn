package socks

import (
	"bytes"
	"encoding/binary"
	"net"
	"testing"
)

func TestReadAddressIPv4(t *testing.T) {
	raw := []byte{0x01, 127, 0, 0, 1, 0x1f, 0x90}
	a, err := readAddress(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if a.Host != "127.0.0.1" || a.Port != 8080 || a.ATYP != 0x01 {
		t.Fatalf("address = %#v", a)
	}
	encoded, err := encodeAddress(a)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, raw) {
		t.Fatalf("encoded = %v want %v", encoded, raw)
	}
}

func TestReadAddressIPv6(t *testing.T) {
	ip := net.ParseIP("2001:db8::1").To16()
	raw := append([]byte{0x04}, ip...)
	raw = binary.BigEndian.AppendUint16(raw, 443)
	a, err := readAddress(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if net.ParseIP(a.Host).String() != "2001:db8::1" || a.Port != 443 || a.ATYP != 0x04 {
		t.Fatalf("address = %#v", a)
	}
	encoded, err := encodeAddress(a)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, raw) {
		t.Fatalf("encoded mismatch")
	}
}

func TestReadAddressDomain(t *testing.T) {
	raw := append([]byte{0x03, 11}, []byte("example.com")...)
	raw = binary.BigEndian.AppendUint16(raw, 53)
	a, err := readAddress(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if a.Host != "example.com" || a.Port != 53 || a.ATYP != 0x03 {
		t.Fatalf("address = %#v", a)
	}
	encoded, err := encodeAddress(a)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, raw) {
		t.Fatalf("encoded mismatch")
	}
}

func TestReadAddressRejectsMalformed(t *testing.T) {
	cases := [][]byte{
		{0x03, 0, 0, 80},
		{0x02, 127, 0, 0, 1, 0, 80},
		{0x01, 127, 0, 0},
		{0x04, 0, 1},
		{0x03, 4, 'a', 'b'},
		{0x01, 127, 0, 0, 1, 0, 0},
	}
	for i, raw := range cases {
		if _, err := readAddress(bytes.NewReader(raw)); err == nil {
			t.Fatalf("case %d unexpectedly accepted", i)
		}
	}
}

func TestEncodeAddressRejectsOversizedDomainAndInvalidPort(t *testing.T) {
	if _, err := encodeAddress(Address{ATYP: 0x03, Host: string(bytes.Repeat([]byte{'a'}, 256)), Port: 80}); err == nil {
		t.Fatal("oversized domain accepted")
	}
	if _, err := encodeAddress(Address{ATYP: 0x03, Host: "example.com", Port: 0}); err == nil {
		t.Fatal("zero port accepted")
	}
}

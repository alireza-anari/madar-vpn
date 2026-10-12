#!/usr/bin/env bash
set -eu

usage() {
  echo "usage: $0 OUTPUT [GOOS] [GOARCH]" >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

output=$1
case "$output" in
  /*) ;;
  *) output="$(pwd)/$output" ;;
esac
goos=${2:-linux}

if [ "$goos" != "linux" ]; then
  echo "unsupported GOOS: $goos" >&2
  exit 2
fi

if [ "$#" -ge 3 ]; then
  goarch=$3
else
  case "$(uname -m)" in
    x86_64|amd64) goarch=amd64 ;;
    aarch64|arm64) goarch=arm64 ;;
    *)
      echo "unsupported host architecture: $(uname -m)" >&2
      exit 2
      ;;
  esac
fi

case "$goarch" in
  amd64|arm64) ;;
  *)
    echo "unsupported GOARCH: $goarch" >&2
    exit 2
    ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$(dirname -- "$output")"

cd "$root/speed-enforcer"
CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
  go build -trimpath -o "$output" ./cmd/madar-speed-enforcer

if [ ! -x "$output" ]; then
  echo "build did not produce an executable: $output" >&2
  exit 1
fi

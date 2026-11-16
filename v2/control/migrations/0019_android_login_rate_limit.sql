-- Short-lived per-IP challenge creation throttle; IP addresses are HMACed in Worker memory.
CREATE TABLE IF NOT EXISTS android_login_rate_limits (
  ip_hash TEXT NOT NULL CHECK(length(ip_hash) = 64),
  window_start_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count BETWEEN 1 AND 30),
  PRIMARY KEY(ip_hash, window_start_ms)
);

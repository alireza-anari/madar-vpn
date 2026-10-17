CREATE TABLE telegram_profiles(
  telegram_id TEXT PRIMARY KEY,
  username TEXT CHECK(username IS NULL OR length(username)<=64),
  first_name TEXT CHECK(first_name IS NULL OR length(first_name)<=128),
  last_name TEXT CHECK(last_name IS NULL OR length(last_name)<=128),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);

ALTER TABLE nodes ADD COLUMN max_allocated_bytes INTEGER CHECK(max_allocated_bytes IS NULL OR (max_allocated_bytes>0 AND max_allocated_bytes<=1000000000000000));

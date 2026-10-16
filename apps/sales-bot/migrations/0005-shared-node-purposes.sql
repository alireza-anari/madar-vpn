CREATE TABLE node_purposes_shared(purpose TEXT PRIMARY KEY CHECK(purpose IN ('sale','trial')),node_id TEXT NOT NULL REFERENCES nodes(id));
INSERT INTO node_purposes_shared(purpose,node_id) SELECT purpose,node_id FROM node_purposes;
DROP TABLE node_purposes;
ALTER TABLE node_purposes_shared RENAME TO node_purposes;

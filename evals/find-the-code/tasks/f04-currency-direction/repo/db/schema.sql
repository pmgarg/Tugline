-- tables of the shop
CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, first_name TEXT);
CREATE TABLE carts (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), updated_at TIMESTAMP, order_id TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), paid NUMERIC, created_at TIMESTAMP);
CREATE INDEX carts_updated ON carts(updated_at);

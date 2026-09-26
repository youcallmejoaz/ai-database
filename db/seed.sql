-- Demo schema for trying the agent locally: a small online shop.
-- Safe to re-run: drops and recreates its own tables.

DROP TABLE IF EXISTS order_items, orders, products, customers CASCADE;

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  country     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          serial PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  category    text NOT NULL,
  price       numeric(10, 2) NOT NULL CHECK (price >= 0),
  stock       integer NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE orders (
  id           serial PRIMARY KEY,
  customer_id  integer NOT NULL REFERENCES customers (id),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  ordered_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id    integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products (id),
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

COMMENT ON TABLE orders IS 'One row per checkout. Line items live in order_items.';
COMMENT ON COLUMN products.stock IS 'Units currently in the warehouse.';

INSERT INTO customers (name, email, country, created_at) VALUES
  ('Ada Obi',        'ada@example.com',     'Nigeria',        now() - interval '120 days'),
  ('Ben Carter',     'ben@example.com',     'United Kingdom', now() - interval '95 days'),
  ('Chen Wei',       'chen@example.com',    'Singapore',      now() - interval '80 days'),
  ('Diana Rossi',    'diana@example.com',   'Italy',          now() - interval '60 days'),
  ('Emeka Nwosu',    'emeka@example.com',   'Nigeria',        now() - interval '45 days'),
  ('Fatima Zahra',   'fatima@example.com',  'Morocco',        now() - interval '30 days'),
  ('Gabriel Silva',  'gabriel@example.com', 'Brazil',         now() - interval '14 days'),
  ('Hana Kim',       'hana@example.com',    'South Korea',    now() - interval '3 days');

INSERT INTO products (sku, name, category, price, stock) VALUES
  ('KB-001', 'Mechanical Keyboard',  'Accessories', 89.00,  40),
  ('MS-002', 'Wireless Mouse',       'Accessories', 29.50,  120),
  ('MN-003', '27" 4K Monitor',       'Displays',    349.99, 15),
  ('HD-004', 'Noise-cancelling Headphones', 'Audio', 199.00, 25),
  ('WC-005', 'HD Webcam',            'Video',       59.90,  0),
  ('DK-006', 'USB-C Dock',           'Accessories', 129.00, 30),
  ('SP-007', 'Bluetooth Speaker',    'Audio',       45.00,  60),
  ('LT-008', 'Laptop Stand',         'Accessories', 35.00,  80);

INSERT INTO orders (customer_id, status, ordered_at) VALUES
  (1, 'shipped',   now() - interval '100 days'),
  (1, 'paid',      now() - interval '10 days'),
  (2, 'shipped',   now() - interval '70 days'),
  (3, 'cancelled', now() - interval '50 days'),
  (3, 'shipped',   now() - interval '40 days'),
  (4, 'paid',      now() - interval '20 days'),
  (5, 'pending',   now() - interval '5 days'),
  (6, 'shipped',   now() - interval '25 days'),
  (7, 'paid',      now() - interval '7 days'),
  (8, 'pending',   now() - interval '1 day'),
  (1, 'pending',   now() - interval '2 hours');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 89.00),  (1, 2, 1, 29.50),
  (2, 3, 2, 349.99),
  (3, 4, 1, 199.00), (3, 7, 2, 45.00),
  (4, 5, 1, 59.90),
  (5, 6, 1, 129.00), (5, 8, 1, 35.00),
  (6, 1, 1, 89.00),  (6, 3, 1, 349.99),
  (7, 2, 3, 29.50),
  (8, 4, 1, 199.00),
  (9, 7, 1, 45.00),  (9, 8, 2, 35.00),
  (10, 6, 1, 129.00),
  (11, 2, 1, 29.50), (11, 5, 1, 59.90);

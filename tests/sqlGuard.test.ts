import { describe, expect, it } from "vitest";
import { checkSelect, checkWrite, SqlGuardError, withReturning } from "@/lib/sqlGuard";

async function rejected(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SqlGuardError);
    return (err as Error).message;
  }
  throw new Error("expected the SQL to be rejected");
}

describe("checkSelect", () => {
  it("accepts a plain SELECT and strips the trailing semicolon", async () => {
    await expect(checkSelect("  SELECT id, name FROM customers WHERE country = 'Nigeria';  ")).resolves.toEqual({
      sql: "SELECT id, name FROM customers WHERE country = 'Nigeria'",
    });
  });

  it("accepts CTEs, joins, aggregates, VALUES and safe size functions", async () => {
    await checkSelect("WITH t AS (SELECT customer_id, count(*) n FROM orders GROUP BY 1) SELECT * FROM t ORDER BY n DESC");
    await checkSelect("VALUES (1), (2)");
    await checkSelect("SELECT pg_size_pretty(pg_total_relation_size('orders'))");
  });

  it("rejects more than one statement", async () => {
    expect(await rejected(checkSelect("SELECT 1; DROP TABLE customers"))).toMatch(/exactly one/);
  });

  it("rejects writes, DDL and utility statements", async () => {
    expect(await rejected(checkSelect("DELETE FROM customers WHERE id = 1"))).toMatch(/propose_write/);
    expect(await rejected(checkSelect("DROP TABLE customers"))).toMatch(/Only SELECT/);
    expect(await rejected(checkSelect("SET statement_timeout = 0"))).toMatch(/Only SELECT/);
    expect(await rejected(checkSelect("COPY customers TO '/tmp/x'"))).toMatch(/Only SELECT/);
  });

  it("rejects data-modifying CTEs", async () => {
    expect(await rejected(checkSelect("WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d"))).toMatch(/Only SELECT/);
  });

  it("rejects SELECT INTO and row locks", async () => {
    expect(await rejected(checkSelect("SELECT * INTO copy FROM customers"))).toMatch(/INTO/);
    expect(await rejected(checkSelect("SELECT * FROM customers FOR UPDATE"))).toMatch(/FOR UPDATE/);
  });

  it("rejects side-effecting functions", async () => {
    expect(await rejected(checkSelect("SELECT pg_sleep(100)"))).toMatch(/pg_sleep/);
    expect(await rejected(checkSelect("SELECT pg_terminate_backend(123)"))).toMatch(/pg_terminate_backend/);
    expect(await rejected(checkSelect("SELECT * FROM dblink('host=x', 'delete from t') AS t(a int)"))).toMatch(/dblink/);
    expect(await rejected(checkSelect("SELECT query_to_xml('delete from t', true, true, '')"))).toMatch(/query_to_xml/);
    expect(await rejected(checkSelect("SELECT set_config('role', 'admin', false)"))).toMatch(/set_config/);
    expect(await rejected(checkSelect("SELECT nextval('orders_id_seq')"))).toMatch(/nextval/);
  });

  it("rejects SQL that does not parse, and empty SQL", async () => {
    expect(await rejected(checkSelect("SELEC * FROM x"))).toMatch(/does not parse/);
    expect(await rejected(checkSelect("   "))).toMatch(/empty/);
  });

  it("keeps only the statement text when a comment follows the semicolon", async () => {
    await expect(checkSelect("SELECT 1; -- trailing comment")).resolves.toEqual({ sql: "SELECT 1" });
  });
});

describe("checkWrite", () => {
  it("classifies INSERT, UPDATE and DELETE", async () => {
    await expect(checkWrite("INSERT INTO products (sku, name, category, price) VALUES ('X', 'Y', 'Z', 1)")).resolves.toMatchObject({
      op: "insert",
      table: "products",
      hasReturning: false,
    });
    await expect(checkWrite("UPDATE public.products SET price = 10 WHERE id = 2 RETURNING id")).resolves.toMatchObject({
      op: "update",
      table: "public.products",
      hasReturning: true,
    });
    await expect(checkWrite("DELETE FROM orders WHERE id = 4")).resolves.toMatchObject({ op: "delete", table: "orders" });
  });

  it("requires a WHERE clause on UPDATE and DELETE", async () => {
    expect(await rejected(checkWrite("UPDATE products SET price = 0"))).toMatch(/WHERE/);
    expect(await rejected(checkWrite("DELETE FROM customers"))).toMatch(/WHERE/);
  });

  it("rejects DDL, TRUNCATE, MERGE, SELECT and multiple statements", async () => {
    expect(await rejected(checkWrite("DROP TABLE customers"))).toMatch(/DDL/);
    expect(await rejected(checkWrite("ALTER TABLE customers ADD COLUMN x int"))).toMatch(/DDL/);
    expect(await rejected(checkWrite("TRUNCATE customers"))).toMatch(/TRUNCATE/);
    expect(await rejected(checkWrite("MERGE INTO products p USING products q ON p.id = q.id WHEN MATCHED THEN DELETE"))).toMatch(
      /Only INSERT/,
    );
    expect(await rejected(checkWrite("SELECT 1"))).toMatch(/run_select/);
    expect(await rejected(checkWrite("DELETE FROM orders WHERE id = 1; DELETE FROM customers WHERE id = 1"))).toMatch(/exactly one/);
  });

  it("rejects nested writes and blocked functions", async () => {
    expect(
      await rejected(checkWrite("WITH d AS (DELETE FROM order_items WHERE order_id = 1 RETURNING *) DELETE FROM orders WHERE id = 1")),
    ).toMatch(/Nested/);
    expect(await rejected(checkWrite("UPDATE products SET name = pg_read_file('/etc/passwd') WHERE id = 1"))).toMatch(/pg_read_file/);
  });
});

describe("withReturning", () => {
  it("adds RETURNING * when missing, even after a trailing line comment", async () => {
    const write = await checkWrite("UPDATE products SET stock = 5 WHERE id = 5 -- restock");
    expect(await withReturning(write)).toBe("UPDATE products SET stock = 5 WHERE id = 5 -- restock\nRETURNING *");
  });

  it("keeps an existing RETURNING clause", async () => {
    const write = await checkWrite("DELETE FROM orders WHERE id = 4 RETURNING id");
    expect(await withReturning(write)).toBe("DELETE FROM orders WHERE id = 4 RETURNING id");
  });
});

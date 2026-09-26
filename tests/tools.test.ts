import { beforeEach, describe, expect, it } from "vitest";
import { queryOne, resetDatabase, TEST_DATABASE_URL } from "./helpers";
import { loadSchemaSummary } from "@/lib/schema";
import { describeTable, executeWrite, listTables, previewWrite, runSelect } from "@/lib/tools";

describe.skipIf(!TEST_DATABASE_URL)("tools against Postgres", () => {
  beforeEach(resetDatabase);

  it("run_select returns columns and rows", async () => {
    const out = await runSelect("SELECT id, name FROM customers WHERE country = 'Nigeria' ORDER BY id", "t");
    expect(out.isError).toBe(false);
    expect(out.table).toMatchObject({
      columns: ["id", "name"],
      rows: [
        [1, "Ada Obi"],
        [5, "Emeka Nwosu"],
      ],
      rowCount: 2,
      truncated: false,
    });
    expect(JSON.parse(out.content)).toEqual(out.table);
  });

  it("run_select caps the number of rows and says so", async () => {
    const out = await runSelect("SELECT g FROM generate_series(1, 500) g", "t");
    expect(out.table?.rowCount).toBe(200);
    expect(out.table?.truncated).toBe(true);
    expect(out.table?.note).toMatch(/first 200 rows/);
  });

  it("run_select refuses writes and cannot change data", async () => {
    const out = await runSelect("UPDATE products SET price = 0 WHERE id = 1", "t");
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/propose_write/);
    expect(await queryOne("SELECT price FROM products WHERE id = 1")).toEqual({ price: "89.00" });
  });

  it("run_select reports database errors so the model can fix its SQL", async () => {
    const out = await runSelect("SELECT no_such_column FROM customers", "t");
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Database error 42703/);
  });

  it("list_tables and describe_table show the schema", async () => {
    const tables = JSON.parse((await listTables()).content) as { table: string }[];
    expect(tables.map((t) => t.table)).toEqual(
      expect.arrayContaining(["public.customers", "public.orders", "public.order_items", "public.products"]),
    );

    const described = await describeTable("orders");
    expect(described.isError).toBe(false);
    const info = JSON.parse(described.content);
    expect(info.table).toBe("orders");
    expect(info.comment).toMatch(/checkout/);
    expect(info.columns.map((c: { name: string }) => c.name)).toEqual(["id", "customer_id", "status", "ordered_at"]);
    expect(JSON.stringify(info.constraints)).toMatch(/REFERENCES customers\(id\)/);
    expect(info.sample_rows.rowCount).toBe(3);

    const missing = await describeTable("nope; drop table customers");
    expect(missing.isError).toBe(true);
  });

  it("schema summary lists tables, columns and foreign keys", async () => {
    const summary = await loadSchemaSummary();
    expect(summary).toContain("public.products (table");
    expect(summary).toContain("  price numeric(10,2) NOT NULL");
    expect(summary).toContain("  id integer PK");
    expect(summary).toContain("FOREIGN KEY (customer_id) REFERENCES customers(id)");
  });

  it("previewWrite dry-runs a change without applying it, and executeWrite applies it", async () => {
    const result = await previewWrite("UPDATE products SET price = 24.99 WHERE sku = 'MS-002'", "Cheaper mouse", "t");
    if (!result.ok) throw new Error(result.outcome.content);
    expect(result.preview).toMatchObject({ op: "update", table: "products", affectedRows: 1 });
    expect(result.preview.rows.columns).toContain("price");
    expect(await queryOne("SELECT price FROM products WHERE sku = 'MS-002'")).toEqual({ price: "29.50" });

    const applied = await executeWrite(result.preview, "t");
    expect(applied.isError).toBe(false);
    expect(JSON.parse(applied.content)).toMatchObject({ status: "approved_and_applied", affected_rows: 1 });
    expect(await queryOne("SELECT price FROM products WHERE sku = 'MS-002'")).toEqual({ price: "24.99" });
  });

  it("executeWrite rolls back when the data changed since the preview", async () => {
    const result = await previewWrite("DELETE FROM orders WHERE status = 'pending'", "Remove pending orders", "t");
    if (!result.ok) throw new Error(result.outcome.content);
    expect(result.preview.affectedRows).toBe(3);
    expect(result.preview.cascadesTo).toEqual(["order_items"]);

    await queryOne("UPDATE orders SET status = 'pending' WHERE id = 2");
    const applied = await executeWrite(result.preview, "t");
    expect(applied.isError).toBe(true);
    expect(applied.content).toMatch(/NOT applied.*4 rows instead of the 3/);
    expect(await queryOne("SELECT count(*)::int AS n FROM orders")).toEqual({ n: 11 });
  });

  it("previewWrite refuses changes over the row limit and leaves the data alone", async () => {
    const result = await previewWrite(
      "INSERT INTO customers (name, email, country) SELECT 'x' || g, 'x' || g || '@example.com', 'X' FROM generate_series(1, 150) g",
      "Bulk insert",
      "t",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.content).toMatch(/150 rows, over the limit of 100/);
    expect(await queryOne("SELECT count(*)::int AS n FROM customers")).toEqual({ n: 8 });
  });

  it("previewWrite surfaces constraint violations", async () => {
    const result = await previewWrite("UPDATE products SET stock = -1 WHERE id = 1", "Negative stock", "t");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome.content).toMatch(/Database error 23514/);
  });
});

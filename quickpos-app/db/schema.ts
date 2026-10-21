import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const products = pgTable("products", {
  id: serial().primaryKey(),
  name: text().notNull(),
  category: text().notNull().default("Other"),
  description: text().notNull().default(""),
  unitPriceCents: integer("unit_price_cents").notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sales = pgTable("sales", {
  id: serial().primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  totalItems: integer("total_items").notNull(),
  totalAmountCents: integer("total_amount_cents").notNull(),
}, t => [index("idx_sales_timestamp").on(t.timestamp)]);

export const saleItems = pgTable("sale_items", {
  id: serial().primaryKey(),
  saleId: integer("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  quantity: integer().notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  totalAmountCents: integer("total_amount_cents").notNull(),
}, t => [index("idx_sale_items_sale_id").on(t.saleId)]);

import "dotenv/config";
import { defineConfig } from "prisma/config";
import { PrismaNeon } from "@prisma/adapter-neon";

const dbUrl = process.env["DATABASE_URL"]!;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrate: {
    adapter: () => new PrismaNeon({ connectionString: dbUrl }),
  },
  datasource: {
    url: dbUrl,
  },
});

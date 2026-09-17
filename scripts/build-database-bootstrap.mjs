import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseMigrations } from "./database-migrations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sections = [];

for (const migration of databaseMigrations) {
  const source = await readFile(resolve(root, "supabase", migration), "utf8");
  // Several later phases are independently transactional. The generated fresh-
  // install script owns the outer transaction, so remove only exact top-level
  // transaction statements; PL/pgSQL BEGIN/END blocks are untouched.
  const withoutTransactionBoundary = source
    .replace(/^BEGIN;\s*$/gm, "")
    .replace(/^COMMIT;\s*$/gm, "")
    .trim();
  sections.push(`-- BEGIN SOURCE: supabase/${migration}\n${withoutTransactionBoundary}\n-- END SOURCE: supabase/${migration}`);
}

const output = [
  "-- GENERATED FILE: run `npm run db:bootstrap:build` after editing a source migration.",
  "-- Fresh databases only. The single transaction prevents a partially hardened schema.",
  "BEGIN;",
  ...sections,
  "COMMIT;",
  "",
].join("\n\n");

const destination = resolve(root, "supabase/bootstrap.sql");
await writeFile(destination, output);
console.log(`Generated ${destination}`);

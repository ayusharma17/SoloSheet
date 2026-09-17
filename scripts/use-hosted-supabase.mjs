import { readFileSync, writeFileSync } from "node:fs";

function readDotenv(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const hosted = readDotenv(".env");
const url = hosted.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = hosted.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.HOSTED_SUPABASE_SERVICE_ROLE_KEY
  || hosted.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey) {
  throw new Error(".env must contain NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY");
}
if (!serviceKey) {
  throw new Error("Set HOSTED_SUPABASE_SERVICE_ROLE_KEY in the shell; it is intentionally not guessed");
}
if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url)) {
  throw new Error("Refusing to configure a non-hosted Supabase URL");
}

writeFileSync(".env.local", [
  `NEXT_PUBLIC_SUPABASE_URL=${url}`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
  `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
  "NEXT_PUBLIC_ENABLE_TEST_AUTH=false",
  "",
].join("\n"), { mode: 0o600 });

console.log("Configured .env.local for the hosted Supabase project.");
console.log("Test auth disabled. Restart Next.js to load the new target.");

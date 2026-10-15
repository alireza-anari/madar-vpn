import { env } from "cloudflare:workers";
export async function resetDb() {
  const tables = await env.SALES_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  for (const { name } of tables.results.reverse())
    await env.SALES_DB.exec(
      `DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}";`,
    );
}

// ============================================================
// Daily DB backup → R2
// ============================================================
// Triggered by Cron (see wrangler.toml). Walks every table, JSON-
// serializes the rows + the original CREATE statements, gzips,
// stores in R2 under `praxmate/backups/d1-YYYY-MM-DD.json.gz`.
//
// Retention: keep 30 days. Older snapshots are deleted by the same job.
// ============================================================

export async function runBackup(env) {
  const started = Date.now();

  // 1) Schema (CREATE TABLE / CREATE INDEX statements)
  const schema = await env.DB.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY type, name`
  ).all();

  // 2) Tables with all rows
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
  ).all();

  const dump = {
    exported_at: new Date().toISOString(),
    schema: schema.results || [],
    tables: {},
  };
  let totalRows = 0;
  for (const t of (tables.results || [])) {
    const rows = await env.DB.prepare(`SELECT * FROM ${t.name}`).all();
    dump.tables[t.name] = rows.results || [];
    totalRows += dump.tables[t.name].length;
  }

  // 3) Serialize + gzip
  const json = JSON.stringify(dump);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const gzipped = await new Response(stream).arrayBuffer();

  // 4) Upload to R2
  const dateStr = new Date().toISOString().slice(0, 10);
  const key = `praxmate/backups/d1-${dateStr}.json.gz`;
  await env.R2.put(key, gzipped, {
    httpMetadata: {
      contentType: 'application/json',
      contentEncoding: 'gzip',
    },
    customMetadata: {
      tables: String((tables.results || []).length),
      rows: String(totalRows),
      original_size: String(json.length),
    },
  });

  // 5) Retention: delete backups older than 30 days
  const list = await env.R2.list({ prefix: 'praxmate/backups/d1-' });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let purged = 0;
  for (const obj of (list.objects || [])) {
    // Filename: praxmate/backups/d1-YYYY-MM-DD.json.gz
    const m = obj.key.match(/d1-(\d{4}-\d{2}-\d{2})\.json\.gz$/);
    if (!m) continue;
    if (new Date(m[1]) < cutoff) {
      await env.R2.delete(obj.key);
      purged++;
    }
  }

  const result = {
    key,
    tables: (tables.results || []).length,
    rows: totalRows,
    original_size: json.length,
    gzipped_size: gzipped.byteLength,
    purged_old: purged,
    duration_ms: Date.now() - started,
  };
  console.log('[backup]', JSON.stringify(result));
  return result;
}

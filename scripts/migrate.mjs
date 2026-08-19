// supabase/migrations/*.sql のうち、まだ当てていないものだけを番号順に適用する。
//
// これまでマイグレーションはSupabaseの画面から手で流していた。手順として脆く、
// 「先に適用してください」という受け渡しが毎回発生し、適用を忘れたままスクレイパーが
// 走ると未知の列を PostgREST が拒否して全INSERTが失敗する。このスクリプトは
// main への push で自動実行され、その受け渡し自体を無くすためのもの。
//
// 適用済みかどうかは public.schema_migrations に記録する。ファイル名が主キーで、
// 内容のSHA-256も一緒に持つ。既に適用したファイルが後から書き換えられた場合、
// DBの実態とリポジトリの内容が黙って食い違うことになるので、そこは失敗させる。
//
// 使い方:
//   node migrate.mjs                    未適用のものを適用する
//   node migrate.mjs --dry-run          何が適用されるかだけ出す(DBは変更しない)
//   node migrate.mjs --baseline <file>  <file> までを「適用済み」として記録だけする
//                                       (SQLは実行しない。手で流した過去分の引き継ぎ用)
//
// 接続には SUPABASE_DB_URL が要る。PostgREST 用の SUPABASE_URL とは別物で、
// Postgres への直接接続文字列(パスワード入り)。DDLを流すため Session pooler
// 側の文字列を使うこと — 詳細は README の「マイグレーションの自動適用」を参照。

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(SCRIPT_DIR, '..', 'supabase', 'migrations');

const DATABASE_URL = process.env.SUPABASE_DB_URL;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const baselineIndex = args.indexOf('--baseline');
const baselineUpTo = baselineIndex >= 0 ? args[baselineIndex + 1] : null;

if (baselineIndex >= 0 && !baselineUpTo) {
  console.error('--baseline にはファイル名が要る (例: --baseline 0006_product_id_include_price_group.sql)');
  console.error('どこまでを適用済みとみなすかは推測できないので、明示してもらう。');
  process.exit(1);
}

if (!DATABASE_URL && !dryRun) {
  console.error('SUPABASE_DB_URL が設定されていない。');
  console.error('Supabase の Project Settings → Database → Connection string → Session pooler の文字列を使う。');
  process.exit(1);
}

const checksumOf = (sql) => createHash('sha256').update(sql, 'utf8').digest('hex');

async function loadMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  // ファイル名の先頭が連番なので、単純な文字列順がそのまま適用順になる。
  const files = entries.filter((name) => name.endsWith('.sql')).sort();
  const migrations = [];
  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf-8');
    migrations.push({ filename, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

// 適用済みの記録そのものを置く場所なので、これだけは schema_migrations の管理外。
async function ensureLedger(client) {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function fetchApplied(client) {
  const { rows } = await client.query('select filename, checksum from public.schema_migrations');
  return new Map(rows.map((row) => [row.filename, row.checksum]));
}

// 1ファイル = 1トランザクション。SQLの適用と「適用した」という記録が同時に成立
// するか、どちらも成立しないかのどちらかにする。途中で落ちた時に、当たっているのに
// 未適用として記録されている(あるいはその逆)状態を作らないため。
// マイグレーション側で BEGIN/COMMIT を書かないこと。
async function applyMigration(client, migration) {
  await client.query('begin');
  try {
    await client.query(migration.sql);
    await client.query(
      'insert into public.schema_migrations (filename, checksum) values ($1, $2)',
      [migration.filename, migration.checksum]
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  }
}

function reportDrift(drifted) {
  console.error('');
  console.error('適用済みのマイグレーションが、リポジトリ側で書き換えられている:');
  for (const { filename, applied, current } of drifted) {
    console.error(`  ${filename}`);
    console.error(`    DBに適用した時点: ${applied}`);
    console.error(`    いまのファイル  : ${current}`);
  }
  console.error('');
  console.error('既に当たったSQLを書き換えても、DBの実態は変わらない。リポジトリとDBが');
  console.error('黙って食い違ったままになるので、ここで止める。');
  console.error('変更したい場合は、そのファイルを戻して新しい番号のマイグレーションを追加すること。');
}

async function main() {
  const migrations = await loadMigrations();
  console.log(`${migrations.length} 件のマイグレーションファイルを検出`);

  if (dryRun && !DATABASE_URL) {
    console.log('(SUPABASE_DB_URL 未設定のため、ファイル一覧のみ)');
    for (const m of migrations) console.log(`  ${m.filename}`);
    return;
  }

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    // 接続文字列が明示的にSSLを切っている場合だけ切る。それ以外は証明書を検証する
    // (検証を無効化する逃げ道は用意しない — 失敗したら README の接続文字列の項を見る)。
    ssl: /[?&]sslmode=disable(&|$)/.test(DATABASE_URL) ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    await ensureLedger(client);
    const applied = await fetchApplied(client);

    if (baselineUpTo) {
      const cutoff = migrations.findIndex((m) => m.filename === baselineUpTo);
      if (cutoff < 0) {
        console.error(`--baseline に指定された ${baselineUpTo} が supabase/migrations/ に無い`);
        process.exitCode = 1;
        return;
      }
      let recorded = 0;
      for (const migration of migrations.slice(0, cutoff + 1)) {
        if (applied.has(migration.filename)) continue;
        await client.query(
          'insert into public.schema_migrations (filename, checksum) values ($1, $2)',
          [migration.filename, migration.checksum]
        );
        console.log(`  記録のみ (SQLは実行しない): ${migration.filename}`);
        recorded++;
      }
      console.log(`baseline 完了: ${recorded} 件を適用済みとして記録した`);
      return;
    }

    const drifted = [];
    const pending = [];
    for (const migration of migrations) {
      const appliedChecksum = applied.get(migration.filename);
      if (appliedChecksum === undefined) pending.push(migration);
      else if (appliedChecksum !== migration.checksum) {
        drifted.push({ filename: migration.filename, applied: appliedChecksum, current: migration.checksum });
      }
    }

    if (drifted.length > 0) {
      reportDrift(drifted);
      process.exitCode = 1;
      return;
    }

    if (pending.length === 0) {
      console.log('未適用のマイグレーションは無し');
      return;
    }

    console.log(`未適用: ${pending.length} 件`);
    for (const migration of pending) console.log(`  ${migration.filename}`);

    if (dryRun) {
      console.log('--dry-run のため適用しない');
      return;
    }

    for (const migration of pending) {
      process.stdout.write(`適用中 ${migration.filename} ... `);
      await applyMigration(client, migration);
      console.log('OK');
    }
    console.log(`${pending.length} 件を適用した`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`マイグレーションに失敗: ${err.message}`);
  if (err.code) console.error(`  Postgres エラーコード: ${err.code}`);
  if (/self.signed|certificate/i.test(err.message)) {
    console.error('  TLS証明書の検証に失敗している。Session pooler の接続文字列を使っているか確認すること。');
  }
  process.exit(1);
});

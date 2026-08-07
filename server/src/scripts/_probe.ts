import { getDb } from '../db.ts';
const db = getDb();
for (const t of ['naf_games','bb_games','fb_matches','bsb_games']) {
  const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as never as {name:string}[]).map(c=>c.name);
  console.log(`\n${t}:`);
  for (const c of cols) {
    const r = db.prepare(`SELECT COUNT(${c}) n, COUNT(*) total FROM ${t}`).get() as never as {n:number;total:number};
    console.log(`   ${c.padEnd(16)} ${r.n}/${r.total} (${(r.n/r.total*100).toFixed(0)}%)`);
  }
}

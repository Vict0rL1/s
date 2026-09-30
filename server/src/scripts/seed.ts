// CLI: `npm run seed`
// Loads the bundled synthetic sample dataset so the app works end-to-end
// offline. Replace it with real data via `npm run update-data`.

import { seedDatabase } from '../ingest/seed.ts';

const r = seedDatabase();
console.log('\n✅ Seeded sample dataset (synthetic — for demo only):');
console.log(`   players:  ${r.players}`);
console.log(`   matches:  ${r.matches}`);
console.log(`   upcoming: ${r.upcoming} (fixture odds)`);
console.log(`   ratings:  ${JSON.stringify(r.ratings)}`);
console.log('\nStart the app with:  npm run dev\n');

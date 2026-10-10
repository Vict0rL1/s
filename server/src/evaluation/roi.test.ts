// C7: dos definiciones de ROI (beneficio/arriesgado y beneficio/n). Un helper para todos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { roiDe } = await import('./roi.ts');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('C7: roiDe es beneficio sobre lo arriesgado, y null sin nada arriesgado', () => {
  assert.equal(roiDe(10, 100), 0.1);
  assert.equal(roiDe(-25, 50), -0.5);
  assert.equal(roiDe(0, 0), null);
  assert.equal(roiDe(5, -1), null);
});

test('C7: todo el que calcula un ROI usa el helper (no hay una segunda fórmula escondida)', () => {
  for (const f of ['paper/bankroll.ts', 'estrategias/index.ts', 'estrategias/historico.ts', 'evaluation/betting.ts', 'evaluation/segmentos.ts', 'football/clv.ts', 'evaluation/walkforward.ts']) {
    const s = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.match(s, /roiDe\(/, `${f} usa roiDe`);
    assert.doesNotMatch(s, /roi: [^,\n]*\/ (n|arriesgado|stake)\b/, `${f} sin fórmula propia`);
  }
});

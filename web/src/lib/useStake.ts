// The shared stake, as a hook.
//
// Separate from lib/picks.ts because that file is pure data and imports no React;
// keeping it that way means it can be unit-tested and reasoned about without a
// renderer. See picks.ts for why the stake is one number across all five tabs.

import { useEffect, useState } from 'react';
import { readStake, writeStake } from './picks';

export function useStake(): [number, (n: number) => void] {
  const [stake, setStake] = useState<number>(() => readStake());
  useEffect(() => {
    writeStake(stake);
  }, [stake]);
  return [stake, setStake];
}

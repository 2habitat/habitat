import { Habitat } from '../server/core/space.ts';
import type { Rep } from '../shared/types.ts';
import { makeSpace, rmSpace } from './helpers/space.ts';

const dir = await makeSpace();
const hab = await Habitat.open(dir);
console.log('SCAN', JSON.stringify(hab.stats()));
console.log('WORKS', hab.works().map((w) => `${w.work.title}:${w.parts.length}章/${w.reps.length}载体 locked=${w.locked}`));
console.log('FACTS-W1', JSON.stringify(hab.facts('work-01HX8Z9K7M2N4P6Q8R0S2T4V6W')));
console.log('SEARCH-中文', hab.index.search('线性注意力').map((h) => h.title));
console.log('SEARCH-英文', hab.index.search('DeltaNet').map((h) => h.title));
console.log('TODAY', JSON.stringify({ ...hab.today('2026-11-02'), reading: undefined }, null, 0).slice(0, 300));

const rep = hab.store.all<Rep>('rep').find((r) => r.carrier === 'md')!;
console.log('REP', rep.id, rep.path, 'locked=', rep.locked);

const cap = await hab.capture({ title: '冒烟采集', body: '正文一段' });
console.log('CAPTURE', cap.id, 'events=', cap.events.length);
await hab.rescan();

const locked = hab.store.all<Rep>('rep').find((r) => r.locked)!;
console.log('LOCKED REP', locked?.path, locked?.locked);

const cs = await hab.changes.propose({ ops: [{ t: 'setBody', id: locked.id, body: '改原件' }], actor: 'human', reason: '试试改原件' });
const checks = await hab.changes.validate(cs);
console.log('CHECKS', JSON.stringify(checks, null, 1));

hab.close();
await rmSpace(dir);
console.log('SMOKE OK');

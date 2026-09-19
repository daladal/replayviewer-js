/**
 * Trigger resolution ahead of time. Lazer's `StoryboardTriggerController` fires a
 * `StoryboardTriggerGroup` at runtime whenever gameplay reports a matching event inside the
 * group's window; a replay is known in full, so every firing time is computed once here and the
 * compiler expands the group's commands into ordinary absolute-time commands. Pure and DOM-free.
 */

import type { TriggerGroup } from './types.js';
import type { PendingSound } from '../player/hitsoundSchedule.js';

/** One sample a hit object played, as lazer's `HitSampleInfo` describes it. */
export interface HitSampleFact {
  /** `hitnormal` or one of the three additions. */
  name: 'normal' | 'whistle' | 'finish' | 'clap';
  /** Sample bank: 1 normal, 2 soft, 3 drum. */
  bank: number;
  /** Custom sample index; `HitSampleInfo.Suffix` is set only for 2 and above. */
  index: number;
}

/** Every sample one hit object played at once (`GameplayState.LastPlayedSamples`). */
export interface HitSampleEvent {
  timeMs: number;
  samples: readonly HitSampleFact[];
}

/** A change of the storyboard's pass/fail state (`DrawableStoryboard.passing`). */
export interface PassingTransition {
  timeMs: number;
  passing: boolean;
}

/** The gameplay events trigger groups can fire on, each ascending by time. */
export interface TriggerEvents {
  hitSamples: readonly HitSampleEvent[];
  passing: readonly PassingTransition[];
}

export const NO_TRIGGER_EVENTS: TriggerEvents = { hitSamples: [], passing: [] };

/** A parsed `HitSound…` trigger name (`HitSampleTriggerDefinition`); null = no filter. */
export interface HitSoundTriggerDef {
  normalBank: number | null;
  additionBank: number | null;
  additionName: 'whistle' | 'finish' | 'clap' | null;
  /** Custom-index digits, compared as text against the samples' suffix. */
  suffix: string | null;
}

const HITSOUND_RE = /^HitSound(All|Normal|Soft|Drum)?(All|Normal|Soft|Drum)?(Whistle|Clap|Finish)?(\d+)?$/i;
const BANK_OF: Record<string, number> = { normal: 1, soft: 2, drum: 3 };

/** `HitSampleTriggerDefinition.TryParse`; null when the name is not a hit-sound trigger. */
export function parseHitSoundTrigger(name: string): HitSoundTriggerDef | null {
  const m = HITSOUND_RE.exec(name);
  if (m === null) return null;
  const bank1 = m[1] ?? null, bank2 = m[2] ?? null, addition = m[3] ?? null, suffix = m[4] ?? null;
  // A single bank in front of an addition name is the addition's bank (stable's
  // EventTriggerHitSound): `HitSoundDrumWhistle` = whistle from the drum bank.
  const bank1IsAddition = bank1 !== null && bank2 === null && addition !== null;
  // `All` maps to no filter.
  const bankOf = (b: string | null): number | null => b === null ? null : BANK_OF[b.toLowerCase()] ?? null;
  return {
    normalBank: bankOf(bank1IsAddition ? bank2 : bank1),
    additionBank: bankOf(bank1IsAddition ? bank1 : bank2),
    additionName: addition === null ? null : addition.toLowerCase() as 'whistle' | 'clap' | 'finish',
    suffix,
  };
}

function sampleSuffix(index: number): string | null {
  return index >= 2 ? String(index) : null;
}

/**
 * `HitSampleTriggerDefinition.Matches`: the hitnormal's bank must equal `normalBank` when set;
 * the addition name must be among the samples when set; some addition must use `additionBank`
 * when set; every sample's suffix must equal `suffix` when set. Lazer notes this is not exact
 * stable behaviour for bank-only triggers such as `HitSoundAllSoft` on objects without
 * additions (stable kept an addition bank even when no addition played).
 */
export function hitSoundTriggerMatches(def: HitSoundTriggerDef, samples: readonly HitSampleFact[]): boolean {
  let foundAddition = def.additionName === null;
  let additionBankOk = def.additionBank === null;
  for (const s of samples) {
    if (s.name === 'normal') {
      if (def.normalBank !== null && s.bank !== def.normalBank) return false;
    } else {
      if (def.additionName !== null && s.name === def.additionName) foundAddition = true;
      if (def.additionBank !== null && s.bank === def.additionBank) additionBankOk = true;
    }
    if (def.suffix !== null && def.suffix !== sampleSuffix(s.index)) return false;
  }
  return foundAddition && additionBankOk;
}

/**
 * Times at which `group` fires: the matching events inside its inclusive window
 * (`StoryboardTriggerGroup.ActiveAt`), ascending. `Passing`/`Failing` fire on transitions into
 * that state (the initial state is not a transition); `HitSound…` names fire on matching hit
 * samples; `HitObjectHit` and unknown names never fire.
 */
export function triggerFirings(group: TriggerGroup, events: TriggerEvents): number[] {
  const out: number[] = [];
  const active = (t: number): boolean => group.triggerStartTime <= t && t <= group.triggerEndTime;
  const name = group.triggerName;
  if (name === 'Passing' || name === 'Failing') {
    const target = name === 'Passing';
    for (const p of events.passing) if (p.passing === target && active(p.timeMs)) out.push(p.timeMs);
  } else if (/^HitSound/i.test(name)) {
    const def = parseHitSoundTrigger(name);
    if (def === null) return out;
    for (const e of events.hitSamples) if (active(e.timeMs) && hitSoundTriggerMatches(def, e.samples)) out.push(e.timeMs);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Per-hit sample events from a hitsound schedule (sorted by time): the per-stem entries that
 * share a time are one object's samples. Two objects sounding at the same instant (a mania
 * chord) merge into one event, which can only add matches for bank-combination triggers. Skin
 * effects (combo break, spinner bonus) are not hit samples; a custom-file sample replaces the
 * hitnormal with a file-named sample lazer's matcher treats as neither hitnormal nor addition.
 */
export function hitSampleEventsFromSchedule(sounds: readonly PendingSound[]): HitSampleEvent[] {
  const out: HitSampleEvent[] = [];
  let cur: { timeMs: number; samples: HitSampleFact[] } | null = null;
  for (const s of sounds) {
    if (s.type === 'combobreak' || s.type === 'spinnerbonus' || s.type === 'storyboard') continue;
    if (cur === null || cur.timeMs !== s.beatmapMs) { cur = { timeMs: s.beatmapMs, samples: [] }; out.push(cur); }
    if (s.type === 'normal' && s.customFile !== '') continue;
    cur.samples.push({ name: s.type, bank: s.sampleSet, index: s.sampleIndex });
  }
  return out;
}

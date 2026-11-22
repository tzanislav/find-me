// Types text into a text node one character at a time, beeping on vowels.
// Shared by the title intro and the tutorial's briefing box.

import { playUiSound } from './audio/ui-sounds';

/** Typing speed: a delay per character, plus extra pauses after punctuation. */
const CHAR_MS = 16;
const PAUSE_MS: Record<string, number> = { '.': 190, '!': 190, '?': 190, ',': 70, ';': 80, ':': 80, '\n': 130 };

const VOWELS = /[aeiou]/i;

export interface Typing {
  /** Puts the rest of the text up at once. */
  skip(): void;
  /** True once all the text is up (typed or skipped), false if `live` turned false first. */
  readonly done: Promise<boolean>;
}

/**
 * Appends `text` to `node` one character at a time. Stops early once `live`
 * returns false. `onChar` runs after every step, e.g. to keep the text scrolled.
 */
export function typewrite(node: Text, text: string, opts: { live?: () => boolean; onChar?: () => void } = {}): Typing {
  let skipped = false;
  let wake: () => void = () => {};
  const done = (async () => {
    for (const ch of text) {
      if (opts.live && !opts.live()) return false;
      if (skipped) {
        node.data = text;
        opts.onChar?.();
        return true;
      }
      node.appendData(ch);
      if (VOWELS.test(ch)) playUiSound('beep');
      opts.onChar?.();
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, CHAR_MS + (PAUSE_MS[ch] ?? 0));
      });
    }
    return true;
  })();
  return {
    skip: () => {
      skipped = true;
      wake(); // don't wait out the current character's pause
    },
    done,
  };
}

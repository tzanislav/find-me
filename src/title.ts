// Title screen, credits window and the typed intro that leads into the game.
//
// Flow: title + [Start] [Settings] [Credits]. Start fades the buttons, then the title,
// then types public/text/intro.txt with a cursor. A Start button appears in
// the bottom right of the text field shortly after typing begins; it opens
// the game straight away, whether or not the text has finished.
//
// The intro and credits are plain text files in public/text/, so they can be
// edited without touching code or rebuilding.

import { playUiSound } from './audio/ui-sounds';
import { MAX_SEED, parseSeed } from './rng';
import { SettingsWindow } from './settings-window';

const TEXT_URL = (name: string) => `${import.meta.env.BASE_URL}text/${name}`;

/** Timings of the start sequence, in ms. Fade lengths must match style.css. */
const BUTTONS_FADE_MS = 600;
const TITLE_FADE_MS = 2500;
const PAUSE_BEFORE_TEXT_MS = 600;
/** How long after typing begins the intro's Start button appears. */
const START_BUTTON_DELAY_MS = 1500;

/** Typing speed: a delay per character, plus extra pauses after punctuation. */
const CHAR_MS = 16;
const PAUSE_MS: Record<string, number> = { '.': 190, '!': 190, '?': 190, ',': 70, ';': 80, ':': 80, '\n': 130 };

const VOWELS = /[aeiou]/i;

/**
 * Sound hook: called once for every character the intro types, including
 * spaces and line breaks. Vowels beep.
 */
function onIntroType(ch: string) {
  if (VOWELS.test(ch)) playUiSound('beep');
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function loadText(name: string): Promise<string> {
  const r = await fetch(TEXT_URL(name));
  if (!r.ok) throw new Error(`${name} failed to load: ${r.status}`);
  // Files edited on Windows have CRLF line endings
  return (await r.text()).replace(/\r\n?/g, '\n').trim();
}

export class TitleScreen {
  private readonly screen = $('title-screen');
  private readonly name = $('title-name');
  private readonly buttons = $('title-buttons');
  private readonly seedField = $('title-seed');
  private readonly seedInput = $<HTMLInputElement>('seed-input');
  private readonly intro = $('intro');
  private readonly introBox = $('intro-text');
  private readonly typed = $('intro-typed');
  private readonly introStart = $<HTMLButtonElement>('btn-intro-start');
  private readonly credits = $('credits');
  private readonly settings = new SettingsWindow();
  private readonly introText = loadText('intro.txt').catch((err) => {
    console.error(err);
    return '';
  });
  private readonly creditsText = loadText('credits.txt').catch((err) => {
    console.error(err);
    return 'Credits failed to load.';
  });
  /** Bumped whenever the sequence is cancelled, so a running one stops at its next step. */
  private run = 0;
  /** Set while the intro is typing: finishes it at once (any click on the screen). */
  private skipTyping: (() => void) | null = null;

  /** `onStart` opens the game; it runs when the intro's Start button is pressed. */
  constructor(private readonly onStart: () => void) {
    $('btn-title-start').addEventListener('click', () => void this.sequence());
    // Digits only, capped at the largest seed
    this.seedInput.addEventListener('input', () => {
      const digits = this.seedInput.value.replace(/\D/g, '').slice(0, 10);
      this.seedInput.value = digits && Number(digits) > MAX_SEED ? String(MAX_SEED) : digits;
    });
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.sequence();
    });
    $('btn-title-settings').addEventListener('click', () => this.settings.show(true));
    $('btn-title-credits').addEventListener('click', () => void this.showCredits(true));
    $('btn-credits-close').addEventListener('click', () => void this.showCredits(false));
    this.credits.addEventListener('click', (e) => {
      if (e.target === this.credits) void this.showCredits(false); // click outside the window
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.credits.classList.contains('hidden')) void this.showCredits(false);
    });
    // Clicking anywhere while the intro types shows the whole text (the Start button still just starts)
    this.screen.addEventListener('click', (e) => {
      if (!this.introStart.contains(e.target as Node)) this.skipTyping?.();
    });
    this.introStart.addEventListener('click', () => {
      this.run++;
      this.screen.classList.add('hidden');
      this.onStart();
    });
  }

  /** The seed typed on the title screen, or null for a random round. */
  get seed(): number | null {
    return parseSeed(this.seedInput.value);
  }

  get visible(): boolean {
    return !this.screen.classList.contains('hidden');
  }

  /** Back to the title with its buttons, e.g. from the Main Menu button. */
  show() {
    this.run++;
    this.screen.classList.remove('hidden');
    this.name.classList.remove('gone');
    this.buttons.classList.remove('gone');
    this.seedField.classList.remove('gone');
    this.intro.classList.add('hidden');
    this.introStart.classList.add('gone');
    this.introBox.classList.remove('typing');
    this.typed.textContent = '';
    this.introBox.scrollTop = 0;
  }

  private async showCredits(open: boolean) {
    if (open) $('credits-text').textContent = await this.creditsText;
    this.credits.classList.toggle('hidden', !open);
  }

  private async sequence() {
    const run = ++this.run;
    const live = () => run === this.run;

    this.buttons.classList.add('gone');
    this.seedField.classList.add('gone');
    this.seedInput.blur();
    await wait(BUTTONS_FADE_MS);
    if (!live()) return;
    this.name.classList.add('gone');
    await wait(TITLE_FADE_MS + PAUSE_BEFORE_TEXT_MS);
    if (!live()) return;

    this.intro.classList.remove('hidden');
    setTimeout(() => live() && this.introStart.classList.remove('gone'), START_BUTTON_DELAY_MS);
    await this.type(await this.introText, live);
  }

  /**
   * Types `text` one character at a time; stops early once `live` turns false.
   * A skip (see skipTyping) puts the rest of the text up at once and shows the Start button.
   */
  private async type(text: string, live: () => boolean) {
    this.introBox.classList.add('typing'); // solid cursor while typing, blinking when done
    const node = document.createTextNode('');
    this.typed.replaceChildren(node);
    let skipped = false;
    let wake: () => void = () => {};
    this.skipTyping = () => {
      skipped = true;
      wake(); // don't wait out the current character's pause
    };
    try {
      for (const ch of text) {
        if (!live()) return;
        if (skipped) {
          node.data = text;
          this.introStart.classList.remove('gone');
          break;
        }
        node.appendData(ch);
        onIntroType(ch);
        // Keep the newest line in view if the text outgrows the field
        this.introBox.scrollTop = this.introBox.scrollHeight;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, CHAR_MS + (PAUSE_MS[ch] ?? 0));
        });
      }
      this.introBox.scrollTop = this.introBox.scrollHeight;
      this.introBox.classList.remove('typing');
    } finally {
      this.skipTyping = null;
    }
  }
}

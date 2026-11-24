// Interactive tutorial on a fixed seed. A briefing box types out each step
// (a click skips the typing) and a dark overlay with a spotlight hole shows
// the part of the screen the step is about; white frames point at details.
//
// Early steps only explain, so the overlay blocks the game and Next moves on.
// From the spectrogram walkthrough on, the whole screen is open and steps wait
// for the player: a step's Next button can wait on a condition, or the step
// moves on by itself once its task is done. Conditions are polled every frame
// through TutorialHost, so main.ts needs no tutorial hooks of its own.

import type { SpectrogramView } from './spectrogram';
import { PASS_WINDOW_S, type TutorialPlan } from './tutorial-round';
import { typewrite, type Typing } from './typewriter';

/**
 * The round the tutorial is scripted for: a seed and the settings it was
 * picked with, as a scenario string (settings.ts). The tutorial puts those
 * settings in place for its round only; the player's own come back after.
 */
export const TUTORIAL_SCENARIO = '222955-11A000Z052S262S2S0A0A0A0A0A0A0A0U120C0A080A05040P0I0A0J06010206010201030206';

/** The people by the tram at the first pass that the player marks; the target is one of them. */
export const TUTORIAL_CANDIDATES = ['P-74935', 'P-13218', 'P-33484', 'P-14474', 'P-04900'] as const;
/** People taken off the tutorial's map because they would muddle the lesson. */
export const TUTORIAL_REMOVED = ['P-46200'] as const;

/** What the tutorial reads from the game. */
export interface TutorialHost {
  spectro: SpectrogramView;
  /** Whether the Transportation data (trams) has been bought. */
  tramsUnlocked(): boolean;
  /** IDs of the people marked right now. */
  marked(): string[];
  /** ID of the person in the inspector, or null. */
  selectedPerson(): string | null;
  /** The round's target. */
  targetId(): string | null;
  /** Whether the target is within range of any cell tower right now. */
  targetInTowerRange(): boolean;
  /** Whether the target's data has been revealed through a tower. */
  targetRevealed(): boolean;
  /** null while nobody is arrested, else whether the arrest was the target. */
  arrestResult(): boolean | null;
  /** The playhead, s. */
  time(): number;
  /** The round's tram passes, decoy and bell (tutorial-round.ts), or null if it has none. */
  plan(): TutorialPlan | null;
  /** What the target panel tells about the target, e.g. "Age: 74. Occupation: Retired engineer." */
  targetFacts(): string;
  /** Rings these people on the map, or clears the rings with null. */
  highlight(people: PeopleHighlight | null): void;
}

/** People ringed on the map: 'hint' for who to look at, 'wrong' for who to drop. */
export interface PeopleHighlight {
  ids: string[];
  tone: 'hint' | 'wrong';
}

type Area = Element | DOMRect | null;
type Target = () => Area;
/** Where the briefing box sits: screen centre, map centre, bottom of the map, bottom of the screen. */
type Place = 'center' | 'map' | 'map-bottom' | 'bottom';

interface Step {
  /** A function is read when the step opens, for text that depends on the round. */
  text: string | (() => string);
  /**
   * The dark overlay: 'all' darkens the whole screen, a target darkens all
   * but it. Either way the game is blocked. Omitted, the game is open.
   */
  spot?: 'all' | Target;
  /** White frames around these. */
  frames?: Target[];
  place: Place;
  /** The Next button: shown always (default), once the condition holds, or never (see `advance`). */
  next?: boolean | (() => boolean);
  /** Moves on by itself once this holds. */
  advance?: () => boolean;
  /** Ends the tutorial: its button says Finish and closes the box. */
  last?: boolean;
  /** People to ring on the map right now, or null for none. */
  people?: () => PeopleHighlight | null;
}

const $ = (id: string) => document.getElementById(id);
const q = (sel: string) => document.querySelector(sel);

/** The bounding box of several elements. */
function union(...sels: string[]): Target {
  return () => {
    const rects = sels.map((s) => q(s)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && r.width > 0);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  };
}

function rectOf(area: Area): DOMRect | null {
  if (!area) return null;
  const r = area instanceof DOMRect ? area : area.getBoundingClientRect();
  return r.width > 0 || r.height > 0 ? r : null;
}

/** Space around a framed area, px. */
const FRAME_PAD = 4;

function buildSteps(h: TutorialHost): { steps: Step[]; fail: Step } {
  const mapPanel: Target = () => $('map-panel');
  const spectroPanel: Target = () => $('spectro-panel');
  const span = (a: number, b: number): Target => () => h.spectro.rangeRect(a, b);
  const onlyTargetMarked = () => {
    const m = h.marked();
    return m.length === 1 && m[0] === h.targetId();
  };
  const atPass = (which: 'pass1' | 'pass2') => {
    const plan = h.plan();
    return !!plan && Math.abs(h.time() - plan[which]) <= PASS_WINDOW_S;
  };
  /** Exactly the candidates are marked. */
  const candidatesMarked = () => {
    const plan = h.plan();
    if (!plan) return h.marked().length > 0;
    const m = h.marked();
    return m.length === plan.candidates.length && plan.candidates.every((id) => m.includes(id));
  };
  /** At the first pass: the candidates, all right by the tram. */
  const firstPassPeople = (): PeopleHighlight | null => {
    const plan = h.plan();
    if (!plan || !atPass('pass1')) return null;
    return { ids: plan.candidates, tone: 'hint' };
  };
  /** At the second pass: the candidates who are now far from any tram and should be unmarked. */
  const secondPassPeople = (): PeopleHighlight | null => {
    const plan = h.plan();
    if (!plan || !atPass('pass2')) return null;
    const marked = h.marked();
    const ids = plan.decoys.filter((id) => marked.includes(id));
    return ids.length ? { ids, tone: 'wrong' } : null;
  };
  const countWord = (n: number) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][n] ?? String(n);
  const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

  const steps: Step[] = [
    {
      text: 'This is your terminal. Your task is to find the suspect and arrest them. For that you have a set of tools at your disposal.',
      spot: 'all',
      place: 'center',
    },
    {
      text: 'This is the map of the area where the suspect is known to be.',
      spot: mapPanel,
      place: 'map',
    },
    {
      text: "This is the person we are looking for. We don't have all of their information right now.",
      spot: mapPanel,
      frames: [() => $('target')],
      place: 'map',
    },
    {
      text: 'We have access to additional layers that we can add to the map, but they come at a cost.',
      spot: mapPanel,
      frames: [union('.energy-panel', '#intel')],
      place: 'map',
    },
    {
      text: "This is the spectrogram. It's a visual representation of the sounds heard by the suspect's device.",
      spot: spectroPanel,
      place: 'map-bottom',
    },
    {
      text: 'On the horizontal axis we have the time. You can scrub through it with the mouse and zoom in with the scroll wheel.',
      spot: spectroPanel,
      frames: [() => h.spectro.areas().timeAxis],
      place: 'map-bottom',
    },
    {
      text: 'On the vertical axis we have the frequency. The higher up something is, the higher its pitch.',
      spot: spectroPanel,
      frames: [() => h.spectro.areas().freqAxis],
      place: 'map-bottom',
    },
    {
      text: 'Finally, the brighter the color, the louder the sound was.',
      spot: spectroPanel,
      frames: [() => h.spectro.areas().plot],
      place: 'map-bottom',
    },
    {
      text:
        'You can see several shapes and bright spots in the recording. ' +
        "Let's inspect the period from 0:25 to 1:13. Zoom in on it and play it (Space bar) to hear it.\n" +
        'When you are ready, click Next.',
      frames: [span(25, 73)],
      place: 'map-bottom',
    },
    {
      text: 'The wavy part is the sound of an ambulance in the distance, but did you notice the loud event at 0:35? That sounded like a tram passing really nearby.',
      frames: [span(32, 38)],
      place: 'map-bottom',
    },
    {
      text: "Let's use that to narrow our search. Purchase the Transportation data from the Data Access panel.",
      frames: [() => q('#intel-buttons > button')],
      place: 'map-bottom',
      next: false,
      advance: h.tramsUnlocked,
    },
    {
      text: () =>
        'Now we can see the exact locations of all the trams in the area. ' +
        'Move the playhead to the brightest part, where we can hear the tram, and look at the map. ' +
        'Zoom in on the trams, select the people who are really near them (within a few meters) and mark them.' +
        'Select a person and in the Inspector panel you can MARK them.' +
        (h.plan() ? ` There are ${countWord(h.plan()!.candidates.length)} of them.` : ''),
      frames: [span(32, 38)],
      place: 'map-bottom',
      next: candidatesMarked,
      people: firstPassPeople,
    },
    {
      text:
        'If you zoom out on the spectrogram, you might notice another short loud event at 1:42. ' +
        'If you listen to it, you will hear that it is another tram passing close by.',
      frames: [span(97, 105)],
      place: 'map-bottom',
      people: secondPassPeople,
    },
    {
      text:
        'Now we have to check if any of our marked people are within a few meters of a tram again. ' +
        'Unmark anyone who is far from a tram at this point in time. ' +
        'If there is no one left, that means you missed someone. Go back and forth between the two events.\n' +
        'Hint: you can add tags to the timeline so you can navigate it more easily.',
      place: 'map-bottom',
      next: onlyTargetMarked,
      people: secondPassPeople,
    },
    {
      text: () => {
        const bell = h.plan()?.bell;
        if (!bell) return "We have a suspect. We might have the correct person, but it's good to double check.";
        return (
          `We have a suspect near ${bell.name}. ` +
          "We might have the correct person, but it's good to double check. " +
          `One thing that might confirm it: if you listen carefully between ${clock(bell.start)} and ${clock(bell.end)}, you can hear church bells. ` +
          'That builds strong suspicion, but it is not a confirmation.'
        );
      },
      frames: [
        () => {
          const bell = h.plan()?.bell;
          return bell ? h.spectro.rangeRect(bell.start, bell.end) : null;
        },
      ],
      place: 'map-bottom',
    },
    {
      text:
        'We can confirm it if we get their information. The pink towers around the map are cell phone towers. ' +
        'They collect information about the people connected to them, but only when those people are near them.',
      place: 'map-bottom',
    },
    {
      text: 'Keep an eye on our suspect and move the timeline to a time when they are in range of a cell tower we can access.',
      place: 'map-bottom',
      next: h.targetInTowerRange,
    },
    {
      text: 'Select the tower they are closest to and activate Reveal User Data.',
      frames: [() => q('#inspector [data-action="reveal-data"]')],
      place: 'map-bottom',
      next: false,
      advance: h.targetRevealed,
    },
    {
      text: "Now select the suspect and let's see if they match.",
      place: 'map-bottom',
      next: false,
      advance: () => h.selectedPerson() === h.targetId(),
    },
    {
      text: () => `${h.targetFacts()} It's a match.\nWhenever you are ready, you can send out the arrest warrant.`,
      frames: [() => q('#inspector .btn-arrest')],
      place: 'map-bottom',
      next: false,
      // Moving on after a correct arrest is handled for every step, see frame()
    },
    {
      text:
        'Now you know everything you need to locate and arrest suspects. Move on to your next mission. ' +
        "The nation's safety depends on you. Good luck!",
      place: 'bottom',
      last: true,
    },
  ];
  const fail: Step = {
    text: "That's not our suspect, and they got away this time. Press Try again to replay the tutorial.",
    place: 'bottom',
    last: true,
  };
  return { steps, fail };
}

export class Tutorial {
  private readonly root = document.createElement('div');
  private readonly blocker = document.createElement('div');
  private readonly spot = document.createElement('div');
  private readonly frameEls: HTMLElement[] = [];
  private readonly box = document.createElement('div');
  private readonly count: HTMLElement;
  private readonly full: HTMLElement;
  private readonly typed: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly steps: Step[];
  private readonly fail: Step;

  private step: Step | null = null;
  private index = 0;
  private typing: Typing | null = null;
  /** Bumped on every step change, so an old step's typing stops. */
  private run = 0;
  private raf = 0;
  /** Where the player dragged the box to; it stays there until the tutorial restarts. */
  private dragged: { left: number; top: number } | null = null;

  constructor(private readonly host: TutorialHost) {
    ({ steps: this.steps, fail: this.fail } = buildSteps(host));

    this.root.className = 'tutorial hidden';
    this.blocker.className = 'tut-blocker';
    this.spot.className = 'tut-spot';
    this.box.className = 'panel tut-box';
    this.box.innerHTML = `
      <div class="tut-head" title="Drag to move">
        <span class="title">BRIEFING</span><span class="tut-count"></span>
      </div>
      <div class="tut-text"><span class="tut-full"><span></span><span class="cursor"></span></span><span class="tut-typed"><span></span><span class="cursor"></span></span></div>
      <div class="tut-actions">
        <button class="tut-exit">Exit tutorial</button>
        <button class="tut-next">Next</button>
      </div>`;
    this.root.append(this.blocker, this.spot, this.box);
    document.body.appendChild(this.root);

    this.count = this.box.querySelector('.tut-count')!;
    this.textEl = this.box.querySelector('.tut-text')!;
    this.full = this.box.querySelector('.tut-full > span')!;
    this.typed = this.box.querySelector('.tut-typed > span')!;
    this.nextBtn = this.box.querySelector('.tut-next')!;

    this.nextBtn.addEventListener('click', () => {
      this.nextBtn.blur(); // so Space plays the clip instead of pressing Next again
      if (this.step?.last) this.stop();
      else this.show(this.index + 1);
    });
    this.box.querySelector('.tut-exit')!.addEventListener('click', () => this.stop());
    // A click on the box or the dark overlay shows the whole text
    this.box.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.typing?.skip();
    });
    this.blocker.addEventListener('click', () => this.typing?.skip());
    this.initDrag();
  }

  get active(): boolean {
    return this.step !== null;
  }

  /** True while a step explains part of the screen and the game is shut behind the overlay. */
  get blocking(): boolean {
    return this.step?.spot !== undefined;
  }

  start() {
    this.dragged = null;
    this.root.classList.remove('hidden');
    this.show(0);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.host.highlight(null);
    this.run++;
    this.step = null;
    this.typing = null;
    cancelAnimationFrame(this.raf);
    this.root.classList.add('hidden');
  }

  private show(i: number) {
    this.index = i;
    this.present(this.steps[i]);
    this.count.textContent = `${i + 1} / ${this.steps.length}`;
  }

  private present(step: Step) {
    this.step = step;
    const run = ++this.run;
    const text = typeof step.text === 'function' ? step.text() : step.text;
    this.full.textContent = text; // invisible, with its own cursor: holds the box at its final size so nothing shifts
    const node = document.createTextNode('');
    this.typed.replaceChildren(node);
    this.textEl.classList.add('typing');
    this.nextBtn.textContent = step.last ? 'Finish' : 'Next';
    this.root.classList.toggle('blocking', step.spot !== undefined);
    const typing = typewrite(node, text, { live: () => run === this.run });
    this.typing = typing;
    void typing.done.then((finished) => {
      if (finished && run === this.run) this.textEl.classList.remove('typing');
    });
    this.update();
  }

  private readonly frame = () => {
    if (!this.step) return;
    const result = this.host.arrestResult();
    // An arrest ends the case whatever step the player is on
    if (result !== null && !this.step.last) {
      if (result) this.show(this.steps.length - 1);
      else {
        this.present(this.fail);
        this.count.textContent = '';
      }
    } else if (this.step.advance?.()) {
      this.show(this.index + 1);
    }
    this.update();
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Follows the layout every frame: panels resize, the spectrogram zooms, the inspector changes. */
  private update() {
    const step = this.step;
    if (!step) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Spotlight: a hole in a huge shadow. No hole at the centre darkens everything;
    // a hole a little bigger than the screen darkens nothing.
    let hole: DOMRect;
    if (step.spot === 'all') hole = new DOMRect(vw / 2, vh / 2, 0, 0);
    else if (step.spot) hole = rectOf(step.spot()) ?? new DOMRect(vw / 2, vh / 2, 0, 0);
    else hole = new DOMRect(-20, -20, vw + 40, vh + 40);
    setBox(this.spot, hole);

    const frames = (step.frames ?? []).map((t) => rectOf(t()));
    while (this.frameEls.length < frames.length) {
      const el = document.createElement('div');
      el.className = 'tut-frame';
      this.root.insertBefore(el, this.box);
      this.frameEls.push(el);
    }
    this.frameEls.forEach((el, i) => {
      const r = frames[i];
      el.hidden = !r;
      if (r) setBox(el, new DOMRect(r.left - FRAME_PAD, r.top - FRAME_PAD, r.width + 2 * FRAME_PAD, r.height + 2 * FRAME_PAD));
    });

    this.host.highlight(step.people?.() ?? null);

    const next = step.next ?? true;
    this.nextBtn.hidden = !(typeof next === 'function' ? next() : next);

    this.placeBox(step.place);
  }

  private placeBox(place: Place) {
    const s = this.box.style;
    if (this.dragged) {
      // Keep it on screen if the window shrank
      const r = this.box.getBoundingClientRect();
      s.left = `${Math.min(Math.max(0, this.dragged.left), Math.max(0, window.innerWidth - r.width))}px`;
      s.top = `${Math.min(Math.max(0, this.dragged.top), Math.max(0, window.innerHeight - r.height))}px`;
      s.transform = 'none';
      return;
    }
    const map = $('map-panel')!.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const [x, y, dy] =
      place === 'center' ? [vw / 2, vh / 2, '-50%']
      : place === 'map' ? [map.left + map.width / 2, map.top + map.height / 2, '-50%']
      : place === 'map-bottom' ? [map.left + map.width / 2, map.bottom - 16, '-100%']
      : [vw / 2, vh - 32, '-100%'];
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.transform = `translate(-50%, ${dy})`;
  }

  /** The box can be dragged by its header, so it never sits on top of what the player needs. */
  private initDrag() {
    const head = this.box.querySelector<HTMLElement>('.tut-head')!;
    let grab: { x: number; y: number } | null = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = this.box.getBoundingClientRect();
      grab = { x: e.clientX - r.left, y: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!grab) return;
      this.dragged = { left: e.clientX - grab.x, top: e.clientY - grab.y };
      this.placeBox('center');
    });
    const end = () => (grab = null);
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }
}

function setBox(el: HTMLElement, r: DOMRect) {
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

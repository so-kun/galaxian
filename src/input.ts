/**
 * Controls, mapped onto the cabinet's inputs.
 *
 * IN0 at $6000 carries coin, P1 left/right/shoot, the cabinet type and the test
 * and service switches; IN1 at $6800 carries the start buttons. We only surface
 * what a player needs.
 */

export interface InputState {
  left: boolean;
  right: boolean;
  fire: boolean;
  /** 1P start ($6800 bit 0). */
  start: boolean;
  /** 2P start ($6800 bit 1). */
  start2: boolean;
  /** Coin ($6000 bit 0). */
  coin: boolean;
}

const KEY_MAP: Record<string, keyof InputState> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'fire',
  KeyZ: 'fire',
  Enter: 'start',
  Digit1: 'start',
  Digit2: 'start2',
  Digit5: 'coin',
  KeyC: 'coin',
};

export class Input {
  readonly state: InputState = {
    left: false,
    right: false,
    fire: false,
    start: false,
    start2: false,
    coin: false,
  };
  private touch: Partial<InputState> = {};

  attach(target: EventTarget = window): void {
    target.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent, true));
    target.addEventListener('keyup', (e) => this.onKey(e as KeyboardEvent, false));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    this.state[action] = down;
  }

  /**
   * Touch controls: the left third of the screen steers left, the right third
   * steers right, and the middle fires.
   */
  attachTouch(element: HTMLElement): void {
    const update = (touches: TouchList) => {
      this.touch = {};
      for (let i = 0; i < touches.length; i++) {
        const t = touches[i]!;
        const third = t.clientX / element.clientWidth;
        if (third < 0.35) this.touch.left = true;
        else if (third > 0.65) this.touch.right = true;
        else this.touch.fire = true;
      }
      this.state.left = this.state.left || !!this.touch.left;
      this.state.right = this.state.right || !!this.touch.right;
      this.state.fire = !!this.touch.fire;
    };

    const handle = (e: TouchEvent) => {
      e.preventDefault();
      this.state.left = false;
      this.state.right = false;
      this.state.fire = false;
      // A tap acts as coin + 1P start so the game is reachable on a phone; the
      // session edge-detects the coin, so holding a touch adds only one credit.
      this.state.start = e.touches.length > 0;
      this.state.coin = e.touches.length > 0;
      update(e.touches);
    };

    element.addEventListener('touchstart', handle, { passive: false });
    element.addEventListener('touchmove', handle, { passive: false });
    element.addEventListener('touchend', handle, { passive: false });
  }
}

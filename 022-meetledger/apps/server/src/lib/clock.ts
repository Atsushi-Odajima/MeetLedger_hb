export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Test clock: time can be moved forward deterministically. */
export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(d: Date | string) {
    this.t = new Date(d);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

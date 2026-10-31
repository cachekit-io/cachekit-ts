// A/A probe: allocates garbage at load, so every window starts at another point
// in the GC schedule while no measured code changes.
export const ballastLength: number = Array.from({ length: 20_000 }, (_, i) => ({ i })).length;

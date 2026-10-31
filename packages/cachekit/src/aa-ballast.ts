// A/A probe: retains 50,000 objects from load on, so every window runs on a
// larger live heap and at another point in the GC schedule, while no measured
// code changes.
const ballast: object[] = Array.from({ length: 50_000 }, (_, i) => ({ i }));
export const ballastLength: number = ballast.length;
export const keepBallast = (): object[] => ballast;

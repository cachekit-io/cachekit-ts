// Probe for the instruction-count gate: an API only the head has.
export const probeSum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

let generation = 0;

export function getLicenseGeneration(): number {
  return generation;
}

export function advanceLicenseGeneration(): number {
  generation += 1;
  return generation;
}

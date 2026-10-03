// Read-only deployment contract. The runtime migrates this shared store on
// startup; Control Center must check it before spawning a sealed release.
export const companionCardDatabase = Object.freeze({
  minimumReadable: 0,
  maximumReadable: 6,
  migrationTarget: 6,
  relativePath: 'engineering-cards.sqlite',
});

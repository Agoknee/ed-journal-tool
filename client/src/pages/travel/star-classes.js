/**
 * Star classes as the journal's StartJump logs them, with a name for the filter and a colour for
 * the galaxy map (roughly the star's real colour, pushed a little for contrast against space).
 */
const MAIN_SEQUENCE = {
  O: { name: 'Blue', color: '#8fb0ff' },
  B: { name: 'Blue-white', color: '#a9c2ff' },
  A: { name: 'White', color: '#d4e0ff' },
  F: { name: 'Yellow-white', color: '#fff6e0' },
  G: { name: 'Yellow', color: '#ffe38a' },
  K: { name: 'Orange', color: '#ffb05e' },
  M: { name: 'Red dwarf', color: '#ff7048' },
  L: { name: 'Brown dwarf', color: '#d0563a' },
  T: { name: 'Brown dwarf', color: '#a84a35' },
  Y: { name: 'Brown dwarf', color: '#81402f' },
  TTS: { name: 'T Tauri', color: '#ffa27a' },
  AeBe: { name: 'Herbig Ae/Be', color: '#c6d2ff' },
  N: { name: 'Neutron star', color: '#5ff0ff' },
  H: { name: 'Black hole', color: '#c77dff' },
  SupermassiveBlackHole: { name: 'Supermassive black hole', color: '#ff4fd8' },
  X: { name: 'Exotic', color: '#7dffb0' },
  RoguePlanet: { name: 'Rogue planet', color: '#8b919e' },
  Nebula: { name: 'Nebula', color: '#ff8fd0' },
  StellarRemnantNebula: { name: 'Stellar remnant nebula', color: '#ff8fd0' },
  MS: { name: 'MS-type', color: '#ff6a3d' },
  S: { name: 'S-type', color: '#ff6a3d' },
};

/** Stars a fuel scoop works on ("KGB FOAM"). */
const SCOOPABLE = new Set(['K', 'G', 'B', 'F', 'O', 'A', 'M']);

const GIANTS = {
  A_BlueWhiteSuperGiant: 'Blue-white supergiant (A)',
  B_BlueWhiteSuperGiant: 'Blue-white supergiant (B)',
  F_WhiteSuperGiant: 'White supergiant (F)',
  G_WhiteSuperGiant: 'White supergiant (G)',
  K_OrangeGiant: 'Orange giant (K)',
  M_RedGiant: 'Red giant (M)',
  M_RedSuperGiant: 'Red supergiant (M)',
};

const UNKNOWN_COLOR = '#9aa3b5';

/** { name, color, isScoopable } for a star class code. */
export function describeStarClass(starClass) {
  if (!starClass) return { name: 'Unknown star', color: UNKNOWN_COLOR, isScoopable: false };
  const mainSequence = MAIN_SEQUENCE[starClass];
  if (mainSequence) {
    const isNamedByCode = starClass.length <= 4 && !['N', 'H', 'X'].includes(starClass);
    return { name: isNamedByCode ? `${starClass} · ${mainSequence.name}` : mainSequence.name, color: mainSequence.color, isScoopable: SCOOPABLE.has(starClass) };
  }
  if (GIANTS[starClass]) {
    const base = starClass[0];
    return { name: GIANTS[starClass], color: MAIN_SEQUENCE[base].color, isScoopable: SCOOPABLE.has(base) };
  }
  // White dwarfs (DA, DAB, DC, ...), Wolf-Rayet stars (W, WC, WN, ...) and carbon stars (C, CN, CJ, ...).
  if (/^D/.test(starClass)) return { name: `White dwarf (${starClass})`, color: '#eef6ff', isScoopable: false };
  if (/^W/.test(starClass)) return { name: `Wolf-Rayet (${starClass})`, color: '#b4a2ff', isScoopable: false };
  if (/^C/.test(starClass)) return { name: `Carbon star (${starClass})`, color: '#ff5a3c', isScoopable: false };
  return { name: starClass, color: UNKNOWN_COLOR, isScoopable: false };
}

/** A star class's label for the filter, marking the ones a fuel scoop works on. */
export function getStarClassLabel(starClass) {
  const { name, isScoopable } = describeStarClass(starClass);
  return isScoopable ? `${name} (scoopable)` : name;
}

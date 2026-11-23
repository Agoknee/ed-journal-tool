/** Odyssey components (ship locker "assets"), by lowercased name, with their type. */
const COMPONENT_TYPES = {
  "aerogel": "Chemicals",
  "carbon fibre plating": "Tech",
  "chemical catalyst": "Chemicals",
  "chemical superbase": "Chemicals",
  "circuit board": "Circuits",
  "circuit switch": "Circuits",
  "electrical fuse": "Circuits",
  "electrical wiring": "Circuits",
  "electromagnet": "Circuits",
  "encrypted memory chip": "Tech",
  "epinephrine": "Chemicals",
  "epoxy adhesive": "Chemicals",
  "graphene": "Chemicals",
  "ion battery": "Circuits",
  "memory chip": "Tech",
  "metal coil": "Circuits",
  "micro hydraulics": "Tech",
  "micro supercapacitor": "Circuits",
  "micro thrusters": "Tech",
  "micro transformer": "Circuits",
  "microelectrode": "Circuits",
  "motor": "Circuits",
  "optical fibre": "Circuits",
  "optical lens": "Tech",
  "oxygenic bacteria": "Chemicals",
  "rdx": "Chemicals",
  "scrambler": "Tech",
  "titanium plating": "Tech",
  "transmitter": "Tech",
  "tungsten carbide": "Tech",
  "viscoelastic polymer": "Chemicals",
  "weapon component": "Tech",
  "ph neutraliser": "Chemicals",
};

/** The type of an Odyssey component (Chemicals, Circuits or Tech) by its name, or null. */
export function getComponentType(name) {
  return COMPONENT_TYPES[String(name ?? '').toLowerCase()] ?? null;
}

/**
 * Icons from Inara's icon font (stored in public/inara/fonts): material grade glyphs (grade 1
 * "very common" to grade 5 "very rare") and the Odyssey component types (chemicals, circuits, tech).
 */
const GRADE_GLYPHS = { 1: '\ue843', 2: '\ue842', 3: '\ue841', 4: '\ue840', 5: '\ue83f' };
const GRADE_NAMES = { 1: 'Very common', 2: 'Common', 3: 'Standard', 4: 'Rare', 5: 'Very rare' };
const COMPONENT_GLYPHS = { Chemicals: '\ue83e', Circuits: '\ue83d', Tech: '\ue83c' };

// Odyssey components (ship locker "assets") by name, with their type.
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

/** A material's grade as Inara's grade glyph, coloured by grade; nothing for an unknown grade. */
export function MaterialGradeIcon({ grade }) {
  if (!GRADE_GLYPHS[grade]) return <span className="inara-glyph material-grade-icon material-grade-unknown" title="Grade unknown">?</span>;
  return (
    <span className={`inara-glyph material-grade-icon material-grade-${grade}`} title={`Grade ${grade} · ${GRADE_NAMES[grade]}`} aria-label={`Grade ${grade}`}>
      {GRADE_GLYPHS[grade]}
    </span>
  );
}

/** The type glyph for an Odyssey component (Chemicals, Circuits or Tech), by the component's name. */
export function ComponentTypeIcon({ name }) {
  const type = COMPONENT_TYPES[String(name ?? '').toLowerCase()];
  if (!COMPONENT_GLYPHS[type]) return null;
  return <span className="inara-glyph component-type-icon" title={type} aria-label={type}>{COMPONENT_GLYPHS[type]}</span>;
}

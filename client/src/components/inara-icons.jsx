import { getComponentType } from '../game-data/odyssey-components.js';
import './inara-icons.css';

/**
 * Icons from Inara's icon font (stored in public/inara/fonts): material grade glyphs (grade 1
 * "very common" to grade 5 "very rare") and the Odyssey component types (chemicals, circuits, tech).
 */
const GRADE_GLYPHS = { 1: '\ue843', 2: '\ue842', 3: '\ue841', 4: '\ue840', 5: '\ue83f' };
const GRADE_NAMES = { 1: 'Very common', 2: 'Common', 3: 'Standard', 4: 'Rare', 5: 'Very rare' };
const COMPONENT_GLYPHS = { Chemicals: '\ue83e', Circuits: '\ue83d', Tech: '\ue83c' };

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
  const type = getComponentType(name);
  if (!COMPONENT_GLYPHS[type]) return null;
  return <span className="inara-glyph component-type-icon" title={type} aria-label={type}>{COMPONENT_GLYPHS[type]}</span>;
}

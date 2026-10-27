// Non-standard, publisher-specific behaviours. Each entry cleans a fetched document before rendering.
// Delete an entry (or this file and its two lines in viewer.js) once the pattern is retired.

// Getty marks elements that must not be rendered with a `deprecated` (or `_deprecated`) member.
const DEPRECATED = ['deprecated', '_deprecated'];
const isDeprecated = (o) => o && typeof o === 'object' && DEPRECATED.some((k) => k in o);

const dropDeprecated = (node) => {
  if (Array.isArray(node)) return node.filter((n) => !isDeprecated(n)).map(dropDeprecated);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node)
      .filter(([k, v]) => !(DEPRECATED.includes(k) || isDeprecated(v)))
      .map(([k, v]) => [k, dropDeprecated(v)]));
  }
  return node;
};

// Getty puts the URL in the `id` of an embedded web page or image and omits the embedded DigitalObject with an
// `access_point` that the Digital Links pattern requires. Synthesise it from the `id` of works that declare a `format`.
const LINKS = { subject_of: [['LinguisticObject', 'InformationObject'], 'digitally_carried_by'], representation: ['VisualItem', 'digitally_shown_by'] };
// Getty gives IIIF manifests a generic `conforms_to`; the version is only in the `format` profile, so prefer that.
const conformsTo = (w) => {
  const profile = /profile="?([^";]+)"?/.exec(w.format ?? '')?.[1];
  return profile ? [{ id: profile, type: 'InformationObject' }] : w.conforms_to;
};
const embedAccessPoint = (node) => {
  if (Array.isArray(node)) return node.map(embedAccessPoint);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => {
    const [type, via] = LINKS[k] ?? [];
    const fix = (w) => ([].concat(type).includes(w?.type) && w.id && w.format && !w[via]
      ? { ...w, [via]: [{ type: 'DigitalObject', format: w.format, conforms_to: conformsTo(w), access_point: [{ id: w.id, type: 'DigitalObject' }] }] } : w);
    return [k, embedAccessPoint(type ? [].concat(v).map(fix) : v)];
  }));
};

export const workarounds = [dropDeprecated, embedAccessPoint];
export const clean = (doc) => workarounds.reduce((d, w) => w(d), doc);

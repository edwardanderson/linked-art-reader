// Usage: index.html?uri=<linked art JSON URL>  (no uri shows the search form)
import { clean } from './workarounds.js';

const TEMPLATES = './templates.json';

// Linked Art media type first; fall back for servers that 406 on it but serve JSON.
const ACCEPT = 'application/ld+json;profile="https://linked.art/ns/v1/linked-art.json", application/json;q=0.9, */*;q=0.1';

// Third-party probes must not hold up the page; a slow host just falls back to a plain label.
const TIMEOUT_MS = 5000;

const cache = new Map();

// Be polite to other people's servers: at most MAX_PER_ORIGIN probes in flight per origin,
// and a probe that failed is remembered for a day so reloads and navigation don't repeat it.
const MAX_PER_ORIGIN = 2;
const FAIL_TTL_MS = 24 * 60 * 60 * 1000;
const queues = new Map(); // origin -> { active, waiting: [] }
const failed = (uri) => Date.now() - (+localStorage.getItem(`miss2:${uri}`) || 0) < FAIL_TTL_MS;

function throttled(uri, task) {
  const origin = new URL(uri, location.href).origin;
  if (!queues.has(origin)) queues.set(origin, { active: 0, waiting: [] });
  const q = queues.get(origin);
  const next = () => {
    if (q.active >= MAX_PER_ORIGIN || !q.waiting.length) return;
    q.active++;
    q.waiting.shift()();
  };
  return new Promise((resolve) => {
    q.waiting.push(() => task().then(resolve).finally(() => { q.active--; next(); }));
    next();
  });
}

const fetchJson = (uri) => {
  if (!cache.has(uri)) {
    cache.set(uri, !URL.canParse(uri, location.href) || failed(uri) ? Promise.resolve(null) : throttled(uri, async () => {
      try {
        const r = await fetch(uri, { headers: { Accept: ACCEPT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.status === 429 || r.status >= 500) return null; // transient: ask again next time
        const j = await r.json();
        if (j && j.type) return clean(j); // probe: only accept Linked Art (typed JSON-LD)
      } catch (e) {
        if (e.name === 'TimeoutError') return null; // slow, not wrong: don't remember it
      }
      localStorage.setItem(`miss2:${uri}`, Date.now()); // not Linked Art, or blocked (CORS): remember
      return null;
    }));
  }
  return cache.get(uri);
};

const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids.filter((k) => k != null));
  return e;
};
const list = (v) => (v == null ? [] : [].concat(v));
// `id` matches the term itself or anything it is `equivalent` to: inline, else found by dereferencing it.
async function sameAs(obj, id) {
  if (obj.id === id || list(obj.equivalent).some((e) => e.id === id)) return true;
  const found = obj.id && (await fetchJson(obj.id));
  return !!found && list(found.equivalent).some((e) => e.id === id);
}

// `where` values are literals, "*" (present), or a nested object matched against any member of that property.
// An array value matches any of its literals.
// An `any` key holds a list of wheres; the object must match at least one.
// A `not` key holds a where (or a list of them); the object must match none.
async function matches(obj, where = {}) {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'fetch') continue;
    let ok;
    if (k === 'any') ok = await some(list(v), (w) => matches(obj, w));
    else if (k === 'not') ok = !(await some(list(v), (w) => matches(obj, w)));
    else if (v === '*') ok = obj[k] != null;
    else if (Array.isArray(v)) ok = v.includes(obj[k]);
    else if (k === 'id') ok = await sameAs(obj, v);
    else if (v && typeof v === 'object') ok = await some(list(obj[k]), (o) => o && matches(o, v));
    else ok = obj[k] === v;
    if (!ok) return false;
  }
  return true;
}
const some = async (items, test) => (await Promise.all(items.map(test))).some(Boolean);
const filter = async (items, test) => {
  const keep = await Promise.all(items.map(test));
  return items.filter((_, i) => keep[i]);
};

// The user's language as AAT URIs, in preference order (`templates.languages` maps codes to URIs).
const userLanguages = () =>
  [...new Set(navigator.languages.map((l) => templates.languages[l.split('-')[0].toLowerCase()]))].filter(Boolean);

// Display name: first Primary Name (matched by URI) in the user's language, else any Primary Name, else `_label`.
async function labelOf(obj) {
  const primary = await filter(list(obj.identified_by), (n) =>
    matches(n, { type: 'Name', classified_as: { id: templates.primaryName } }));
  for (const lang of userLanguages()) {
    const hit = (await filter(primary, (n) => matches(n, { language: { id: lang } })))[0];
    if (hit) return hit.content;
  }
  return primary[0]?.content ?? obj._label;
}
// A TimeSpan displays as its first Name, else its timestamps at the coarsest granularity that is still exact.
const LEVELS = ['year', 'month', 'day', 'time'];
function granularity(ts, isEnd) {
  const [, y, m, d, time] = ts.match(/^(-?\d+)-(\d\d)-(\d\d)T(.*)$/) ?? [];
  if (time == null) return 3;
  if (time !== (isEnd ? '23:59:59' : '00:00:00')) return 3;
  const [lastDay, lastMonth] = [new Date(Date.UTC(+y, +m, 0)).getUTCDate(), 12];
  if (isEnd ? +d !== lastDay : +d !== 1) return 2;
  return (isEnd ? +m !== lastMonth : +m !== 1) ? 1 : 0;
}
function dateText(ts) {
  const name = list(ts.identified_by).find((n) => n.type === 'Name' && n.content);
  if (name) return name.content;
  const [b, e] = [ts.begin_of_the_begin, ts.end_of_the_end];
  const level = Math.max(b ? granularity(b, false) : 0, e ? granularity(e, true) : 0);
  const cut = (v) => (v && (level === 3 ? v : v.slice(0, [4, 7, 10][level])));
  const [from, to] = [cut(b), cut(e)];
  return from && to && from !== to ? `${from} – ${to}` : from ?? to;
}

// `_label` is never rendered directly; it resolves through labelOf. `_date` formats a TimeSpan.
const valueAt = (obj, path) => (path === '_label' ? labelOf(obj) : path === '_date' ? dateText(obj) : obj[path]);

// Data is untrusted, so HTML content is rebuilt from a small allow-list of tags; only http(s) hrefs survive.
const SAFE_TAGS = new Set(['A', 'B', 'BR', 'EM', 'I', 'LI', 'OL', 'P', 'STRONG', 'SUB', 'SUP', 'U', 'UL']);
function sanitize(html) {
  const clean = (node) => {
    const out = document.createDocumentFragment();
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out.append(n.textContent);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (/^(SCRIPT|STYLE)$/.test(n.tagName)) continue; // their text is code, not content
        const kids = clean(n);
        if (!SAFE_TAGS.has(n.tagName)) { out.append(kids); continue; } // unknown tag: keep its text, drop the tag
        const e = document.createElement(n.tagName);
        if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') ?? '')) {
          Object.assign(e, { href: n.getAttribute('href'), target: '_blank', rel: 'noopener noreferrer' });
        }
        e.append(kids);
        out.append(e);
      }
    }
    return out;
  };
  return clean(new DOMParser().parseFromString(html, 'text/html').body);
}

// A record is worth opening in-app only if it says more than the reference we already hold.
const hasMore = (found, ref) => Object.keys(found).some((k) => k !== '@context' && !(k in ref));

// A group heading that links to its classification: external at first, upgraded to an in-app link if the term is Linked Art.
function headingLink(term, text) {
  if (!term.id) return el('span', null, String(text).replaceAll('_', ' ')); // a plain name (e.g. an assigned_property string) has nowhere to link to
  const box = el('span', null, viewLink(term.id, text, false));
  if (term.id) fetchJson(term.id).then((found) => found && hasMore(found, term) && box.replaceChildren(viewLink(term.id, text, true)));
  return box;
}

// Internal links re-point the viewer (`id` carries the URI); a separate ↗ link leaves the app.
const viewLink = (uri, text, internal) => {
  const label = el(internal ? 'a' : 'span', null, text);
  label.id = uri;
  if (internal) label.href = `?uri=${encodeURIComponent(uri)}`;
  const out = el('a', 'external', '↗\uFE0E');
  Object.assign(out, { href: uri, target: '_blank', rel: 'noopener', title: 'Open source in new tab' });
  out.setAttribute('aria-label', `Open ${text} in new tab`);
  return el('span', null, label, ' ', out);
};

const OTHER = Symbol('other'); // group key for classifications with a single member
let templates;
let claimed = []; // the current page's fields that select a subset of a property with `where`

// Resolve `extends`, merging parent -> child (match is merged, other keys replaced).
function shape(name) {
  const s = templates.shapes[name];
  if (!s.extends) return s;
  const parent = shape(s.extends);
  return { ...parent, ...s, match: { ...parent.match, ...s.match } };
}

// The shape with the most specific (largest) matching `match` wins.
async function pickShape(obj) {
  const names = Object.keys(templates.shapes).filter((n) => n !== '_default' && shape(n).match);
  const best = (await filter(names, (n) => matches(obj, shape(n).match)))
    .sort((a, b) => Object.keys(shape(b).match).length - Object.keys(shape(a).match).length)[0];
  return shape(best ?? '_default');
}

// Data is untrusted: only http(s) values are embedded, and the frame is sandboxed.
function embedFrame(template, value, cls) {
  if (!/^https?:/i.test(value)) return '';
  const f = el('iframe', cls);
  Object.assign(f, { src: template.replace('{}', encodeURIComponent(value)), title: 'Embedded viewer', loading: 'lazy', allowFullscreen: true });
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
  return f;
}

// Render every value a field points at (in order), as one block or a ul.
async function renderField(field, obj, level) {
  if (field.text) return [field.text]; // literal text, no data
  if (field.icon) { // the site's favicon, fetched from its own origin (no third party); hidden if it fails to load
    if (!URL.canParse(obj.id ?? '')) return [];
    const img = el('img', 'favicon');
    Object.assign(img, { src: new URL('/favicon.ico', obj.id).href, alt: '', width: 16, height: 16, onerror: () => img.remove() });
    return [img];
  }
  let values = Array.isArray(field.path)
    ? [(await Promise.all(field.path.map((p) => valueAt(obj, p)))).filter(Boolean).join(field.join ?? ' ')]
    : await filter(list(await valueAt(obj, field.path)), (v) => matches(v, field.where));
  values = values.filter((v) => v !== '');
  if (field.prefer) { // `prefer`: ordered wheres; keep only the first match of the first one that has any
    let best = [];
    for (const w of field.prefer) if (!best.length) best = (await filter(values, (v) => matches(v, w))).slice(0, 1);
    values = best;
  }
  if (field.unclaimed) { // drop values that another field on this page claims via its `where`
    const claims = claimed.filter((c) => c.path === field.path);
    values = await filter(values, async (v) => !(await some(claims, (c) => matches(v, c.where))));
  }
  if (!values.length) return [];

  if (field.groupBy) { // one labelled sub-section per distinct value of `groupBy` (e.g. each classification); unclassified values come first
    const groups = new Map([[null, []]]);
    // Meta-types (the type of a type, e.g. "Brief Text") describe the classification, so never head a group:
    // those nested on a sibling's own classified_as, plus any ids the template lists in `groupIgnore`.
    // `groupBy` may list several paths: the first one a value has is used (e.g. classified_as, else assigned_property).
    // Plain strings are treated as unlinked names.
    const paths = list(field.groupBy);
    const termsOf = (v, p) => list(v[p]).map((g) => (typeof g === 'string' ? { _label: g } : g));
    const meta = new Set(field.groupIgnore);
    values.forEach((v) => paths.forEach((p) => termsOf(v, p).forEach((g) => list(g.classified_as).forEach((m) => meta.add(m.id)))));
    // Values sharing the same set of classifications form one group, so a multi-classified value appears once, under a heading naming them all.
    for (const v of values) {
      const kinds = paths.map((p) => termsOf(v, p).filter((g) => !meta.has(g.id))).find((k) => k.length) ?? [];
      const key = kinds.length ? kinds.map((g) => g.id ?? g._label).sort().join(' ') : null;
      if (key == null) { groups.get(null).push(v); continue; }
      if (!groups.has(key)) {
        const links = await Promise.all(kinds.map(async (g) => headingLink(g, await valueAt(g, '_label'))));
        groups.set(key, { label: el('span', null, ...links.flatMap((l, i) => (i ? [' · ', l] : [l]))), items: [] });
      }
      groups.get(key).items.push(v);
    }
    // A group needs at least two members to earn a sub-section; lone values are gathered under "Other".
    const other = [];
    for (const [key, g] of groups) {
      if (key == null || g.items.length > 1) continue;
      groups.delete(key);
      other.push(...g.items);
    }
    if (field.groupDefault) { // the template names the catch-all group instead, and it goes last
      const rest = [...groups.get(null), ...other];
      groups.delete(null);
      groups.set(null, rest);
    }
    if (!field.groupDefault && other.length) groups.set(OTHER, { label: 'Other', items: other });
    const sub = { ...field, groupBy: undefined, unclaimed: false, where: undefined }; // items are already selected
    return (await Promise.all([...groups].map(async ([key, g]) => {
      // Inside a classification's sub-section the heading already names it, so don't repeat it as a tag; "Other" keeps its tags.
      const [items, label] = key == null ? [g, field.groupDefault ?? field.label] : key === OTHER ? [g.items, g.label] : [g.items.map((v) => ({ ...v, ...Object.fromEntries(paths.map((p) => [p, undefined])) })), g.label];
      return items.length ? renderField({ ...sub, label }, { [field.path]: items }, level) : [];
    }))).flat();
  }

  const asHtml = field.path === 'content' && obj.format === 'text/html'; // LinguisticObject content declares its format
  const text = (v) => (asHtml ? sanitize(String(v)) : field.words ? String(v).replaceAll('_', ' ') : String(v)); // `words`: snake_case shown as words
  const nodes = values.map((v) =>
    typeof v === 'object' ? renderObject(v, field.use)
      : field.element === '' ? text(v) // '' = bare text, no wrapper
      : field.embed ? embedFrame(field.embed, String(v), field.class) // `embed`: an iframe whose URL template holds the value as {}
      : el(field.element ?? 'p', field.class, field.link && obj.id ? viewLink(obj.id, String(v), obj._linkedArt) : text(v)));
  const body = nodes.length > 1 || field.list ? el('ul', null, ...nodes.map((n) => el('li', null, n))) : nodes[0];
  const wrapped = field.class && typeof values[0] === 'object' ? el('div', field.class, body) : body;
  return [field.label && el(`h${level}`, null, field.label), field.before, wrapped];
}

// `level` is the heading level for field labels: h3 under a section's h2, deeper inside nested shapes.
async function renderFields(fields = [], obj, level = 3) {
  return (await Promise.all(fields.map((f) => renderField(f, obj, level)))).flat();
}

async function buildObject(obj, s) {
  const cls = (s.class ?? '{type}').replace('{type}', obj.type ?? '');
  const heading = s.heading && el(s.heading.element ?? 'h3', null, s.heading.text ?? (await valueAt(obj, s.heading.path)));
  return el(s.element ?? 'div', cls, heading, ...(await renderFields(s.fields, obj, 4)));
}

// Returns a container at once and fills it in later, so slow lookups never block painting the rest of the page.
// Shapes with `fetch` first paint from the inline data, then swap in the dereferenced record (an in-app link) if it is Linked Art.
function renderObject(obj, shapeName) {
  const slot = el('span', 'slot'); // stable container: the placeholder may not be attached yet when the content is ready
  (async () => {
    const s = shapeName ? shape(shapeName) : await pickShape(obj);
    const box = await buildObject(obj, s);
    slot.append(box);
    if (!s.match?.fetch || !obj.id) return;
    const found = await fetchJson(obj.id); // null when unreachable, blocked by CORS, or not Linked Art
    if (found && hasMore(found, obj)) box.replaceWith(await buildObject({ ...obj, ...found, _linkedArt: true }, s));
  })().catch(console.error);
  return slot;
}

// Pages extend like shapes; unknown types fall back to `_default`.
function page(name) {
  const p = templates.page[name];
  return p.extends ? { ...page(p.extends), ...p } : p;
}

async function renderPage(obj) {
  const page_ = page(obj.type in templates.page ? obj.type : '_default');
  // Start the title first so its lookups head the per-origin queue rather than waiting behind the sections'.
  const title = el(page_.title.element);
  title.id = 'title';
  title.textContent = obj._label ?? ''; // paint at once; the preferred-language name replaces it once its lookups finish
  valueAt(obj, page_.title.path).then((t) => t && (title.textContent = t));
  claimed = page_.sections.flatMap((n) => templates.sections[n].fields).filter((f) => f.where && f.path);
  const nav = el('nav');
  const tag = page_.tag && el('p', null, el('span', 'PageTag', page_.tag)); // label comes from the template, not `type`
  const content = el('div', null, el('header', null, title, tag));
  // The table of contents mirrors the headings actually in the DOM (h2 > h3 > h4), so it follows content that arrives late.
  const link = (h, id) => {
    const a = el('a', null, h.textContent.replace(/\s*↗\uFE0E?/g, '').trim());
    a.href = `#${id}`;
    return a;
  };
  // Ids come from the section and the heading's position within it (not arrival order or late-filled text),
  // so they are stable across loads and a shared #fragment keeps working.
  const counts = new Map();
  const headingId = (h) => {
    const id = h.closest('section').id;
    if (h.tagName === 'H2') return `${id}-heading`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return `${id}-${counts.get(id)}`;
  };
  let scrolled = !location.hash; // sections arrive late, so honour the URL's #fragment once its target exists
  const buildNav = () => {
    const top = el('ul', null, el('li', null, Object.assign(el('a', null, page_.tag ?? title.textContent), { href: '#title' }))); // first entry: the page itself, named by its tag
    let sub, subsub;
    for (const h of content.querySelectorAll('h2, h3, h4')) {
      h.id ||= headingId(h);
      const li = el('li', null, link(h, h.id));
      if (h.tagName === 'H2') { top.append(li); sub = null; subsub = null; }
      else if (top.children.length < 2) continue;
      else if (h.tagName === 'H3') { sub ??= top.lastChild.appendChild(el('ul')); sub.append(li); subsub = null; }
      else { const host = sub?.lastChild ?? top.lastChild; subsub = host.querySelector(':scope > ul') ?? host.appendChild(el('ul')); subsub.append(li); }
    }
    const open = new Set([...nav.querySelectorAll('details[open] > summary a')].map((x) => x.hash));
    for (const li of top.querySelectorAll('li:has(> ul)')) { // collapse children behind a toggle
      const [a, ul] = li.children;
      const d = el('details', null, el('summary', null, a), ul);
      d.open = open.has(a.hash);
      a.addEventListener('click', () => (d.open = true)); // following a section reveals its children
      li.replaceChildren(d);
    }
    nav.replaceChildren(top);
    if (!scrolled) { const t = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (t) { scrolled = true; t.scrollIntoView(); } }
  };
  let queued = false;
  new MutationObserver(() => queued || (queued = requestAnimationFrame(() => { queued = false; buildNav(); }))).observe(content, { childList: true, subtree: true });
  buildNav();
  // Sections arrive in template order as they resolve, so the title and shell paint at once.
  const built = page_.sections.map(async (name) => {
    const s = templates.sections[name];
    const body = await renderFields(s.fields, obj);
    return body.length ? Object.assign(el('section', null, s.title && el('h2', null, s.title), ...body), { id: `section-${name}` }) : null;
  });
  (async () => { for (const p of built) { const sec = await p; if (sec) content.append(sec); } })().catch(console.error);
  return el('section', obj.type, el('div', 'Layout', el('aside', null, nav), content));
}

const uri = new URLSearchParams(location.search).get('uri');
const app = document.getElementById('app');
if (!uri) {
  // Index page: just the centred search form.
  app.remove();
  document.getElementById('search').hidden = false;
} else {
  templates = await (await fetch(TEMPLATES)).json();
  const isUrl = /^https?:$/.test(URL.canParse(uri, location.href) ? new URL(uri, location.href).protocol : '');
  localStorage.removeItem(`miss2:${uri}`); // an explicit request always retries
  const data = isUrl && await fetchJson(uri);
  const back = el('a', null, 'Search again');
  back.href = location.pathname;
  app.replaceChildren(data ? await renderPage(data) : el('p', null, isUrl
    ? `Could not load ${uri} (the server may not allow cross-origin requests). `
    : `"${uri}" is not a URL. Enter an http(s) URI of a Linked Art resource. `, back));
}

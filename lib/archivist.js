/**
 * L'archiviste d'etat — PASSE 2 : ce que le modele juge, ce que le code recopie.
 *
 * Principe de conception (le seul qui compte) : un modele resume bien et
 * recopie mal. Le resume litteraire de la compaction standard ecrase donc ce
 * qui doit survivre BRUT — le dernier etat d'un fichier, une sortie d'erreur
 * exacte. Ici la repartition est inverse de l'habitude :
 *
 *   le MODELE juge      : l'objectif, l'avancement, le SAVOIR NEGATIF (pieges,
 *                         suppositions refutees, constats contre-intuitifs), les
 *                         decisions, et QUELS artefacts doivent survivre ;
 *   le CODE recopie     : les artefacts retenus, mot pour mot, a partir de la
 *                         region ombree — jamais a partir de ce que le modele
 *                         en dit — plus le grand livre des fichiers (calcule).
 *
 * Rien ne disparait en silence : un appel que le modele n'a ni retenu ni ecarte
 * laisse une ligne-souche ; un identifiant invente par le modele est ignore ; un
 * depassement de budget est NOMME dans le point de controle.
 */
import { applySupersession, callLine, clip, fileLedger } from './ledger.js'

export const FORMAT = 'boost-compaction/1'
export const CHECKPOINT_OPEN = '<state-checkpoint'
export const LEDGER_HEADING = '## FILE LEDGER'
export const OPERATIONAL_HEADING = '## IN-FLIGHT & OPERATIONAL STATE'
import { renderOperationalLedger } from './ledger.js'
export const VERBATIM_HEADING = '## VERBATIM ARTIFACTS'

export const DEFAULTS = Object.freeze({
  enabled: true,
  fallback: true,
  maxInputChars: 1_200_000,
  resultChars: 6000,
  userChars: 8000,
  assistantChars: 2000,
  argsChars: 500,
  maxArtifactChars: 24_000,
  verbatimBudgetChars: 200_000,
  maxStubs: 150,
})

/** Les sections que le modele redige, dans l'ordre canonique du point de controle. */
export const NARRATIVE_SECTIONS = Object.freeze([
  'OBJECTIVE',
  'PROGRESS',
  'NEGATIVE KNOWLEDGE',
  'DECISIONS AND INVARIANTS',
  'WORKSPACE STATE',
  'ACTION LOG',
  'OPEN QUESTIONS',
])

export class ArchivistError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArchivistError'
    this.code = code
  }
}

export const PERSONA = [
  'You are the STATE ARCHIVIST of a coding-agent session that is being compacted. You never narrate. You write the registry another agent will resume from with NO other memory of this session.',
  '',
  'Rules, in priority order:',
  '1. Facts only, as terse bullets. No prose paragraphs, no "the agent then...", no pleasantries.',
  '2. NEGATIVE KNOWLEDGE is the most valuable section. Record every counter-intuitive discovery, trap, failed approach and WHY it failed, each followed by the artifact id that proves it. Record every assumption the session later found FALSE as `REFUTED: <belief> -> <reality> [id]`. An assumption that was never tested is NOT a fact: label it `UNVERIFIED`.',
  '3. Never paraphrase code, paths, commands, numbers or error messages. Quote them exactly, or reference an artifact id: the harness re-attaches the raw artifacts you keep. Do not retype file contents.',
  '4. Exploration noise: reads, searches and commands that turned out unrelated to the objective go to DROPPED (ids only), never to the action log.',
  '5. The harness already pruned superseded reads and absorbed edits. Describe only the LATEST state of each thing.',
  '6. KEEP VERBATIM lists the ids whose raw content must survive: the latest state of files still being worked on, exact error outputs that constrain future work, command outputs that are evidence for a decision. Prefer few and decisive ids. Any id you neither keep nor drop is reduced to a one-line stub.',
  '7. Use ONLY ids that appear in the timeline or the carried list. Never invent one.',
  '8. If a PRIOR NARRATIVE is given, MERGE it: keep what is still true, delete what is stale, never copy it forward blindly. Keep the ids of carried artifacts you still need.',
  '9. The user\'s requests are authoritative: quote the current objective\'s exact wording where it matters.',
  '10. IN-FLIGHT CONTINUITY: The harness deterministically tracks active tasks (todo_write), running subagents, user questions, and background jobs. In PROGRESS and NEXT, align with this in-flight state: state clearly what is currently running and the exact next step upon waking.',
  '',
  'Output EXACTLY these sections, in this order, each as a `## ` heading, writing `(none)` for an empty one:',
  '## OBJECTIVE',
  '- the goal being pursued, with exact wording of the latest user request when it matters',
  '## PROGRESS',
  '- DONE: item (evidence: id or test result)',
  '- IN PROGRESS: item',
  '- PENDING: item',
  '- NEXT: the single next action',
  '## NEGATIVE KNOWLEDGE',
  '## DECISIONS AND INVARIANTS',
  '## WORKSPACE STATE',
  '- per file or symbol: what it is NOW and what changed (the raw is attached via KEEP VERBATIM)',
  '## ACTION LOG',
  '- one line per meaningful action: what -> result',
  '## OPEN QUESTIONS',
  '## KEEP VERBATIM',
  '- comma-separated ids, or (none)',
  '## DROPPED',
  '- comma-separated ids judged irrelevant, or (none)',
].join('\n')

const idPattern = (id) => id

/** Texte d'un artefact tel que l'archiviste le voit, selon son statut. */
function renderArtifact(a, o, cap) {
  const args = clip(a.argsRaw, o.argsChars)
  if (a.status === 'superseded') return `[${a.id}] ${a.name} ${args} -> superseded by ${a.by} (result omitted)`
  if (a.status === 'absorbed') {
    return `[${a.id}] ${a.name} ${args} -> ${a.isError ? 'ERROR' : 'applied'}, absorbed by later read ${a.by}`
  }
  const tag = a.staleAfter.length > 0 ? `STALE: edited later by ${a.staleAfter.join(', ')}` : 'LIVE'
  const state = a.result === null ? 'NO RESULT' : a.isError ? 'ERROR' : 'ok'
  const body = a.result === null ? '' : clip(a.result, cap)
  return `[${a.id}] ${a.name} ${args}  (${tag}; ${state}; ${a.result?.length ?? 0} chars)\n${body}`
}

/**
 * Chronologie rendue pour l'archiviste. Si elle depasse `maxInputChars`, on
 * divise par deux le plafond par RESULTAT jusqu'a ce qu'elle tienne (planche : 200),
 * puis on coupe les plus anciens evenements — deterministe, et nomme.
 */
export function renderTimeline(events, options = {}) {
  const o = { ...DEFAULTS, ...options }
  let cap = o.resultChars
  for (;;) {
    const lines = events.map((e) => {
      if (e.type === 'user') {
        const k = e.source?.kind
        const isNotice = k === 'subagent-settled' || k === 'tool-jobs' || k === 'boost-channel' || k === 'agent-message'
        const uCap = isNotice ? Math.min(o.userChars, cap) : o.userChars
        const tag = isNotice ? `[SYSTEM NOTICE: ${k}]` : '[USER]'
        return `${tag} ${clip(e.text, uCap)}`
      }
      if (e.type === 'assistant') return `[ASSISTANT] ${clip(e.text, o.assistantChars)}`
      return renderArtifact(e.art, o, cap)
    })
    const total = lines.reduce((n, l) => n + l.length + 2, 0)
    if (total <= o.maxInputChars || cap <= 200) {
      let kept = lines
      let cutEvents = 0
      if (total > o.maxInputChars) {
        let size = total
        while (kept.length > 1 && size > o.maxInputChars) {
          size -= kept[0].length + 2
          kept = kept.slice(1)
          cutEvents += 1
        }
      }
      const head = cutEvents > 0 ? `[... ${cutEvents} oldest events omitted: the input budget was exceeded ...]\n\n` : ''
      return { text: head + kept.join('\n\n'), resultCap: cap, cutEvents, chars: total }
    }
    cap = Math.max(200, Math.floor(cap / 2))
  }
}

/** Le message que recoit l'archiviste (le persona va dans `system`). */
export function buildPrompt({ timeline, priorNarrative, carried, operational }) {
  const parts = []
  if (operational) {
    parts.push(`# CURRENT IN-FLIGHT & OPERATIONAL STATE (active tasks, running subagents, user decisions)\n${renderOperationalLedger(operational)}`)
  }
  if (priorNarrative) parts.push(`# PRIOR NARRATIVE (previous checkpoint; merge, do not copy)\n${priorNarrative}`)
  if (carried.length > 0) {
    const lines = carried.map((c) => `- ${c.id}  ${callLine(c, 120)}  (${c.result.length} chars, ${c.status}${c.staleAfter.length ? `, STALE: edited later by ${c.staleAfter.join(', ')}` : ''})  preview: ${clip(c.result.replace(/\s+/g, ' '), 200)}`)
    parts.push(`# CARRIED ARTIFACTS (raw content kept by earlier checkpoints; keep or drop by id)\n${lines.join('\n')}`)
  }
  parts.push(`# TIMELINE (oldest first; ids are in brackets)\n${timeline}`)
  parts.push('Write the registry now, in the exact section format given in your instructions.')
  return parts.join('\n\n')
}

// --------------------------------------------------------------------------
// Point de controle precedent : relu en machine, jamais devine.
// --------------------------------------------------------------------------

/**
 * Relit un point de controle du harnais. Reconnu comme le notre si `<state-checkpoint`
 * y figure ; sinon (resume standard) tout le texte est un recit antecedent, sans artefact.
 */
export function parsePriorOperationalText(text) {
  if (!text) return null
  const todos = []
  const subagents = []
  const userQuestions = []
  const backgroundJobs = []

  const todoRe = /^- (\[[x> ]\]) (.+?)(?: \((IN PROGRESS|DONE|PENDING)\))?$/gm
  let tm
  while ((tm = todoRe.exec(text)) !== null) {
    const mark = tm[1]
    const content = tm[2].trim()
    const status = mark === '[x]' ? 'completed' : mark === '[>]' ? 'in_progress' : 'pending'
    todos.push({ content, status })
  }

  const subRe = /^- \[([^\]]+)\] (\w+) \((?:agent: ([^ ]+) \(([^)]+)\)|([^)]+))\) \| "([^"]*)" -> (.*)$/gm
  let sm
  while ((sm = subRe.exec(text)) !== null) {
    const rawTag = sm[1]
    const status = rawTag.includes('RUNNING') ? 'RUNNING' : rawTag.includes('COMPLETED') ? 'COMPLETED' : 'FAILED'
    const name = sm[2]
    const agentId = sm[3] || null
    const id = sm[4] || sm[5]
    const desc = sm[6]
    const detail = sm[7]
    subagents.push({ id, name, agentId, desc, status, detail })
  }

  const uqRe = /^- \[([^\]]+)\] "([^"]*)" -> Decision: (.*)$/gm
  let uqm
  while ((uqm = uqRe.exec(text)) !== null) {
    userQuestions.push({
      status: uqm[1] === 'ANSWERED' ? 'ANSWERED' : 'AWAITING_USER',
      question: uqm[2],
      answer: uqm[3],
    })
  }
  const jobRe = /^- \[([^\]]+)\] (\w+) \(([^)]+)\): `([^`]*)`(?:\s+\("([^"]*)"\))?$/gm
  let jm
  while ((jm = jobRe.exec(text)) !== null) {
    backgroundJobs.push({
      status: jm[1],
      tool: jm[2],
      jobId: jm[3],
      id: jm[3],
      cmd: jm[4],
      label: jm[5] || '',
    })
  }

  return {
    todosRecord: todos.length > 0 ? { todos, source: 'prior-checkpoint' } : null,
    todos: todos.length > 0 ? todos : null,
    subagents,
    userQuestions,
    backgroundJobs,
  }
}

export function parsePriorCheckpoint(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const at = text.indexOf(CHECKPOINT_OPEN)
  if (at < 0) return { gen: 0, narrative: text.trim(), operational: null, artifacts: [], recognised: false }
  const open = /<state-checkpoint format="([^"]+)" gen="(\d+)">/.exec(text.slice(at))
  const gen = open ? Number(open[2]) : 0
  const bodyStart = open ? at + open.index + open[0].length : at
  const opAt = text.indexOf(OPERATIONAL_HEADING, bodyStart)
  const ledgerAt = text.indexOf(LEDGER_HEADING, bodyStart)
  const verbAt = text.indexOf(VERBATIM_HEADING, bodyStart)
  const narrativeEnd = [opAt, ledgerAt, verbAt].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? text.length
  const narrative = text.slice(bodyStart, narrativeEnd).trim()

  let operational = null
  if (opAt >= 0) {
    const opEnd = [ledgerAt, verbAt].filter((i) => i >= 0 && i > opAt).sort((a, b) => a - b)[0] ?? text.length
    operational = parsePriorOperationalText(text.slice(opAt, opEnd))
  }

  const artifacts = []
  if (verbAt >= 0) {
    let pos = text.indexOf('\n', verbAt) + 1
    for (;;) {
      const rest = text.slice(pos)
      const m = /^<artifact (\{.*\})>\n/.exec(rest)
      if (!m) break
      let head
      try {
        head = JSON.parse(m[1])
      } catch {
        break
      }
      if (!Number.isInteger(head.chars) || head.chars < 0) break
      const bodyAt = pos + m[0].length
      const body = text.slice(bodyAt, bodyAt + head.chars)
      if (body.length !== head.chars || text.slice(bodyAt + head.chars, bodyAt + head.chars + 13) !== '\n</artifact>\n') break
      artifacts.push({ head, body })
      pos = bodyAt + head.chars + 13
    }
  }
  return { gen, narrative, operational, artifacts, recognised: true }
}

/** Les artefacts retenus d'un point de controle precedent, comme des artefacts ordinaires, plus anciens que tout. */
export function carriedArtifacts(prior) {
  const items = prior?.artifacts ?? []
  return items.map(({ head, body }, i) => ({
    id: String(head.id),
    n: -(items.length - i),
    callId: undefined,
    name: String(head.tool ?? 'carried'),
    args: null,
    argsRaw: Array.isArray(head.keys) ? head.keys.join(', ') : '',
    kind: head.kind === 'read' || head.kind === 'write' ? head.kind : 'other',
    keys: Array.isArray(head.keys) ? head.keys.filter((k) => typeof k === 'string') : [],
    result: body,
    isError: head.err === true,
    status: 'live',
    by: null,
    staleAfter: [],
    carried: true,
  }))
}

// --------------------------------------------------------------------------
// Reponse de l'archiviste : lue strictement.
// --------------------------------------------------------------------------

export function parseResponse(text, knownIds) {
  const sections = new Map()
  const re = /^##[ \t]+(.+?)[ \t]*:?[ \t]*$/gm
  const marks = []
  let m
  while ((m = re.exec(text)) !== null) marks.push({ name: m[1].trim().toUpperCase(), at: m.index, end: m.index + m[0].length })
  marks.forEach((mark, i) => {
    const body = text.slice(mark.end, i + 1 < marks.length ? marks[i + 1].at : text.length).trim()
    if (!sections.has(mark.name)) sections.set(mark.name, body)
  })
  const empty = (b) => b === undefined || b.replace(/[\s\-*()]|none/gi, '') === ''
  for (const required of ['OBJECTIVE', 'PROGRESS']) {
    if (empty(sections.get(required))) throw new ArchivistError('malformed', `archivist response lacks a usable "${required}" section`)
  }
  const idsIn = (name) => {
    const found = new Set()
    const unknown = []
    for (const token of (sections.get(name) ?? '').match(/[A-Za-z0-9_.\-]+/g) ?? []) {
      if (knownIds.has(idPattern(token))) found.add(token)
      else if (/^G\d+-A\d+$/.test(token)) unknown.push(token)
    }
    return { found, unknown }
  }
  const keep = idsIn('KEEP VERBATIM')
  const drop = idsIn('DROPPED')
  // Un id a la fois retenu et ecarte : on RETIENT (perdre est irreversible, garder non).
  for (const id of keep.found) drop.found.delete(id)
  return { sections, keep: keep.found, drop: drop.found, unknownIds: [...keep.unknown, ...drop.unknown] }
}

// --------------------------------------------------------------------------
// Assemblage : le code recopie.
// --------------------------------------------------------------------------

function artifactBlock(a, maxChars) {
  const body = clip(a.result ?? '', maxChars)
  const head = { id: a.id, tool: a.name, kind: a.kind, err: a.isError, chars: body.length, keys: a.keys }
  return { text: `<artifact ${JSON.stringify(head)}>\n${body}\n</artifact>\n`, clipped: body !== (a.result ?? '') }
}

function stubLine(a) {
  const outcome = a.result === null ? 'NO RESULT' : a.isError ? `ERROR ${clip(a.result.replace(/\s+/g, ' '), 200)}` : 'ok'
  return `- ${a.id} | ${callLine(a, 140)} | ${outcome}`
}

/**
 * @param {object} input
 * @param {number} input.gen generation de ce point de controle
 * @param {Array} input.artifacts artefacts reportes + artefacts de la region, deja soumis a applySupersession
 * @param {Map<string,string>} input.sections sections redigees par le modele
 * @param {Set<string>} input.keep ids a recopier
 * @param {Set<string>} input.drop ids juges hors sujet
 */
export function assemble({ gen, artifacts, operational, sections, keep, drop, unknownIds = [], options = {} }) {
  const o = { ...DEFAULTS, ...options }
  const live = artifacts.filter((a) => a.status === 'live')
  const byId = new Map(artifacts.map((a) => [a.id, a]))

  // Ids a recopier : ceux que le modele retient (vivants), plus les ecritures qui completent une lecture perimee.
  const wanted = new Set()
  for (const id of keep) if (byId.get(id)?.status === 'live') wanted.add(id)
  for (const id of [...wanted]) for (const w of byId.get(id).staleAfter) if (byId.get(w)?.status === 'live') wanted.add(w)

  const ordered = live.filter((a) => wanted.has(a.id)).sort((a, b) => a.n - b.n)
  // Budget : le plus ANCIEN tombe d'abord (le report precedent avant la region courante).
  const blocks = ordered.map((a) => ({ a, ...artifactBlock(a, o.maxArtifactChars) }))
  let total = blocks.reduce((n, b) => n + b.text.length, 0)
  const budgetDropped = []
  while (blocks.length > 0 && total > o.verbatimBudgetChars) {
    const gone = blocks.shift()
    total -= gone.text.length
    budgetDropped.push(gone.a.id)
  }

  const stubs = live.filter((a) => !wanted.has(a.id) && !drop.has(a.id))
  // Les erreurs d'abord : une erreur sans souche serait la perte la plus couteuse.
  stubs.sort((a, b) => Number(b.isError) - Number(a.isError) || a.n - b.n)
  const shownStubs = stubs.slice(0, o.maxStubs).sort((a, b) => a.n - b.n)

  const out = []
  out.push(`${CHECKPOINT_OPEN} format="${FORMAT}" gen="${gen}">`)
  for (const name of NARRATIVE_SECTIONS) {
    const body = sections.get(name)
    out.push(`## ${name}\n${body === undefined || body === '' ? '(none)' : body}`)
  }

  if (operational) {
    out.push(`${OPERATIONAL_HEADING} (computed by the harness, not by a model)`)
    out.push(renderOperationalLedger(operational))
  }

  const rows = fileLedger(artifacts)
  out.push(`${LEDGER_HEADING} (computed by the harness, not by a model)`)
  out.push(rows.length === 0 ? '(none)' : rows.map((r) => `- ${r.key} | ${r.state} | last read: ${r.lastRead ?? '-'} | edits since: ${r.editsSince.join(', ') || '-'} | reads ${r.reads}, edits ${r.writes}`).join('\n'))

  const pruned = artifacts.filter((a) => a.status !== 'live')
  const notes = []
  const sup = pruned.filter((a) => a.status === 'superseded').length
  const abs = pruned.filter((a) => a.status === 'absorbed').length
  notes.push(`- pruned by rule: ${sup} superseded read(s), ${abs} edit(s) absorbed by a later read (their effect is in the later read)`)
  if (drop.size > 0) notes.push(`- dropped by the archivist as irrelevant: ${[...drop].join(', ')}`)
  if (budgetDropped.length > 0) notes.push(`- KEPT BUT NOT ATTACHED (verbatim budget ${o.verbatimBudgetChars} chars exceeded): ${budgetDropped.join(', ')}`)
  const clippedIds = blocks.filter((b) => b.clipped).map((b) => b.a.id)
  if (clippedIds.length > 0) notes.push(`- attached clipped at ${o.maxArtifactChars} chars (head+tail): ${clippedIds.join(', ')}`)
  if (unknownIds.length > 0) notes.push(`- ignored unknown ids cited by the archivist: ${unknownIds.join(', ')}`)
  out.push(`## HARNESS NOTES\n${notes.join('\n')}`)

  out.push(`## UNTRIAGED CALLS (one-line stubs; raw not retained)${stubs.length > shownStubs.length ? ` — showing ${shownStubs.length} of ${stubs.length}, errors first` : ''}`)
  out.push(shownStubs.length === 0 ? '(none)' : shownStubs.map(stubLine).join('\n'))

  out.push(VERBATIM_HEADING)
  const text = out.join('\n\n') + '\n' + blocks.map((b) => b.text).join('') + '</state-checkpoint>'
  return {
    text,
    stats: {
      gen,
      live: live.length,
      kept: blocks.length,
      stubs: stubs.length,
      superseded: sup,
      absorbed: abs,
      budgetDropped: budgetDropped.length,
      appendixChars: blocks.reduce((n, b) => n + b.text.length, 0),
      outputChars: 0,
    },
  }
}

/** Passe 1 sur le tout : region + report -> artefacts a jour, compteurs. */
export function reconcile(carried, regionArtifacts) {
  const all = [...carried, ...regionArtifacts]
  const stats = applySupersession(all)
  return { all, stats }
}
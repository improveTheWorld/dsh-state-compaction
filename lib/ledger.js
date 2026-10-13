/**
 * Le grand livre deterministe de la compaction d'etat — PASSE 1, zero jeton.
 *
 * Ce module ne contient AUCUN appel de modele et AUCUNE dependance : il lit la
 * region de messages que le harnais s'apprete a ombrer et en tire des
 * ARTEFACTS (un appel d'outil + son resultat), puis decide, par regle, lesquels
 * restent la verite terrain et lesquels sont de la redondance de decouverte :
 *
 *   - une LECTURE est ECRASEE par une lecture ulterieure de la MEME adresse
 *     (un fichier lu quatre fois n'a qu'une version vivante : la derniere) ;
 *   - une ECRITURE est ABSORBEE par une lecture ulterieure d'une adresse
 *     apparentee (la lecture contient deja son effet) ;
 *   - une LECTURE suivie d'une ecriture apparentee n'est PLUS la verite : elle
 *     est marquee PERIMEE, et les ecritures qui la suivent restent vivantes —
 *     c'est la paire (derniere lecture + ecritures depuis) qui represente le
 *     fichier fidelement ;
 *   - tout le reste (commande, recherche, resultat en erreur) reste VIVANT :
 *     c'est au jugement de l'archiviste (passe 2) de dire ce qui est hors sujet.
 *
 * Les adresses sont celles de Scalpel : `chemin` ou `chemin::Classe::Methode`.
 * Deux adresses sont APPARENTEES quand elles sont egales ou que l'une est un
 * prefixe `::` de l'autre.
 *
 * Toute troncature compte en POINTS DE CODE (`Array.from`), jamais en index
 * UTF-16 : un indice brut coupe une paire de substitution en deux, et un
 * substitut isole dans un resultat d'outil tue la session (HTTP 400 mesure,
 * docs/UPSTREAM-SURROGATE.md).
 */

/** Outils qui LISENT un etat : nom -> arguments portant l'adresse (chaine ou liste). */
export const DEFAULT_READ_TOOLS = Object.freeze({
  read_block: ['path', 'paths'],
  read: ['file_path', 'path'],
  read_image: ['file_path'],
  read_unindexed: ['path', 'file_path'],
})

/** Outils qui ECRIVENT un etat : nom -> arguments portant l'adresse. */
export const DEFAULT_WRITE_TOOLS = Object.freeze({
  edit_block: ['path', 'edits'],
  insert_block: ['parent'],
  delete_block: ['path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  write_unindexed: ['path', 'file_path'],
  edit_unindexed: ['path', 'file_path'],
})

const EPHEMERAL_USER_SOURCES = Object.freeze(new Set([
  'time-context',
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'model-selection',
  'repeat-tool-reminder',
]))

/** Troncature tete + queue, en points de code. Rend le texte tel quel s'il tient. */
export function clip(text, max) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return s
  if (s.length <= max) return s // longueur UTF-16 >= points de code : tient, donc tient.
  const cps = Array.from(s)
  if (cps.length <= max) return s
  const head = Math.ceil(max * 0.65)
  const tail = Math.max(0, max - head)
  const cut = cps.length - head - tail
  return cps.slice(0, head).join('') + `\n[... ${cut} chars omitted ...]\n` + (tail > 0 ? cps.slice(cps.length - tail).join('') : '')
}

/** Texte d'un tableau de blocs : le texte tel quel, un repere pour le reste. */
export function blocksText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  const out = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block?.type === 'image') out.push('[image]')
    else if (block?.type === 'file') out.push('[file]')
    // 'reasoning' et les blocs de changement d'outils : du bruit pour le registre.
  }
  return out.join('\n')
}

/** Deux adresses Scalpel sont apparentees : egales, ou l'une prefixe `::` de l'autre. */
export function normalizeAddress(addr) {
  if (typeof addr !== 'string') return ''
  let s = addr.trim()
  if (s === '') return ''
  const sep = s.indexOf('::')
  if (sep >= 0) {
    return s.slice(0, sep).replace(/\\/g, '/') + s.slice(sep)
  }
  return s.replace(/\\/g, '/')
}

export function related(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const na = normalizeAddress(a)
  const nb = normalizeAddress(b)
  return na === nb || na.startsWith(nb + '::') || nb.startsWith(na + '::')
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Adresses portees par un appel, selon la table d'arguments de l'outil. */
export function addressesOf(args, argNames) {
  if (!args || !Array.isArray(argNames)) return []
  const out = []
  const push = (val) => {
    const norm = normalizeAddress(val)
    if (norm !== '' && !out.includes(norm)) out.push(norm)
  }
  for (const name of argNames) {
    const v = args[name]
    if (typeof v === 'string' && v !== '') push(v)
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item !== '') push(item)
        else if (item && typeof item === 'object') {
          if (typeof item.path === 'string' && item.path !== '') push(item.path)
          else if (typeof item.file_path === 'string' && item.file_path !== '') push(item.file_path)
        }
      }
    }
  }
  return out
}

/**
 * La region de messages -> { events, artifacts, priorCheckpoint }.
 *
 * `events` est la chronologie (user / assistant / artifact) ; `artifacts` l'index
 * des appels d'outils. Un resultat sans appel correspondant devient un artefact
 * orphelin plutot que d'etre jete : on s'abstient de deviner.
 */
export function parseRegion(messages, options = {}) {
  const readTools = options.readTools ?? DEFAULT_READ_TOOLS
  const writeTools = options.writeTools ?? DEFAULT_WRITE_TOOLS
  const idFor = options.idFor ?? ((n) => `A${n}`)
  const isCheckpoint = options.isCheckpoint ?? ((m) => m?.source?.kind === 'compact-checkpoint')
  const events = []
  const artifacts = []
  const byCall = new Map()
  let priorCheckpoint = null
  let counter = 0

  const open = (name, rawArgs, callId, syntheticResult = undefined, syntheticError = false) => {
    counter += 1
    const args = parseArgs(rawArgs)
    const readKeys = addressesOf(args, readTools[name])
    const writeKeys = addressesOf(args, writeTools[name])
    const kind = name in writeTools ? 'write' : name in readTools ? 'read' : 'other'
    const art = {
      id: idFor(counter),
      n: counter,
      callId,
      name,
      args,
      argsRaw: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? null),
      kind,
      keys: kind === 'write' ? writeKeys : kind === 'read' ? readKeys : [],
      result: syntheticResult !== undefined ? syntheticResult : null,
      isError: syntheticError === true,
      status: 'live', // live | superseded | absorbed
      by: null,
      staleAfter: [],
    }
    artifacts.push(art)
    if (callId !== undefined) byCall.set(callId, art)
    events.push({ type: 'artifact', art })
    return art
  }

  // Enregistrements PTC hors surface (tool/ptc-dispatch) Indexes par rootCallId
  const ptcByRoot = new Map()
  if (Array.isArray(options.ptcDispatches)) {
    for (const d of options.ptcDispatches) {
      const rootId = d?.rootCallId || d?.data?.rootCallId
      const payload = d?.data ?? d
      if (!rootId || !payload?.name) continue
      if (!ptcByRoot.has(rootId)) ptcByRoot.set(rootId, [])
      ptcByRoot.get(rootId).push(payload)
    }
  }

  for (const message of messages ?? []) {
    if (!message) continue
    if (message.role === 'user') {
      if (isCheckpoint(message)) {
        priorCheckpoint = blocksText(message.content)
        continue
      }
      const sourceKind = message.source?.kind
      if (sourceKind && EPHEMERAL_USER_SOURCES.has(sourceKind)) {
        continue
      }
      events.push({ type: 'user', text: blocksText(message.content), source: message.source ?? null })
    } else if (message.role === 'assistant') {
      const text = blocksText(message.content)
      if (text.trim() !== '') events.push({ type: 'assistant', text })
      for (const block of message.content ?? []) {
        if (block?.type === 'tool-call') {
          open(block.name, block.arguments, block.id)
          if (block.id && ptcByRoot.has(block.id)) {
            for (const sub of ptcByRoot.get(block.id)) {
              const subText = blocksText(sub.content)
              open(sub.name, sub.arguments, sub.subCallId, subText, sub.isError === true)
            }
          }
        }
      }
    } else if (message.role === 'tool') {
      let art = byCall.get(message.toolCallId)
      if (art === undefined) art = open('(orphan-result)', '{}', message.toolCallId)
      art.result = blocksText(message.content)
      art.isError = message.isError === true
    }
    // 'system' et 'developer' : ni intention ni preuve.
  }
  return { events, artifacts, priorCheckpoint }
}

/**
 * Applique les regles d'ecrasement et d'absorption, EN PLACE, et rend les compteurs.
 * Seules les lectures et ecritures REUSSIES comptent : un echec ne change aucun etat.
 */
export function applySupersession(artifacts) {
  const ok = (a) => a.result !== null && !a.isError
  const reads = artifacts.filter((a) => a.kind === 'read' && a.keys.length > 0 && ok(a))
  const writes = artifacts.filter((a) => a.kind === 'write' && a.keys.length > 0 && ok(a))
  const stats = { superseded: 0, absorbed: 0, stale: 0 }

  // 1. Lecture ecrasee par une lecture ulterieure de la MEME adresse (toutes ses adresses).
  for (const r of reads) {
    const later = reads.find((o) => o.n > r.n && r.keys.every((k) => o.keys.includes(k)))
    if (later) {
      r.status = 'superseded'
      r.by = later.id
      stats.superseded += 1
    }
  }
  // 2. Ecriture absorbee : une lecture ulterieure d'adresse apparentee la contient deja.
  for (const w of writes) {
    const later = reads.find((r) => r.n > w.n && r.keys.some((rk) => w.keys.some((wk) => related(rk, wk))))
    if (later) {
      w.status = 'absorbed'
      w.by = later.id
      stats.absorbed += 1
    }
  }
  // 3. Lecture encore vivante mais suivie d'ecritures apparentees : PERIMEE.
  for (const r of reads) {
    if (r.status !== 'live') continue
    const after = writes.filter((w) => w.n > r.n && w.status === 'live' && w.keys.some((wk) => r.keys.some((rk) => related(rk, wk))))
    if (after.length > 0) {
      r.staleAfter = after.map((w) => w.id)
      stats.stale += 1
    }
  }
  // 4. Todo supersession : un appel todo_write anterieur est ecrase par le dernier todo_write reussi.
  const todos = artifacts.filter((a) => a.name === 'todo_write' && ok(a))
  for (let i = 0; i < todos.length - 1; i++) {
    todos[i].status = 'superseded'
    todos[i].by = todos.at(-1).id
    stats.superseded += 1
  }
  // 5. Polling supersession : un appel list_agents ou job_list sans argument de filtre est ecrase par le dernier.
  for (const pollName of ['list_agents', 'job_list']) {
    const polls = artifacts.filter((a) => a.name === pollName && ok(a))
    for (let i = 0; i < polls.length - 1; i++) {
      polls[i].status = 'superseded'
      polls[i].by = polls.at(-1).id
      stats.superseded += 1
    }
  }
  return stats
}

/** Resume d'une ligne d'un artefact : outil + arguments, borne. */
export function callLine(art, max = 160) {
  const subject = art.keys.length > 0 ? art.keys.join(', ') : art.argsRaw
  return `${art.name} ${clip(String(subject).replace(/\s+/g, ' '), max)}`
}

/** Le grand livre par adresse : calcule, jamais redige par un modele. */
export function fileLedger(artifacts) {
  const byKey = new Map()
  for (const a of artifacts) {
    if ((a.kind !== 'read' && a.kind !== 'write') || a.result === null || a.isError) continue
    for (const key of a.keys) {
      if (!byKey.has(key)) byKey.set(key, { key, reads: [], writes: [] })
      byKey.get(key)[a.kind === 'read' ? 'reads' : 'writes'].push(a)
    }
  }
  const rows = []
  for (const { key, reads, writes } of byKey.values()) {
    const lastRead = reads.at(-1)
    const since = lastRead ? writes.filter((w) => w.n > lastRead.n) : writes
    let state
    if (!lastRead) state = 'EDITED-NEVER-READ'
    else if (since.length > 0) state = 'STALE-AFTER-EDITS'
    else state = 'CURRENT'
    rows.push({
      key,
      state,
      lastRead: lastRead?.id ?? null,
      editsSince: since.map((w) => w.id),
      reads: reads.length,
      writes: writes.length,
    })
  }
  return rows
}

export const SUBAGENT_TOOLS = Object.freeze(new Set([
  'subagent',
  'subagent_implement',
  'subagent_verify',
  'subagent_investigate',
  'subagent_fork',
]))

function extractActiveTodos(artifacts, events = [], prior = null) {
  let lastTodoIdx = -1
  let lastTodoArt = null

  for (let i = artifacts.length - 1; i >= 0; i--) {
    const a = artifacts[i]
    if (a.name === 'todo_write' && !a.isError && Array.isArray(a.args?.todos)) {
      lastTodoIdx = i
      lastTodoArt = a
      break
    }
  }

  // 1. Un todo_write explicite a ete trouve dans les artefacts
  if (lastTodoArt !== null) {
    const todos = lastTodoArt.args.todos.map((t) => ({
      content: typeof t.content === 'string' ? t.content : String(t.content ?? ''),
      status: typeof t.status === 'string' ? t.status : 'pending',
    }))

    const subsequentArtifacts = artifacts.slice(lastTodoIdx + 1)
    const subsequentWrites = subsequentArtifacts.filter((a) => a.kind === 'write')
    const subsequentTools = subsequentArtifacts.filter((a) => a.name !== 'todo_write')

    let activityAfter = null
    if (subsequentTools.length > 0) {
      const toolNames = [...new Set(subsequentTools.map((a) => a.name))]
      const writeTargets = [...new Set(subsequentWrites.flatMap((w) => w.keys || []))]
      activityAfter = {
        count: subsequentTools.length,
        tools: toolNames,
        writeTargets,
      }

      // Si toutes les taches etaient terminees mais que du travail a continue sans mise a jour du todo
      const allCompleted = todos.length > 0 && todos.every((t) => t.status === 'completed')
      if (allCompleted) {
        const continuationDetail = writeTargets.length > 0
          ? `Poursuivre les modifications sur ${writeTargets.slice(0, 2).join(', ')}`
          : `Poursuivre les travaux en cours (${toolNames.slice(0, 3).join(', ')})`
        todos.push({ content: continuationDetail, status: 'in_progress' })
      }
    }

    return {
      source: lastTodoArt.id,
      todos,
      activityAfter,
    }
  }

  // 2. Aucun todo_write direct, mais un prior porte des todos
  if (prior?.todos && Array.isArray(prior.todos) && prior.todos.length > 0) {
    const todos = prior.todos.map((t) => ({ ...t }))
    const subsequentArtifacts = artifacts.filter((a) => a.name !== 'todo_write')
    const subsequentWrites = subsequentArtifacts.filter((a) => a.kind === 'write')

    let activityAfter = null
    if (subsequentArtifacts.length > 0) {
      const toolNames = [...new Set(subsequentArtifacts.map((a) => a.name))]
      const writeTargets = [...new Set(subsequentWrites.flatMap((w) => w.keys || []))]
      activityAfter = {
        count: subsequentArtifacts.length,
        tools: toolNames,
        writeTargets,
      }

      const allCompleted = todos.length > 0 && todos.every((t) => t.status === 'completed')
      if (allCompleted) {
        const continuationDetail = writeTargets.length > 0
          ? `Poursuivre les modifications sur ${writeTargets.slice(0, 2).join(', ')}`
          : `Poursuivre les travaux en cours (${toolNames.slice(0, 3).join(', ')})`
        todos.push({ content: continuationDetail, status: 'in_progress' })
      }
    }

    return {
      source: prior.todosSource || 'carried-from-prior',
      todos,
      activityAfter,
    }
  }

  // 3. Aucun todo_write ni dans cette generation ni dans le prior
  // Auto-consolidation : synthese a partir de l activite observable (en ignorant les notifications systeme)
  const humanEvents = (events || []).filter((e) => {
    if (e.type !== 'user' || typeof e.text !== 'string' || e.text.trim() === '') return false
    const kind = e.source?.kind
    return !kind || kind === 'user'
  })
  const fallbackUserEvents = humanEvents.length > 0
    ? humanEvents
    : (events || []).filter((e) => e.type === 'user' && typeof e.text === 'string' && e.text.trim() !== '' && e.source?.kind !== 'subagent-settled' && e.source?.kind !== 'tool-jobs' && e.source?.kind !== 'boost-channel')
  const lastUserText = fallbackUserEvents.length > 0 ? fallbackUserEvents[fallbackUserEvents.length - 1].text.trim() : null
  const writes = artifacts.filter((a) => a.kind === 'write')

  if (lastUserText || artifacts.length > 0) {
    const syntheticTodos = []
    if (lastUserText) {
      const firstLine = lastUserText.split('\n')[0].replace(/^[#\s\-*]+/, '').trim()
      const brief = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
      syntheticTodos.push({ content: `Traiter la demande : "${brief}"`, status: 'in_progress' })
    } else if (writes.length > 0) {
      const targets = [...new Set(writes.flatMap((w) => w.keys || []))]
      const targetLabel = targets.length > 0 ? ` (${targets.slice(0, 2).join(', ')})` : ''
      syntheticTodos.push({ content: `Finaliser les modifications en cours${targetLabel}`, status: 'in_progress' })
    } else {
      syntheticTodos.push({ content: 'Poursuivre la mission en cours', status: 'in_progress' })
    }
    syntheticTodos.push({ content: 'Valider et verifier les resultats', status: 'pending' })

    const toolNames = [...new Set(artifacts.map((a) => a.name))]
    return {
      source: 'synthesized-from-activity',
      todos: syntheticTodos,
      activityAfter: artifacts.length > 0 ? { count: artifacts.length, tools: toolNames, writeTargets: [] } : null,
    }
  }

  return null
}

function extractSubagents(artifacts, events, prior) {
  const map = new Map()

  if (Array.isArray(prior?.subagents)) {
    for (const sub of prior.subagents) {
      if (sub.status === 'RUNNING') {
        map.set(sub.agentId || sub.id, { ...sub, carried: true })
      }
    }
  }

  for (const a of artifacts) {
    if (!SUBAGENT_TOOLS.has(a.name)) continue
    const desc = a.args?.description || a.args?.label || ''
    const brief = clip(a.args?.prompt || '', 160)
    let agentId = null
    if (a.result) {
      const uuidMatch = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(a.result)
      const startedMatch = /\bstarted\s+subagent\s+([a-zA-Z0-9_\-]+)/i.exec(a.result)
      const explicitMatch = /\bagent(?:\s+id)?\s*[:=]\s*([a-zA-Z0-9_\-]+)/i.exec(a.result)
      const tokenMatch = /\b(agent-[a-zA-Z0-9_\-]+)\b/i.exec(a.result)
      if (startedMatch) agentId = startedMatch[1]
      else if (uuidMatch) agentId = uuidMatch[1]
      else if (explicitMatch) agentId = explicitMatch[1]
      else if (tokenMatch && !/^agent-(?:preset|instructions|default|message|options|id)$/i.test(tokenMatch[1])) {
        agentId = tokenMatch[1]
      } else {
        try {
          const resObj = JSON.parse(a.result)
          if (resObj?.agent_id) agentId = resObj.agent_id
        } catch {}
      }
    }

    let status = 'RUNNING'
    let detail = null

    if (a.result === null) {
      status = 'RUNNING'
      detail = 'call in progress (no result yet)'
    } else if (a.isError) {
      status = 'FAILED'
      detail = clip(a.result.replace(/\s+/g, ' '), 120)
    } else if (a.args?.run_in_background === false) {
      status = 'COMPLETED'
      detail = clip(a.result.replace(/\s+/g, ' '), 160)
    } else {
      status = 'RUNNING'
      detail = agentId ? `agent: ${agentId}` : 'awaiting settlement'
    }

    const key = agentId || a.id
    map.set(key, {
      id: a.id,
      name: a.name,
      agentId,
      desc,
      brief,
      status,
      detail,
      n: a.n,
    })
  }

  for (const e of events) {
    const text = e.text || ''
    const senderId = e.source?.senderSessionId || null
    if (!text && !senderId) continue
    for (const [, sub] of map.entries()) {
      if (sub.status !== 'RUNNING') continue
      if (senderId && sub.agentId && senderId === sub.agentId && e.source?.kind === 'subagent-settled') {
        sub.status = 'COMPLETED'
        sub.detail = clip((text || e.source?.summary || 'settled').replace(/\s+/g, ' '), 160)
        continue
      }
      if (sub.agentId && text.includes(sub.agentId)) {
        if (/settled|finished|completed|exit code|settlement/i.test(text)) {
          sub.status = 'COMPLETED'
          sub.detail = clip(text.replace(/\s+/g, ' '), 160)
        }
      }
    }
  }

  return Array.from(map.values())
}

function extractUserQuestions(artifacts, prior) {
  const list = []
  if (Array.isArray(prior?.userQuestions)) {
    list.push(...prior.userQuestions.slice(-3))
  }

  for (const a of artifacts) {
    if (a.name !== 'ask_user_question') continue
    const questions = a.args?.questions
    let qText = ''
    if (Array.isArray(questions)) {
      qText = questions.map((q) => q.question || q.header || '').filter(Boolean).join('; ')
    } else if (typeof a.argsRaw === 'string') {
      qText = clip(a.argsRaw, 140)
    }

    let status = 'ANSWERED'
    let answerText = null

    if (a.result === null) {
      status = 'AWAITING_USER'
      answerText = 'waiting for user input'
    } else if (a.isError) {
      status = 'ERROR'
      answerText = clip(a.result, 120)
    } else {
      try {
        const parsed = JSON.parse(a.result)
        if (Array.isArray(parsed?.answers)) {
          answerText = parsed.answers
            .map((ans) => `${ans.id}: ${Array.isArray(ans.selected) ? ans.selected.join(', ') : ans.selected}`)
            .join('; ')
        }
      } catch {}
      if (!answerText) {
        answerText = clip(a.result.replace(/\s+/g, ' '), 150)
      }
    }

    list.push({
      id: a.id,
      question: qText,
      status,
      answer: answerText,
    })
  }

  return list.slice(-5)
}

function extractBackgroundJobs(artifacts, events = [], prior = null) {
  const map = new Map()

  if (Array.isArray(prior?.backgroundJobs)) {
    for (const job of prior.backgroundJobs) {
      if (job.status === 'RUNNING') map.set(job.jobId || job.id, { ...job })
    }
  }

  for (const a of artifacts) {
    if (a.name === 'run_detached' || (a.name === 'pwsh' && a.args?.run_in_background === true)) {
      const cmd = a.args?.command || a.args?.cmd || ''
      const label = a.args?.label || a.args?.description || ''
      let jobId = null
      if (a.result) {
        const m = /\b((?:job|pwsh|bash)-[a-zA-Z0-9_\-]+|[a-f0-9]{8,})\b/i.exec(a.result)
        if (m) jobId = m[1]
      }
      const key = jobId || a.id
      map.set(key, {
        id: a.id,
        tool: a.name,
        jobId,
        cmd: clip(cmd, 120),
        label,
        status: a.isError ? 'FAILED' : 'RUNNING',
      })
    } else if (a.name === 'job_kill') {
      const jid = a.args?.job_id
      if (jid && map.has(jid)) {
        map.get(jid).status = 'KILLED'
      }
    } else if (a.name === 'job_output') {
      const jid = a.args?.job_id
      if (jid && map.has(jid) && a.result && !a.isError) {
        if (/finished|completed|exit code/i.test(a.result) || a.args?.wait === true) {
          map.get(jid).status = 'FINISHED'
        }
      }
    }
  }

  for (const e of events || []) {
    const text = e.text || ''
    if (!text) continue
    for (const [, job] of map.entries()) {
      if (job.status !== 'RUNNING') continue
      const jid = job.jobId || job.id
      if (jid && text.includes(jid)) {
        if (/status:\s*failed|failed/i.test(text) && e.source?.kind === 'tool-jobs') {
          job.status = 'FAILED'
        } else if (/finished|completed|settled|exit code/i.test(text)) {
          job.status = 'FINISHED'
        }
      }
    }
  }

  return Array.from(map.values())
}

/** Le registre d etat operationnel : taches actives, sous-agents en vol, questions utilisateur. */
export function operationalLedger(artifacts, events = [], prior = null) {
  const activeTodos = extractActiveTodos(artifacts, events, prior)
  const subagents = extractSubagents(artifacts, events, prior)
  const userQuestions = extractUserQuestions(artifacts, prior)
  const backgroundJobs = extractBackgroundJobs(artifacts, events, prior)

  return {
    todosRecord: activeTodos,
    subagents,
    userQuestions,
    backgroundJobs,
  }
}

/** Restitution du registre d etat operationnel en Markdown strict. */
export function renderOperationalLedger(op) {
  if (!op) return '(none)'
  const lines = []

  // 1. Taches actives
  if (op.todosRecord?.todos && op.todosRecord.todos.length > 0) {
    const isSynth = op.todosRecord.source === 'synthesized-from-activity'
    const src = isSynth ? 'synthesized-from-activity (no explicit todo_write)' : op.todosRecord.source
    lines.push(`### Active Tasks (source: ${src})`)
    for (const t of op.todosRecord.todos) {
      const marker = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'
      const tag = t.status === 'in_progress' ? ' (IN PROGRESS)' : t.status === 'completed' ? ' (DONE)' : ' (PENDING)'
      lines.push(`- ${marker} ${t.content}${tag}`)
    }
    if (op.todosRecord.activityAfter && op.todosRecord.activityAfter.count > 0) {
      const { count, tools } = op.todosRecord.activityAfter
      const toolList = tools && tools.length > 0 ? ` (${tools.join(', ')})` : ''
      lines.push(`* Notice: ${count} tool operations${toolList} executed since this task board update.`)
    }
  } else {
    lines.push('### Active Tasks\n(none recorded)')
  }

  // 2. Sous-agents en vol ou completes (tous les RUNNING + les 12 derniers termines au plus)
  if (op.subagents && op.subagents.length > 0) {
    const running = op.subagents.filter((s) => s.status === 'RUNNING')
    const finished = op.subagents.filter((s) => s.status !== 'RUNNING')
    const maxFinished = 12
    const omittedFinished = Math.max(0, finished.length - maxFinished)
    const shownSubs = [...running, ...finished.slice(-maxFinished)]
    lines.push(`\n### Subagents & Delegations${omittedFinished > 0 ? ` (${omittedFinished} older completed delegations omitted)` : ''}`)
    for (const s of shownSubs) {
      const tag = s.status === 'RUNNING' ? '[RUNNING / IN-FLIGHT]' : s.status === 'COMPLETED' ? '[COMPLETED]' : '[FAILED]'
      const who = s.agentId ? `agent: ${s.agentId} (${s.id})` : s.id
      lines.push(`- ${tag} ${s.name} (${who}) | "${s.desc || s.brief}" -> ${s.detail || s.status}`)
    }
  } else {
    lines.push('\n### Subagents & Delegations\n(none active)')
  }

  // 3. Questions et decisions utilisateur
  if (op.userQuestions && op.userQuestions.length > 0) {
    lines.push('\n### User Decisions & Questions (ask_user_question)')
    for (const q of op.userQuestions) {
      const tag = q.status === 'ANSWERED' ? '[ANSWERED]' : '[AWAITING USER]'
      lines.push(`- ${tag} "${q.question}" -> Decision: ${q.answer}`)
    }
  }

  // 4. Jobs d arriere-plan (tous les RUNNING + les 10 derniers termines au plus)
  if (op.backgroundJobs && op.backgroundJobs.length > 0) {
    const runningJobs = op.backgroundJobs.filter((j) => j.status === 'RUNNING')
    const finishedJobs = op.backgroundJobs.filter((j) => j.status !== 'RUNNING')
    const maxFinishedJobs = 10
    const omittedJobs = Math.max(0, finishedJobs.length - maxFinishedJobs)
    const shownJobs = [...runningJobs, ...finishedJobs.slice(-maxFinishedJobs)]
    lines.push(`\n### Background Jobs${omittedJobs > 0 ? ` (${omittedJobs} older finished jobs omitted)` : ''}`)
    for (const j of shownJobs) {
      const tag = j.status === 'RUNNING' ? '[RUNNING]' : `[${j.status}]`
      lines.push(`- ${tag} ${j.tool} (${j.jobId || j.id}): \`${j.cmd}\` ${j.label ? `("${j.label}")` : ''}`)
    }
  }

  return lines.join('\n')
}

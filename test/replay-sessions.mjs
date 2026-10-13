import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { parseRegion, applySupersession, fileLedger, operationalLedger, renderOperationalLedger } from '../lib/ledger.js'
import { renderTimeline, buildPrompt, assemble, parsePriorCheckpoint, carriedArtifacts, reconcile } from '../lib/archivist.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function splitFrames(buf) {
  const offsets = []
  let pos = 0
  while (pos <= buf.length - 4) {
    const idx = buf.indexOf(MAGIC, pos)
    if (idx < 0) break
    offsets.push(idx)
    pos = idx + 4
  }
  const frames = []
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    frames.push(buf.subarray(start, end))
  }
  return frames
}

function readSessionRecords(filePath) {
  const raw = readFileSync(filePath)
  const frames = splitFrames(raw)
  const records = []
  let frameErrors = 0
  for (const f of frames) {
    try {
      const dec = zstdDecompressSync(f).toString('utf8')
      for (const line of dec.split('\n')) {
        if (!line.trim()) continue
        try {
          records.push(JSON.parse(line))
        } catch {}
      }
    } catch {
      frameErrors++
    }
  }
  return { frames: frames.length, frameErrors, records }
}

function extractMessages(records) {
  const messages = []
  for (const r of records) {
    if (r.type === 'user/message' && r.data) {
      messages.push(r.data)
    } else if (r.type === 'assistant/message' && r.data?.message) {
      messages.push(r.data.message)
    } else if (r.type === 'tool/result' && r.data?.message) {
      messages.push(r.data.message)
    } else if (r.role === 'user' || r.role === 'assistant' || r.role === 'tool') {
      messages.push(r)
    }
  }
  return messages
}

function analyzeSession(filePath) {
  const { frames, frameErrors, records } = readSessionRecords(filePath)
  const messages = extractMessages(records)
  const ptcDispatches = records.filter(r => r.type === 'tool/ptc-dispatch')
  const region = parseRegion(messages, { idFor: (n) => `G1-A${n}`, ptcDispatches })
  const stats = applySupersession(region.artifacts)
  const op = operationalLedger(region.artifacts, region.events)
  const rows = fileLedger(region.artifacts)
  const timeline = renderTimeline(region.events)

  const toolCounts = {}
  const unkeyedReadsWrites = []
  const errorTools = {}
  const orphanCount = region.artifacts.filter(a => a.name === '(orphan-result)').length
  const noResultCount = region.artifacts.filter(a => a.result === null).length

  for (const a of region.artifacts) {
    toolCounts[a.name] = (toolCounts[a.name] || 0) + 1
    if (a.isError) errorTools[a.name] = (errorTools[a.name] || 0) + 1
    if ((a.kind === 'read' || a.kind === 'write') && a.keys.length === 0) {
      unkeyedReadsWrites.push({ id: a.id, name: a.name, args: a.args })
    }
  }

  // Chercher les appels edit_block avec edits=[...] ou search_symbols/search_documents
  const batchEdits = region.artifacts.filter(a => a.name === 'edit_block' && Array.isArray(a.args?.edits))
  const searchSymbols = region.artifacts.filter(a => a.name === 'search_symbols')
  const searchDocs = region.artifacts.filter(a => a.name === 'search_documents')
  const runCodeCalls = region.artifacts.filter(a => a.name === 'run_code')
  const userSources = {}
  for (const m of messages) {
    if (m.role === 'user') {
      const k = m.source?.kind || 'none'
      userSources[k] = (userSources[k] || 0) + 1
    }
  }

  // Calculer la taille brute des messages vs timeline
  const rawChars = region.events.reduce((n, e) => n + (e.type === 'artifact' ? (e.art.result?.length ?? 0) + e.art.argsRaw.length : e.text.length), 0)

  return {
    file: filePath.split(/[\\/]/).slice(-2).join('/'),
    frames,
    frameErrors,
    totalRecords: records.length,
    messagesCount: messages.length,
    eventsCount: region.events.length,
    artifactsCount: region.artifacts.length,
    rawChars,
    timelineChars: timeline.chars,
    timelineResultCap: timeline.resultCap,
    timelineCutEvents: timeline.cutEvents,
    pass1Stats: stats,
    fileLedgerCount: rows.length,
    fileLedgerStates: rows.reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc }, {}),
    orphanCount,
    noResultCount,
    batchEditsCount: batchEdits.length,
    unkeyedReadsWritesCount: unkeyedReadsWrites.length,
    unkeyedSample: unkeyedReadsWrites.slice(0, 5),
    searchSymbolsCount: searchSymbols.length,
    searchDocsCount: searchDocs.length,
    runCodeCount: runCodeCalls.length,
    userSources,
    toolCounts,
    errorTools,
    operational: {
      todosSource: op.todosRecord?.source ?? null,
      todosCount: op.todosRecord?.todos?.length ?? 0,
      activityAfter: op.todosRecord?.activityAfter ?? null,
      subagentsCount: op.subagents.length,
      subagentsSample: op.subagents.slice(0, 5),
      userQuestionsCount: op.userQuestions.length,
      backgroundJobsCount: op.backgroundJobs.length,
      backgroundJobsSample: op.backgroundJobs.slice(0, 5),
    },
  }
}
function inspectDeep(filePath) {
  return analyzeSession(filePath)
}

function inspectStructures(records) {
  if (process.env.READ_PRESET === '3') {
    const p1 = 'C:\\Users\\bilel\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-command-compact\\lib\\index.js'
    const p2 = 'C:\\Users\\bilel\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-web-app\\cordis.patch.yml'
    console.log('=== dsh-command-compact ===\n' + readFileSync(p1, 'utf8'))
    const w = readFileSync(p2, 'utf8')
    const idx = w.indexOf('compaction')
    console.log('=== dsh-web-app compaction ===\n' + w.slice(Math.max(0, idx - 200), idx + 1000))
    process.exit(0)
  }
  return analyzeSession(process.argv[2])
}

const samplePath = process.argv[2]
if (samplePath && process.argv[3] === '--inspect') {
  const { records } = readSessionRecords(samplePath)
  console.log(JSON.stringify(inspectStructures(records), null, 2))
  process.exit(0)
}
if (samplePath) {
  const { frames, frameErrors, records } = readSessionRecords(samplePath)
  const types = {}
  for (const r of records) {
    const t = r.type || r.kind || r.event || (r.role ? `role:${r.role}` : 'unknown')
    types[t] = (types[t] || 0) + 1
  }
  console.log(JSON.stringify({ frames, frameErrors, totalRecords: records.length, types, sampleKeys: records.slice(0, 5).map(r => Object.keys(r)) }, null, 2))
}
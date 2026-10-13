// Tests de dsh-boost-compaction. Zero dependance : `node --test`.
//
//   node --test packages/boost-compaction/test/compaction.test.mjs
//
// Chaque cas ci-dessous tient une decision de conception, ou un defaut qui aurait
// livre un point de controle faux sans rien lever :
//   - une lecture n'est « ecrasee » que par une lecture REUSSIE de la MEME adresse ;
//   - une lecture suivie d'une ecriture apparentee est PERIMEE, pas ecrasee : c'est la
//     paire (derniere lecture + ecritures depuis) qui represente le fichier ;
//   - le modele juge, le code recopie : l'artefact retenu ressort MOT POUR MOT ;
//   - rien ne disparait en silence : un appel ni retenu ni ecarte laisse une souche,
//     une erreur d'abord ; un id invente est ignore et nomme ;
//   - un point de controle se relit sans perte a la generation suivante, meme si un
//     artefact contient la balise de fermeture ;
//   - l'echec de l'archiviste est OUVERT (resume standard) et JOURNALISE, sauf abandon.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applySupersession, clip, fileLedger, parseRegion, related } from '../lib/ledger.js'
import { ArchivistError, assemble, carriedArtifacts, parsePriorCheckpoint, parseResponse, reconcile, renderTimeline } from '../lib/archivist.js'
import { createStateCompactionEngine, findPrior, pickTarget, resolveArchivistConfig } from '../lib/engine.js'

// ---- fabriques de messages ---------------------------------------------------
let seq = 0
const call = (name, args) => {
  seq += 1
  return { id: `c${seq}`, name, args }
}
const asst = (...calls) => ({
  role: 'assistant',
  content: calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
})
const res = (c, text, isError = false) => ({ role: 'tool', toolCallId: c.id, content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
/** Un tour complet : appel + resultat. */
const turn = (name, args, text, isError = false) => {
  const c = call(name, args)
  return [asst(c), res(c, text, isError)]
}
const parse = (...turns) => {
  const { artifacts, events, priorCheckpoint } = parseRegion(turns.flat(), { idFor: (n) => `G1-A${n}` })
  const stats = applySupersession(artifacts)
  return { artifacts, events, priorCheckpoint, stats, byId: Object.fromEntries(artifacts.map((a) => [a.id, a])) }
}

// ---- passe 1 : le grand livre -----------------------------------------------
test('T-L1 une lecture est ecrasee par une lecture ulterieure de la meme adresse', () => {
  const { byId, stats } = parse(
    turn('read_block', { path: 'src/a.js::Foo' }, 'v1'),
    turn('read_block', { path: 'src/b.js::Bar' }, 'other'),
    turn('read_block', { path: 'src/a.js::Foo' }, 'v2'),
  )
  assert.equal(byId['G1-A1'].status, 'superseded')
  assert.equal(byId['G1-A1'].by, 'G1-A3')
  assert.equal(byId['G1-A2'].status, 'live', 'une autre adresse ne se fait pas ecraser')
  assert.equal(byId['G1-A3'].status, 'live')
  assert.equal(stats.superseded, 1)
})

test('T-L2 une lecture suivie d une ecriture apparentee est PERIMEE, pas ecrasee ; l ecriture reste vivante', () => {
  const { byId } = parse(
    turn('read_block', { path: 'src/a.js::Foo' }, 'body v1'),
    turn('edit_block', { path: 'src/a.js::Foo::run', ops: ['x'] }, 'ok'),
  )
  assert.equal(byId['G1-A1'].status, 'live')
  assert.deepEqual(byId['G1-A1'].staleAfter, ['G1-A2'])
  assert.equal(byId['G1-A2'].status, 'live')
})

test('T-L3 une lecture posterieure absorbe l ecriture ET ecrase l ancienne lecture', () => {
  const { byId } = parse(
    turn('read_block', { path: 'src/a.js::Foo' }, 'v1'),
    turn('edit_block', { path: 'src/a.js::Foo', ops: ['x'] }, 'ok'),
    turn('read_block', { path: 'src/a.js::Foo' }, 'v2'),
  )
  assert.equal(byId['G1-A1'].status, 'superseded')
  assert.equal(byId['G1-A2'].status, 'absorbed')
  assert.equal(byId['G1-A3'].status, 'live')
  assert.deepEqual(byId['G1-A3'].staleAfter, [])
})

test('T-L4 un echec ne change aucun etat : une lecture en erreur n ecrase rien', () => {
  const { byId } = parse(
    turn('read_block', { path: 'src/a.js' }, 'good'),
    turn('read_block', { path: 'src/a.js' }, 'ENOENT', true),
  )
  assert.equal(byId['G1-A1'].status, 'live', 'la lecture reussie survit a une relecture en echec')
  assert.equal(byId['G1-A2'].isError, true)
})

test('T-L5 deux adresses SOEURS ne sont pas apparentees : editer A ne perime pas la lecture de B', () => {
  assert.equal(related('f.js::A', 'f.js::B'), false)
  assert.equal(related('f.js::A', 'f.js::A::m'), true)
  assert.equal(related('f.js', 'f.js::A'), true)
  assert.equal(related('f.js', 'f.jsx'), false, 'un prefixe de chaine n est pas un prefixe d adresse')
  const { byId } = parse(
    turn('read_block', { path: 'f.js::B' }, 'b'),
    turn('edit_block', { path: 'f.js::A', ops: ['x'] }, 'ok'),
  )
  assert.deepEqual(byId['G1-A1'].staleAfter, [])
})

test('T-L6 read_block avec `paths` : une lecture multi-adresses n est ecrasee que si TOUTES le sont', () => {
  const { byId } = parse(
    turn('read_block', { paths: ['a.js::X', 'a.js::Y'] }, 'both'),
    turn('read_block', { path: 'a.js::X' }, 'x only'),
  )
  assert.equal(byId['G1-A1'].status, 'live', 'Y n est pas relu : la lecture multiple garde sa valeur')
})

test('T-L7 un resultat sans appel devient un artefact orphelin, et un checkpoint n est pas un evenement', () => {
  const orphan = { role: 'tool', toolCallId: 'ghost', content: [{ type: 'text', text: 'lost output' }] }
  const checkpoint = { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'PRIOR TEXT' }] }
  const { artifacts, events, priorCheckpoint } = parse([checkpoint, orphan])
  assert.equal(priorCheckpoint, 'PRIOR TEXT')
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].result, 'lost output')
  assert.equal(events.some((e) => e.type === 'user'), false)
})

test('T-L8 clip compte en points de code : aucune paire de substitution coupee', () => {
  const s = '\u{1F600}'.repeat(50) + 'x'.repeat(50)
  for (let max = 3; max < 90; max += 7) {
    const out = clip(s, max)
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `substitut isole pour max=${max}`)
  }
  assert.equal(clip('court', 100), 'court')
})

test('T-L9 le grand livre dit CURRENT / STALE-AFTER-EDITS / EDITED-NEVER-READ', () => {
  const { artifacts } = parse(
    turn('read_block', { path: 'cur.js' }, 'c'),
    turn('read_block', { path: 'stale.js' }, 's'),
    turn('edit_block', { path: 'stale.js', ops: ['x'] }, 'ok'),
    turn('edit_block', { path: 'blind.js', ops: ['x'] }, 'ok'),
  )
  const rows = Object.fromEntries(fileLedger(artifacts).map((r) => [r.key, r.state]))
  assert.deepEqual(rows, { 'cur.js': 'CURRENT', 'stale.js': 'STALE-AFTER-EDITS', 'blind.js': 'EDITED-NEVER-READ' })
})

// ---- passe 2 : lecture stricte de la reponse, assemblage --------------------
const RESPONSE = (extra = {}) =>
  [
    '## OBJECTIVE\n- build the thing',
    '## PROGRESS\n- DONE: a\n- NEXT: b',
    '## NEGATIVE KNOWLEDGE\n- REFUTED: docs say X -> code does Y [G1-A2]',
    `## KEEP VERBATIM\n${extra.keep ?? '(none)'}`,
    `## DROPPED\n${extra.drop ?? '(none)'}`,
  ].join('\n\n')

test('T-A1 parseResponse : un id invente est ignore ET nomme ; retenu + ecarte -> retenu ; sections manquantes -> leve', () => {
  const known = new Set(['G1-A1', 'G1-A2'])
  const r = parseResponse(RESPONSE({ keep: 'G1-A1, G1-A9', drop: 'G1-A1, G1-A2' }), known)
  assert.deepEqual([...r.keep], ['G1-A1'])
  assert.deepEqual([...r.drop], ['G1-A2'], 'un id a la fois retenu et ecarte est RETENU : perdre est irreversible')
  assert.deepEqual(r.unknownIds, ['G1-A9'])
  assert.throws(() => parseResponse('## PROGRESS\n- DONE: x', known), (e) => e instanceof ArchivistError && e.code === 'malformed')
  assert.throws(() => parseResponse('## OBJECTIVE\n(none)\n## PROGRESS\n- x', known), ArchivistError, 'un OBJECTIVE vide est un echec')
})

import { operationalLedger, renderOperationalLedger } from '../lib/ledger.js'

function build(turns, { keep = '', drop = '', options = {} } = {}) {
  const { artifacts, events } = parse(...turns)
  const known = new Set(artifacts.map((a) => a.id))
  const parsed = parseResponse(RESPONSE({ keep: keep || '(none)', drop: drop || '(none)' }), known)
  const op = operationalLedger(artifacts, events)
  return { artifacts, events, op, ...assemble({ gen: 1, artifacts, operational: op, sections: parsed.sections, keep: parsed.keep, drop: parsed.drop, unknownIds: parsed.unknownIds, options }) }
}

test('T-A9 souches bornees : quand la borne coupe, les ERREURS passent avant les appels reussis, meme plus tardifs', () => {
  const { text } = build(
    [
      turn('pwsh', { command: 'ok-1' }, 'fine'),
      turn('pwsh', { command: 'ok-2' }, 'fine'),
      turn('pwsh', { command: 'late-fail' }, 'Error: late failure', true),
    ],
    { options: { maxStubs: 1 } },
  )
  const stubs = text.split('## UNTRIAGED CALLS')[1].split('## VERBATIM ARTIFACTS')[0]
  assert.match(stubs, /showing 1 of 3, errors first/)
  assert.match(stubs, /G1-A3 \| pwsh .*ERROR Error: late failure/)
  assert.doesNotMatch(stubs, /G1-A1|G1-A2/)
})

test('T-A2 l artefact retenu ressort MOT POUR MOT (le code recopie, pas le modele)', () => {
  const raw = 'function f() {\n  return "\u00e9\u{1F600}";\n}\n'
  const { text } = build([turn('read_block', { path: 'a.js::f' }, raw)], { keep: 'G1-A1' })
  const prior = parsePriorCheckpoint(text)
  assert.equal(prior.artifacts.length, 1)
  assert.equal(prior.artifacts[0].body, raw)
})

test('T-A3 une lecture perimee retenue ramene automatiquement les ecritures qui la completent', () => {
  const { text } = build(
    [turn('read_block', { path: 'a.js::f' }, 'old body'), turn('edit_block', { path: 'a.js::f', ops: ['NEWOPS'] }, 'ok')],
    { keep: 'G1-A1' },
  )
  const ids = parsePriorCheckpoint(text).artifacts.map((a) => a.head.id)
  assert.deepEqual(ids, ['G1-A1', 'G1-A2'])
})

test('T-A4 rien ne disparait en silence : souche pour l appel ni retenu ni ecarte, erreur en tete', () => {
  const { text } = build(
    [
      turn('pwsh', { command: 'ls' }, 'files...'),
      turn('pwsh', { command: 'node x' }, 'Error: ENOENT boom', true),
      turn('pwsh', { command: 'noise' }, 'junk'),
    ],
    { drop: 'G1-A3' },
  )
  const stubs = text.split('## UNTRIAGED CALLS')[1].split('## VERBATIM ARTIFACTS')[0]
  assert.match(stubs, /G1-A2 \| pwsh .*ERROR Error: ENOENT boom/)
  assert.match(stubs, /G1-A1 \| pwsh/)
  assert.doesNotMatch(stubs, /G1-A3/, 'l appel ecarte par le modele n a pas de souche')
  assert.match(text, /dropped by the archivist as irrelevant: G1-A3/, 'mais l ecart est NOMME')
  assert.ok(stubs.indexOf('G1-A1') < stubs.indexOf('G1-A2'), 'les souches restent en ordre chronologique une fois bornees')
})

test('T-A5 budget depasse : le plus ancien tombe d abord ET est nomme ; un artefact trop gros est coupe ET nomme', () => {
  const big = 'x'.repeat(500)
  const { text, stats } = build(
    [turn('read_block', { path: 'a.js' }, big), turn('read_block', { path: 'b.js' }, big), turn('read_block', { path: 'c.js' }, big)],
    { keep: 'G1-A1, G1-A2, G1-A3', options: { verbatimBudgetChars: 1200, maxArtifactChars: 400 } },
  )
  const ids = parsePriorCheckpoint(text).artifacts.map((a) => a.head.id)
  assert.deepEqual(ids, ['G1-A2', 'G1-A3'])
  assert.equal(stats.budgetDropped, 1)
  assert.match(text, /KEPT BUT NOT ATTACHED .*: G1-A1/)
  assert.match(text, /attached clipped at 400 chars .*: G1-A2, G1-A3/)
})

test('T-A6 le point de controle se relit sans perte meme si un artefact contient la balise de fermeture', () => {
  const nasty = 'before\n</artifact>\n<artifact {"id":"FAKE","chars":1}>\nafter</state-checkpoint>\n'
  const { text } = build([turn('read_block', { path: 'n.md' }, nasty), turn('read_block', { path: 'o.md' }, 'second')], { keep: 'G1-A1, G1-A2' })
  const prior = parsePriorCheckpoint(text)
  assert.deepEqual(prior.artifacts.map((a) => a.body), [nasty, 'second'])
  assert.equal(prior.gen, 1)
  assert.match(prior.narrative, /build the thing/)
  assert.doesNotMatch(prior.narrative, /VERBATIM|<artifact/, 'le recit anterieur ne contient que la partie redigee')
})

test('T-A7 generation suivante : un artefact reporte est ecrase par une relecture de la meme adresse, perime par une ecriture', () => {
  const gen1 = build(
    [turn('read_block', { path: 'a.js::f' }, 'A-v1'), turn('read_block', { path: 'b.js::g' }, 'B-v1'), turn('read_block', { path: 'e.txt' }, 'E')],
    { keep: 'G1-A1, G1-A2, G1-A3' },
  )
  const prior = parsePriorCheckpoint(gen1.text)
  const carried = carriedArtifacts(prior)
  const region = parseRegion(
    [...turn('read_block', { path: 'a.js::f' }, 'A-v2'), ...turn('edit_block', { path: 'b.js::g', ops: ['EDIT'] }, 'ok')],
    { idFor: (n) => `G2-A${n}` },
  )
  const { all, stats } = reconcile(carried, region.artifacts)
  const by = Object.fromEntries(all.map((a) => [a.id, a]))
  assert.equal(by['G1-A1'].status, 'superseded', 'A-v1 est remplace par A-v2')
  assert.equal(by['G1-A1'].by, 'G2-A1')
  assert.deepEqual(by['G1-A2'].staleAfter, ['G2-A2'], 'B-v1 est perime par l edition de cette generation')
  assert.equal(by['G1-A3'].status, 'live', 'un artefact sans rapport est reporte tel quel')
  assert.equal(stats.superseded, 1)
})

test('T-A8 renderTimeline : sous budget il tient, en divisant le plafond par resultat ; au pire il coupe les plus anciens ET le dit', () => {
  const turns = Array.from({ length: 6 }, (_, i) => turn('pwsh', { command: `c${i}` }, 'y'.repeat(5000)))
  const { events } = parse(...turns)
  const loose = renderTimeline(events, { maxInputChars: 10_000_000, resultChars: 6000 })
  assert.equal(loose.cutEvents, 0)
  const tight = renderTimeline(events, { maxInputChars: 9000, resultChars: 6000 })
  assert.ok(tight.resultCap < 6000, 'le plafond a ete divise')
  assert.ok(tight.text.length <= 9000 + 200, `la sortie tient (${tight.text.length})`)
  const tiny = renderTimeline(events, { maxInputChars: 600 })
  assert.ok(tiny.cutEvents > 0)
  assert.match(tiny.text, /oldest events omitted/)
})

// ---- le moteur : base factice ------------------------------------------------
class FakeBase {
  static lastConfig
  constructor(ctx, config = {}) {
    FakeBase.lastConfig = config
    this.ctx = ctx
    this.config = { summarizationProvider: 'prov', summarizationModel: 'mod', maxTokens: 4096, ...config }
  }
  async summarize() {
    return { summary: [{ type: 'text', text: 'STOCK SUMMARY' }], provider: 'stock', model: 'stock' }
  }
}
class FakeAssembler {
  constructor() {
    this.text = ''
    this.finish = { kind: 'stop' }
    this.usage = undefined
  }
  push(chunk) {
    if (chunk.error) this.finish = { kind: 'error', failure: { message: chunk.error, code: 'BOOM' } }
    if (chunk.text) this.text += chunk.text
  }
  blocks() {
    return [{ type: 'text', text: this.text }]
  }
}
function makeEngine({ chunks, journal = [], config = {}, thrown }) {
  const Engine = createStateCompactionEngine(FakeBase, { BlockAssembler: FakeAssembler, journal: (r) => journal.push(r) })
  const calls = []
  const ctx = {
    llm: {
      stream: (options) => {
        calls.push(options)
        if (thrown) throw thrown
        return (async function* () {
          for (const c of chunks) yield c
        })()
      },
    },
  }
  return { engine: new Engine(ctx, config), calls, journal }
}

test('T-O1 le registre operationnel restitue fidelement le tableau de taches actif de todo_write', () => {
  const { text } = build([
    turn('todo_write', {
      todos: [
        { content: 'Inspecter les modules', status: 'completed' },
        { content: 'Implementer le registre', status: 'in_progress' },
        { content: 'Valider les mutations', status: 'pending' },
      ],
    }, 'ok'),
  ])
  assert.match(text, /## IN-FLIGHT & OPERATIONAL STATE/)
  assert.match(text, /### Active Tasks/)
  assert.match(text, /- \[x\] Inspecter les modules \(DONE\)/)
  assert.match(text, /- \[>\] Implementer le registre \(IN PROGRESS\)/)
  assert.match(text, /- \[ \] Valider les mutations \(PENDING\)/)
})

test('T-O2 si plusieurs todo_write se succedent, seul le DERNIER reussi est retenu', () => {
  const { text } = build([
    turn('todo_write', { todos: [{ content: 'Ancienne tache', status: 'in_progress' }] }, 'ok'),
    turn('todo_write', { todos: [{ content: 'Nouvelle tache active', status: 'in_progress' }] }, 'ok'),
  ])
  assert.match(text, /Nouvelle tache active/)
  assert.doesNotMatch(text, /Ancienne tache/)
})

test('T-O3 sous-agent en arriere-plan sans avis de fin reste marque RUNNING / IN-FLIGHT', () => {
  const { text } = build([
    turn('subagent_implement', {
      description: 'Ecrire les tests',
      prompt: 'Ajouter les cas T-O1 a T-O8',
      run_in_background: true,
    }, 'agent id: agent-abcd1234'),
  ])
  assert.match(text, /\[RUNNING \/ IN-FLIGHT\] subagent_implement \(agent: agent-abcd1234/)
  assert.match(text, /"Ecrire les tests"/)
})

test('T-O4 sous-agent dont l avis de settlement est arrive dans les evenements passe a COMPLETED', () => {
  const c = call('subagent_verify', { description: 'Falsifier', run_in_background: true })
  const m1 = asst(c)
  const m2 = res(c, 'agent id: agent-ef019876')
  const m3 = user('Subagent agent-ef019876 settled with exit code 0')
  const { text } = build([[m1, m2], [m3]])
  assert.match(text, /\[COMPLETED\] subagent_verify \(agent: agent-ef019876/)
})

test('T-O5 sous-agent synchrone (run_in_background: false) est marque COMPLETED avec son detail', () => {
  const { text } = build([
    turn('subagent_investigate', {
      description: 'Trouver la cause',
      run_in_background: false,
    }, 'Root cause found: missing export in archivist.js'),
  ])
  assert.match(text, /\[COMPLETED\] subagent_investigate/)
  assert.match(text, /Root cause found: missing export/)
})

test('T-O6 ask_user_question : la question et la reponse de l utilisateur sont figees dans le point de controle', () => {
  const { text } = build([
    turn('ask_user_question', {
      questions: [{ id: 'q-mode', question: 'Comment brancher le moteur ?' }],
    }, '{"answers": [{"id": "q-mode", "selected": ["Un remplacement exact par pwsh"]}]}'),
  ])
  assert.match(text, /### User Decisions & Questions/)
  assert.match(text, /\[ANSWERED\] "Comment brancher le moteur \?" -> Decision: q-mode: Un remplacement exact par pwsh/)
})

test('T-O7 background jobs (run_detached) sont traces RUNNING ou KILLED', () => {
  const { text } = build([
    turn('run_detached', { command: 'node worker.js', label: 'Heavy worker' }, 'job-4321'),
    turn('pwsh', { command: 'npm run test:watch', run_in_background: true }, 'job-8765'),
    turn('job_kill', { job_id: 'job-8765' }, 'killed'),
  ])
  assert.match(text, /\[RUNNING\] run_detached \(job-4321\): `node worker\.js` \("Heavy worker"\)/)
  assert.match(text, /\[KILLED\] pwsh \(job-8765\): `npm run test:watch`/)
})

test('T-O8 continuite multi-generations : les taches actives et sous-agents en vol de gen 1 survivent a gen 2', () => {
  const gen1 = build([
    turn('todo_write', { todos: [{ content: 'Tache persistante', status: 'in_progress' }] }, 'ok'),
    turn('subagent_implement', { description: 'Ouvrier persistant', run_in_background: true }, 'agent id: agent-carry99'),
  ])
  const prior = parsePriorCheckpoint(gen1.text)
  assert.ok(prior.operational, 'gen 1 doit parser son etat operationnel')
  assert.equal(prior.operational.todos[0].content, 'Tache persistante')
  assert.equal(prior.operational.subagents[0].status, 'RUNNING')

  const second = makeEngine({ chunks: [{ text: RESPONSE() }] })
  const checkpoint = { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: `<compacted-summary>${gen1.text}</compacted-summary>` }] }
  const input2 = { messages: [checkpoint, ...turn('pwsh', { command: 'echo work' }, 'work\n'.repeat(500))] }
  return second.engine.summarize(input2, agent).then((out2) => {
    const text2 = out2.summary[0].text
    assert.match(text2, /gen="2"/)
    assert.match(text2, /Tache persistante/)
    assert.match(text2, /\[RUNNING \/ IN-FLIGHT\] subagent_implement \(agent: agent-carry99/)
  })
})

test('T-O9 activite post-todo : notice d operations et prolongation automatique si tout etait acheve', () => {
  const { text } = build([
    turn('todo_write', {
      todos: [
        { content: 'Premiere etape terminee', status: 'completed' },
      ],
    }, 'ok'),
    turn('edit_block', { path: 'src/app.js::run' }, 'updated code'),
    turn('pwsh', { command: 'node test.js' }, 'tests passing'),
  ])
  assert.match(text, /Notice: 2 tool operations \(edit_block, pwsh\) executed since this task board update/)
  assert.match(text, /- \[x\] Premiere etape terminee \(DONE\)/)
  assert.match(text, /- \[>\] Poursuivre les modifications sur src\/app\.js::run \(IN PROGRESS\)/)
})

test('T-O10 auto-consolidation : sans aucun todo_write, un tableau est derive de la demande et des operations', () => {
  const { text } = build([
    [user('Corriger le bug de calcul dans le moteur de tarification')],
    turn('edit_block', { path: 'lib/pricing.js::calculate' }, 'fixed'),
  ])
  assert.match(text, /source: synthesized-from-activity/)
  assert.match(text, /- \[>\] Traiter la demande : "Corriger le bug de calcul dans le moteur de tarification" \(IN PROGRESS\)/)
  assert.match(text, /- \[ \] Valider et verifier les resultats \(PENDING\)/)
})

test('T-L10 edit_block batch (edits=[...]) : extrait toutes les adresses et perime les lectures correspondantes', () => {
  const { byId, artifacts } = parse(
    turn('read_block', { path: 'src/a.js::f' }, 'code f'),
    turn('read_block', { path: 'src/b.js::g' }, 'code g'),
    turn('edit_block', {
      edits: [
        { path: 'src/a.js::f', ops: [] },
        { path: 'src/b.js::g', ops: [] },
      ],
    }, 'applied 2/2'),
  )
  assert.deepEqual(byId['G1-A3'].keys, ['src/a.js::f', 'src/b.js::g'])
  assert.deepEqual(byId['G1-A1'].staleAfter, ['G1-A3'])
  assert.deepEqual(byId['G1-A2'].staleAfter, ['G1-A3'])
  const rows = fileLedger(artifacts)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.state === 'STALE-AFTER-EDITS'))
})

test('T-L11 normalisation des chemins Windows/POSIX : C:\\dir\\file.js et C:/dir/file.js sont la meme adresse', () => {
  const { byId, stats } = parse(
    turn('read', { file_path: 'C:\\CodeSource\\app\\index.js' }, 'old'),
    turn('edit', { file_path: 'C:/CodeSource/app/index.js' }, 'edited'),
    turn('read', { file_path: 'C:/CodeSource/app/index.js' }, 'new'),
  )
  assert.equal(byId['G1-A1'].status, 'superseded')
  assert.equal(byId['G1-A2'].status, 'absorbed')
  assert.equal(byId['G1-A3'].status, 'live')
  assert.equal(stats.superseded, 1)
  assert.equal(stats.absorbed, 1)
})

test('T-L12 filtrage des rappels systeme ephemeres (time-context, agent-instructions, runtime-context)', () => {
  const { events } = parseRegion([
    { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled: 2026-10-13' }] },
    { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>AGENTS.md</system-reminder>' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Vraie demande humaine' }] },
  ])
  assert.equal(events.length, 1)
  assert.equal(events[0].text, 'Vraie demande humaine')
})

test('T-L13 PTC (tool/ptc-dispatch) : les appels internes a run_code sont extraits et soumis a la supersession', () => {
  const c1 = call('run_code', { code: 'await tools.read(...)' })
  const c2 = call('run_code', { code: 'await tools.edit(...); await tools.read(...)' })
  const messages = [
    asst(c1),
    res(c1, 'out1'),
    asst(c2),
    res(c2, 'out2'),
  ]
  const ptcDispatches = [
    { rootCallId: c1.id, subCallId: `${c1.id}:ptc:1`, name: 'read', arguments: { file_path: 'src/x.js' }, isError: false, content: [{ type: 'text', text: 'v1' }] },
    { rootCallId: c2.id, subCallId: `${c2.id}:ptc:1`, name: 'edit', arguments: { file_path: 'src/x.js' }, isError: false, content: [{ type: 'text', text: 'patched' }] },
    { rootCallId: c2.id, subCallId: `${c2.id}:ptc:2`, name: 'read', arguments: { file_path: 'src/x.js' }, isError: false, content: [{ type: 'text', text: 'v2' }] },
  ]
  const region = parseRegion(messages, { idFor: (n) => `G1-A${n}`, ptcDispatches })
  const stats = applySupersession(region.artifacts)
  assert.equal(region.artifacts.length, 5) // 2 run_code + 3 ptc-dispatch
  assert.equal(stats.superseded, 1)
  assert.equal(stats.absorbed, 1)
  const rows = fileLedger(region.artifacts)
  assert.deepEqual(rows, [{ key: 'src/x.js', state: 'CURRENT', lastRead: 'G1-A5', editsSince: [], reads: 2, writes: 1 }])
})

test('T-O11 subagent UUID DSH reel ("started subagent <uuid>") + faux positifs ("agent-preset") + senderSessionId', () => {
  const c1 = call('subagent_verify', { description: 'Verify preset', run_in_background: false })
  const c2 = call('subagent_implement', { description: 'Impl worker', run_in_background: true })
  const m1 = asst(c1)
  const r1 = res(c1, 'Verified `agent-preset` and `agent-instructions` in cordis.patch.yml')
  const m2 = asst(c2)
  const r2 = res(c2, 'started subagent 31a10e93-3536-48d4-b6bc-cf53f58bfc86')
  const m3 = {
    role: 'user',
    source: { kind: 'subagent-settled', senderSessionId: '31a10e93-3536-48d4-b6bc-cf53f58bfc86' },
    content: [{ type: 'text', text: 'Background subagent 31a10e93-3536-48d4-b6bc-cf53f58bfc86 finished.' }],
  }
  const { op } = build([[m1, r1, m2, r2, m3]])
  assert.equal(op.subagents.length, 2)
  assert.equal(op.subagents[0].agentId, null, 'agent-preset ne doit pas etre pris pour un identifiant d agent')
  assert.equal(op.subagents[1].agentId, '31a10e93-3536-48d4-b6bc-cf53f58bfc86')
  assert.equal(op.subagents[1].status, 'COMPLETED')
})

test('T-O12 jobs : format reel "pwsh-12", settlement par notice tool-jobs et persistance inter-generations', () => {
  const gen1 = build([
    turn('run_detached', { command: 'Start-Sleep 5', label: 'smoke' }, 'Started pwsh-12 as a detached job owned by this session.'),
  ])
  assert.match(gen1.text, /\[RUNNING\] run_detached \(pwsh-12\): `Start-Sleep 5` \("smoke"\)/)
  const prior = parsePriorCheckpoint(gen1.text)
  assert.equal(prior.operational.backgroundJobs.length, 1)
  assert.equal(prior.operational.backgroundJobs[0].jobId, 'pwsh-12')
  assert.equal(prior.operational.backgroundJobs[0].status, 'RUNNING')

  // Generation 2 : une notice tool-jobs annonce la fin de pwsh-12
  const notice = {
    role: 'user',
    source: { kind: 'tool-jobs', form: 'notice' },
    content: [{ type: 'text', text: 'background job pwsh-12 (pwsh: smoke) finished [status: completed, exit code: 0].' }],
  }
  const reg2 = parseRegion([notice], { idFor: (n) => `G2-A${n}` })
  const op2 = operationalLedger(reg2.artifacts, reg2.events, prior.operational)
  assert.equal(op2.backgroundJobs[0].status, 'FINISHED')
})

test('T-O13 auto-consolidation ignore les notifications subagent-settled et retient la vraie demande humaine', () => {
  const { op } = build([
    [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Terminer run_detached et verifier sa survie' }] }],
    turn('subagent_implement', { description: 'worker', run_in_background: true }, 'started subagent 56dbe8cb-5fdb-44e6-93bf-ebe840863ffc'),
    [{ role: 'user', source: { kind: 'subagent-settled', senderSessionId: '56dbe8cb-5fdb-44e6-93bf-ebe840863ffc' }, content: [{ type: 'text', text: 'Background subagent 56dbe8cb-5fdb-44e6-93bf-ebe840863ffc finished and will do no further work.' }] }],
  ])
  assert.equal(op.todosRecord.source, 'synthesized-from-activity')
  assert.match(op.todosRecord.todos[0].content, /Terminer run_detached et verifier sa survie/)
})
const agent = { session: { id: 'sess-1', requestHeader: () => undefined }, options: {} }
const bigInput = () => ({
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
    user('please build the thing'),
    ...turn('read_block', { path: 'a.js::f' }, 'z'.repeat(4000)),
    ...turn('pwsh', { command: 'node t' }, 'boom '.repeat(400), true),
  ],
})

test('T-E1 succes : point de controle d etat, resultat NON marque llmStreamCall, route du moteur, journal archived', async () => {
  const { engine, calls, journal } = makeEngine({ chunks: [{ text: RESPONSE({ keep: 'G1-A1' }) }] })
  const out = await engine.summarize(bigInput(), agent)
  assert.match(out.summary[0].text, /^<state-checkpoint format="boost-compaction\/1" gen="1">/)
  assert.equal(out.llmStreamCall, undefined, 'le texte assemble n est pas la projection du flux : on ne se declare pas appel direct')
  assert.equal(out.provider, 'prov')
  assert.equal(out.model, 'mod')
  assert.equal(calls.length, 1, 'exactement un appel de modele')
  assert.equal(calls[0].purpose, 'compaction', 'le resolveur arbitre sur ce `purpose`')
  assert.equal(calls[0].sessionId, 'sess-1')
  assert.match(calls[0].system, /STATE ARCHIVIST/)
  assert.match(calls[0].messages[0].content[0].text, /\[G1-A1\] read_block/)
  const rec = journal.find((r) => r.step === 'archived')
  assert.equal(rec.kept, 1)
  assert.equal(rec.gen, 1)
})

test('T-E2 la config `archivist` n atteint PAS le moteur standard (qui rejetterait la cle) ; une cle inconnue leve', () => {
  makeEngine({ chunks: [], config: { thresholdRatio: 0.85, archivist: { maxStubs: 5 } } })
  assert.deepEqual(FakeBase.lastConfig, { thresholdRatio: 0.85 })
  assert.throws(() => resolveArchivistConfig({ nope: 1 }), /unknown key "nope"/)
  assert.throws(() => resolveArchivistConfig({ resultChars: -1 }), /positive integer/)
  assert.throws(() => resolveArchivistConfig({ provider: 'p' }), /together/)
})

test('T-E3 echec du modele : repli OUVERT sur le resume standard, journalise ; fallback:false -> l erreur remonte', async () => {
  const { engine, journal } = makeEngine({ chunks: [{ error: 'gateway down' }] })
  const out = await engine.summarize(bigInput(), agent)
  assert.equal(out.summary[0].text, 'STOCK SUMMARY')
  const rec = journal.find((r) => r.step === 'failed')
  assert.match(rec.error, /gateway down/)
  assert.equal(rec.code, 'BOOM')
  const strict = makeEngine({ chunks: [{ error: 'gateway down' }], config: { archivist: { fallback: false } } })
  await assert.rejects(() => strict.engine.summarize(bigInput(), agent), /gateway down/)
})

test('T-E4 reponse mal formee -> repli, journalise avec son code', async () => {
  const { engine, journal } = makeEngine({ chunks: [{ text: 'Here is a nice story about the session.' }] })
  const out = await engine.summarize(bigInput(), agent)
  assert.equal(out.summary[0].text, 'STOCK SUMMARY')
  assert.equal(journal.find((r) => r.step === 'failed').code, 'malformed')
})

test('T-E5 un abandon (signal) n est JAMAIS rattrape par le repli', async () => {
  const ac = new AbortController()
  ac.abort(new Error('user cancelled'))
  const { engine } = makeEngine({ chunks: [], thrown: new Error('aborted upstream') })
  await assert.rejects(() => engine.summarize(bigInput(), agent, ac.signal), /aborted upstream/)
})

test('T-E6 point de controle pas plus petit que la region -> repli (le moteur standard le rejetterait de toute facon)', async () => {
  const input = { messages: [user('hi'), ...turn('read_block', { path: 'a.js' }, 'tiny')] }
  const { engine, journal } = makeEngine({ chunks: [{ text: RESPONSE({ keep: 'G1-A1' }) }] })
  const out = await engine.summarize(input, agent)
  assert.equal(out.summary[0].text, 'STOCK SUMMARY')
  assert.equal(journal.find((r) => r.step === 'failed').code, 'not-smaller')
})

test('T-E7 enabled:false -> resume standard, aucun appel de modele', async () => {
  const { engine, calls } = makeEngine({ chunks: [], config: { archivist: { enabled: false } } })
  const out = await engine.summarize(bigInput(), agent)
  assert.equal(out.summary[0].text, 'STOCK SUMMARY')
  assert.equal(calls.length, 0)
})

test('T-E8 deuxieme generation : le checkpoint du tour precedent est relu, gen incremente, artefact reporte propose au modele', async () => {
  const first = makeEngine({ chunks: [{ text: RESPONSE({ keep: 'G1-A1' }) }] })
  const out1 = await first.engine.summarize(bigInput(), agent)
  const checkpoint = { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: `<compacted-summary>${out1.summary[0].text}</compacted-summary>` }] }
  assert.equal(findPrior([checkpoint]).gen, 1)
  const second = makeEngine({ chunks: [{ text: RESPONSE({ keep: 'G1-A1' }) }] })
  const input2 = { messages: [checkpoint, ...turn('pwsh', { command: 'x' }, 'q'.repeat(9000))] }
  const out2 = await second.engine.summarize(input2, agent)
  assert.match(out2.summary[0].text, /gen="2"/)
  assert.match(second.calls[0].messages[0].content[0].text, /CARRIED ARTIFACTS[\s\S]*G1-A1/)
  assert.deepEqual(parsePriorCheckpoint(out2.summary[0].text).artifacts.map((a) => a.head.id), ['G1-A1'])
})

test('T-E9 pickTarget : explicite > moteur standard > derniere route > options de l agent', () => {
  const none = { summarizationProvider: '', summarizationModel: '' }
  assert.deepEqual(pickTarget(none, { provider: 'a', model: 'b' }, agent), { provider: 'a', model: 'b' })
  assert.deepEqual(pickTarget({ summarizationProvider: 'p', summarizationModel: 'm' }, {}, agent), { provider: 'p', model: 'm' })
  const withHeader = { session: { requestHeader: () => ({ config: { provider: 'h', model: 'hm' } }) }, options: {} }
  assert.deepEqual(pickTarget(none, {}, withHeader), { provider: 'h', model: 'hm' })
  assert.deepEqual(pickTarget(none, {}, { session: {}, options: { provider: 'o', model: 'om' } }), { provider: 'o', model: 'om' })
  assert.equal(pickTarget(none, {}, { session: {}, options: {} }), undefined)
})

test('T-E10 interception Host universelle : un moteur compaction-basic isole dans un preset est intercepte et produit un state-checkpoint', async () => {
  const listeners = new Map()
  const Engine = createStateCompactionEngine(FakeBase, { BlockAssembler: FakeAssembler })
  const hostCtx = {
    on: (ev, fn) => listeners.set(ev, fn),
    llm: {
      async *stream() {
        yield { text: RESPONSE({ keep: 'G1-A1' }) }
      },
    },
  }
  const rootCompaction = new FakeBase(hostCtx, {})
  hostCtx.root = { get: (name) => (name === 'compaction' ? rootCompaction : undefined) }
  const hostEngine = new Engine(hostCtx, { summarizationProvider: 'prov', summarizationModel: 'mod' })
  assert.equal(rootCompaction.__stateArchivistInstalled, true, 'le moteur Host racine est patche des le montage pour couvrir /compact a froid')
  assert.ok(hostEngine)

  const isolatedPresetCompaction = new FakeBase(hostCtx, {})
  const fakeAgent = {
    ...agent,
    ctx: { get: (name) => (name === 'compaction' ? isolatedPresetCompaction : undefined) },
  }

  // Declenchement de agent/pre-step : l intercepteur patche isolatedPresetCompaction.summarize ET relaye next()
  const expectedDecision = { kind: 'enter', messages: [] }
  const preStepOut = await listeners.get('agent/pre-step')({ agent: fakeAgent }, () => Promise.resolve(expectedDecision))
  assert.deepEqual(preStepOut, expectedDecision, 'agent/pre-step est un waterfall : le listener DOIT retourner next() sous peine de casser la boucle agent avec undefined.kind')
  assert.equal(isolatedPresetCompaction.__stateArchivistInstalled, true)

  const out = await isolatedPresetCompaction.summarize(bigInput(), fakeAgent)
  assert.match(out.summary[0].text, /^<state-checkpoint format="boost-compaction\/1" gen="1">/)
})
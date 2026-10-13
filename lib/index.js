/**
 * dsh-boost-compaction — point d'entree du plugin. SEUL fichier du paquet qui touche
 * l'installation du harnais ; toute la logique est dans `engine.js`, `archivist.js`
 * et `ledger.js`, testables sans harnais.
 *
 * Ce module exporte, par defaut, une classe qui REMPLACE `@deepseek-ai/dsh-compaction-basic`
 * dans le groupe `compaction` d'un preset : meme service (`ctx.compaction`), memes cles de
 * configuration, plus une cle `archivist` optionnelle (voir README.md). On la monte A LA PLACE
 * de la ligne standard, jamais a cote : deux moteurs de compaction dans une meme portee se
 * disputeraient `ctx.compaction`.
 *
 * Un montage qui echoue est BRUYANT (la ligne passe en echec) : on prefere cela a une
 * session sans compaction. D'ou la resolution de la base par la meme chaine d'ancres que
 * `packages/boost-channel/lib/index.js` (resolveHarnessModule), mesuree en production.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStateCompactionEngine } from './engine.js'

/** Identite de la ligne : aussi le nom du repertoire sous 'plugin-data'. */
export const pluginName = 'dsh-state-compaction'

const JOURNAL_MAX_BYTES = 2 * 1024 * 1024

/** Le premier maillon de la chaine d'ancres qui resout un paquet du harnais. */
export function resolveHarnessModule(specifier) {
  const anchors = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') anchors.push(process.argv[1])
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    anchors.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  }
  anchors.push(join(process.cwd(), 'package.json'))
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(specifier)
    } catch {
      // Ancre hors de l'installation : on essaie la suivante.
    }
  }
  return undefined
}

async function loadHarness(specifier) {
  const entry = resolveHarnessModule(specifier)
  if (entry === undefined) throw new Error(`${pluginName}: cannot resolve ${specifier} from the running harness (anchors: argv[1], DSH_PROFILE_DIR, cwd)`)
  return import(pathToFileURL(entry).href)
}

/** Journal best-effort : une ligne JSON par decision, rotation d'une generation, NE LEVE JAMAIS. */
export function createJournal(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  const file = join(home, 'plugin-data', pluginName, 'decisions.jsonl')
  return (record) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > JOURNAL_MAX_BYTES) {
          rmSync(`${file}.1`, { force: true })
          renameSync(file, `${file}.1`)
        }
      } catch {
        // Pas encore de fichier : rien a faire tourner.
      }
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
    } catch {
      // Un journal qui casse la compaction qu'il observe est pire que pas de journal.
    }
  }
}

const basic = await loadHarness('@deepseek-ai/dsh-compaction-basic')
const llm = await loadHarness('@deepseek-ai/dsh-llm')
const Base = basic.BasicCompactionEngine ?? basic.default

export class StateCompactionEngine extends createStateCompactionEngine(Base, {
  BlockAssembler: llm.BlockAssembler,
  journal: createJournal(),
}) {}

export default StateCompactionEngine
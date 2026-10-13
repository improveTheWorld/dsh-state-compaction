/**
 * Le moteur de compaction d'etat : BasicCompactionEngine, dont la SEULE couture
 * documentee — `summarize()` — est remplacee. Tout le reste (declenchement,
 * retention, verrou durable `compaction/start`, controle de convergence, remplacement
 * de surface) reste celui du harnais : on ne reecrit pas une transaction durable
 * pour changer ce qu'elle ecrit dedans.
 *
 * Ce fichier est une FABRIQUE (`createStateCompactionEngine(Base, deps)`), pas un
 * module qui resout le harnais : la classe de base et l'assembleur de blocs sont
 * INJECTES. C'est ce qui permet de tester le moteur contre une base factice, et de
 * garder `index.js` comme seul fichier qui touche l'installation du harnais.
 *
 * Echec : OUVERT. Si l'archiviste leve (modele indisponible, reponse mal formee,
 * point de controle plus gros que la region), on retombe sur le resume standard en
 * ECRIVANT pourquoi — jamais en silence, et jamais en laissant la session sans
 * compaction. `fallback: false` rend l'echec fatal, pour qui veut le mesurer.
 */
import { DEFAULTS, ArchivistError, PERSONA, assemble, buildPrompt, carriedArtifacts, parsePriorCheckpoint, parseResponse, reconcile, renderTimeline } from './archivist.js'
import { blocksText, parseRegion } from './ledger.js'

const KEYS = new Set(Object.keys(DEFAULTS).concat(['provider', 'model']))

/** Valide la configuration `archivist` : cle inconnue ou valeur invalide LEVE, comme le moteur standard. */
export function resolveArchivistConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('archivist: config must be an object')
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) throw new Error(`archivist: unknown key "${key}" (allowed: ${[...KEYS].join(', ')})`)
  }
  const out = { ...DEFAULTS }
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (input[key] === undefined) continue
    if (typeof def === 'boolean') {
      if (typeof input[key] !== 'boolean') throw new Error(`archivist: ${key} must be a boolean`)
    } else if (!Number.isInteger(input[key]) || input[key] <= 0) {
      throw new Error(`archivist: ${key} must be a positive integer`)
    }
    out[key] = input[key]
  }
  const hasP = typeof input.provider === 'string' && input.provider !== ''
  const hasM = typeof input.model === 'string' && input.model !== ''
  if (hasP !== hasM) throw new Error('archivist: provider and model must be set together')
  if (hasP) {
    out.provider = input.provider
    out.model = input.model
  }
  return Object.freeze(out)
}
import { operationalLedger } from './ledger.js'

const isCheckpoint = (m) => m?.source?.kind === 'compact-checkpoint'

/** Le point de controle precedent de la region : le DERNIER message-checkpoint rencontre. */
export function findPrior(messages) {
  let text = null
  for (const m of messages ?? []) if (m?.role === 'user' && isCheckpoint(m)) text = blocksText(m.content)
  return parsePriorCheckpoint(text)
}

function streamFailure(finish) {
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(finish.failure?.message ?? 'archivist stream failed')
    error.code = finish.failure?.code
    return error
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('archivist output truncated at the token cap (incomplete registry)')
    error.code = 'MAX_TOKENS'
    return error
  }
  return undefined
}

/** Cible du modele archiviste : explicite, puis celle du moteur standard, puis celle de la session. */
export function pickTarget(engineConfig, archivist, agent) {
  if (archivist.provider) return { provider: archivist.provider, model: archivist.model }
  if (engineConfig.summarizationProvider) return { provider: engineConfig.summarizationProvider, model: engineConfig.summarizationModel }
  const latest = agent?.session?.requestHeader?.()?.config
  if (latest?.provider && latest?.model) return { provider: latest.provider, model: latest.model }
  const o = agent?.options
  if (o?.provider && o?.model) return { provider: o.provider, model: o.model }
  return undefined
}

export function createStateCompactionEngine(Base, deps) {
  const { BlockAssembler, journal = () => {} } = deps
  if (typeof Base !== 'function') throw new TypeError('createStateCompactionEngine: Base must be a class')
  if (typeof BlockAssembler !== 'function') throw new TypeError('createStateCompactionEngine: BlockAssembler is required')

  return class StateCompactionEngine extends Base {
    constructor(ctx, config = {}) {
      const { archivist, ...stock } = config ?? {}
      super(ctx, stock)
      this.archivist = resolveArchivistConfig(archivist)
      journal({ step: 'mounted', enabled: this.archivist.enabled, fallback: this.archivist.fallback })
      this._installGlobalInterceptor(ctx, journal)
    }

    _installGlobalInterceptor(ctx, journalFn) {
      if (!ctx || typeof ctx.on !== 'function') return
      const patch = (comp) => {
        if (!comp || typeof comp.summarize !== 'function') return
        if (comp === this || comp.__stateArchivistInstalled || comp instanceof StateCompactionEngine) return
        const origSummarize = comp.summarize.bind(comp)
        comp.__stateArchivistInstalled = true
        comp.summarize = async (input, agent, signal) => {
          if (!this.archivist.enabled) return origSummarize(input, agent, signal)
          const sessionId = agent?.session?.id
          try {
            return await this.summarizeAsArchivist(input, agent, signal)
          } catch (error) {
            if (signal?.aborted === true) throw error
            const message = error instanceof Error ? error.message : String(error)
            journalFn({ step: 'failed', sessionId, code: error?.code ?? null, error: message, fallback: this.archivist.fallback })
            if (!this.archivist.fallback) throw error
            return origSummarize(input, agent, signal)
          }
        }
        journalFn({ step: 'intercepted-preset-compaction', engineName: comp.constructor?.name || 'CompactionEngine' })
      }
      const patchAgentAndRoot = (agent) => {
        try {
          const rootComp = ctx?.root?.get?.('compaction') || ctx?.get?.('compaction')
          if (rootComp) patch(rootComp)
          const comp = agent?.ctx?.get?.('compaction') || ctx.get?.('agentPresets')?.serviceFor?.(agent, 'compaction')
          if (comp) patch(comp)
        } catch {}
      }
      patchAgentAndRoot(null)
      ctx.on('app-boot/config-reload', () => patchAgentAndRoot(null))
      ctx.on('agent/pre-step', ({ agent }, next) => {
        patchAgentAndRoot(agent)
        return typeof next === 'function' ? next() : undefined
      })
      ctx.on('agent/created', ({ agent }) => {
        patchAgentAndRoot(agent)
      })
    }

    async summarize(input, agent, signal) {
      if (!this.archivist.enabled) return super.summarize(input, agent, signal)
      const sessionId = agent?.session?.id
      try {
        return await this.summarizeAsArchivist(input, agent, signal)
      } catch (error) {
        if (signal?.aborted === true) throw error
        const message = error instanceof Error ? error.message : String(error)
        journal({ step: 'failed', sessionId, code: error?.code ?? null, error: message, fallback: this.archivist.fallback })
        if (!this.archivist.fallback) throw error
        return super.summarize(input, agent, signal)
      }
    }

    async summarizeAsArchivist(input, agent, signal) {
      const cfg = this.archivist
      const prior = findPrior(input.messages)
      const gen = (prior?.gen ?? 0) + 1
      let ptcDispatches = input.ptcDispatches
      if (!Array.isArray(ptcDispatches) && typeof agent?.session?.snapshotEvents === 'function') {
        try {
          ptcDispatches = agent.session.snapshotEvents().filter((e) => e?.type === 'tool/ptc-dispatch')
        } catch {}
      }
      const region = parseRegion(input.messages, { idFor: (n) => `G${gen}-A${n}`, isCheckpoint, ptcDispatches })
      const carried = carriedArtifacts(prior)
      const { all, stats } = reconcile(carried, region.artifacts)
      const operational = operationalLedger(region.artifacts, region.events, prior?.operational)

      const timeline = renderTimeline(region.events, cfg)
      const prompt = buildPrompt({
        timeline: timeline.text,
        priorNarrative: prior?.narrative || '',
        carried: carried.filter((c) => c.status === 'live'),
        operational,
      })
      const target = pickTarget(this.config, cfg, agent)
      if (target === undefined) throw new Error('archivist: no provider/model available (set archivist.provider/model, the engine summarization fields, or route one request)')

      const assembler = new BlockAssembler()
      const options = {
        provider: target.provider,
        model: target.model,
        system: PERSONA,
        messages: [Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: prompt })]) })],
        maxTokens: this.config.maxTokens,
        sessionId: agent.session.id,
        purpose: 'compaction',
        ...(signal === undefined ? {} : { signal }),
      }
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
      const failure = streamFailure(assembler.finish)
      if (failure !== undefined) throw failure
      const rawOutput = assembler.blocks()
      const raw = blocksText(rawOutput)

      const known = new Set(all.map((a) => a.id))
      const parsed = parseResponse(raw, known)
      const built = assemble({ gen, artifacts: all, operational, sections: parsed.sections, keep: parsed.keep, drop: parsed.drop, unknownIds: parsed.unknownIds, options: cfg })
      built.stats.outputChars = built.text.length

      const regionChars = region.events.reduce((n, e) => n + (e.type === 'artifact' ? (e.art.result?.length ?? 0) + e.art.argsRaw.length : e.text.length), 0)
      if (built.text.length >= regionChars * 0.9) {
        throw new ArchivistError('not-smaller', `state checkpoint (${built.text.length} chars) is not meaningfully smaller than the region (${regionChars} chars)`)
      }

      const usage = assembler.usage
      journal({
        step: 'archived',
        sessionId: agent.session.id,
        target,
        regionEvents: region.events.length,
        regionChars,
        inputChars: prompt.length,
        resultCap: timeline.resultCap,
        cutEvents: timeline.cutEvents,
        pass1: stats,
        carried: carried.length,
        unknownIds: parsed.unknownIds.length,
        ...built.stats,
        ...(usage === undefined ? {} : { usage }),
      })
      return {
        summary: [{ type: 'text', text: built.text }],
        rawOutput,
        provider: target.provider,
        model: target.model,
        maxTokens: this.config.maxTokens,
        ...(usage === undefined ? {} : { usage }),
      }
    }
  }
}
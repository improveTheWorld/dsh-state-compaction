# dsh-boost-compaction — la compaction d'etat

**Le probleme.** Le resume standard du harnais traite une session d'ingenierie comme un recit : il
ecrase les donnees brutes lues (un fichier lu quatre fois laisse quatre lambeaux), les constats
contre-intuitifs et les suppositions refutees. Mesure : le prompt de `dsh-compaction-basic` demande des
puces sur « Files and Code » / « Errors and Fixes », et rien d'autre ne distingue la derniere version
d'un fichier de ses versions anterieures.

**La couture.** `BasicCompactionEngine.summarize()` est, dans le `.d.ts` du harnais, « the sole subclass
customization hook ; the replay and durable mutation strategy stays fixed ». On ne reecrit donc PAS la
transaction (verrou `compaction/start`, convergence, remplacement de surface) : on remplace ce qu'elle
ecrit dedans. Le moteur monte sur un vrai `Context` cordis, `ctx.compaction instanceof
BasicCompactionEngine` (sonde, voir plus bas).

## Le principe : le modele juge, le code recopie

| | qui | quoi |
|---|---|---|
| passe 1 | **code**, zero jeton (`lib/ledger.js`) | une lecture est **ecrasee** par une lecture reussie de la meme adresse ; une ecriture est **absorbee** par une lecture ulterieure d'adresse apparentee ; une lecture suivie d'une ecriture apparentee est **perimee** (la paire derniere lecture + ecritures depuis est le fichier). Adresses Scalpel : `chemin::Classe::Methode`, apparentees = egales ou prefixe `::` |
| passe 2 | **un appel de modele** (`lib/archivist.js`) | objectif, avancement, **savoir negatif** (pieges, `REFUTED: croyance -> realite [id]`), decisions, etat du workspace, journal d'actions — et la liste d'**ids** des artefacts a faire survivre |
| assemblage | **code** | recopie les artefacts retenus **mot pour mot** depuis la region ombree (jamais d'apres ce que le modele en dit), plus le grand livre des fichiers (`CURRENT` / `STALE-AFTER-EDITS` / `EDITED-NEVER-READ`), calcule |

**Rien ne disparait en silence.** Un appel ni retenu ni ecarte laisse une ligne-souche (erreurs
d'abord) ; un id invente par le modele est ignore et nomme ; un id a la fois retenu et ecarte est
retenu (perdre est irreversible) ; un depassement de budget est nomme (`KEPT BUT NOT ATTACHED`).

**Plusieurs generations.** Le point de controle porte `gen="N"` et ses artefacts avec un en-tete JSON
et leur longueur (`chars`) : la relecture est exacte meme si un artefact contient `</artifact>`.
A la compaction suivante, les artefacts reportes passent par les memes regles (ecrases, perimes) et
sont proposes au modele par id.

## L'algorithme de continuite operationnelle (in-flight state)

Le compactage standard a un angle mort destructeur : il ecrase la dynamique d'execution en cours.
Un agent qui compacte pendant qu'un sous-agent travaille, ou avec une liste de taches active, ou
apres une decision cle de l'utilisateur, se reveille sans savoir ce qui tournait et re-dispatche a
l'aveugle.

Le registre operationnel (`## IN-FLIGHT & OPERATIONAL STATE`) resout ce probleme en extrayant
**de facon deterministe** (zero jeton, zero hallucination de modele) l'etat temps reel exact :

1. **Tableau des taches (`todo_write`) & Consolidation automatique :**
   - Parcours inverse des artefacts : le **dernier appel reussi** a `todo_write` definit le tableau actif.
   - Les appels `todo_write`, `list_agents` et `job_list` anterieurs sont automatiquement marques `superseded` (ecrases) et ne polluent pas les souches.
   - Restitution fidele sous forme de tableau de bord : `[x] ... (DONE)`, `[>] ... (IN PROGRESS)`, `[ ] ... (PENDING)`.
   - **Detection d'activite posterieure (`activityAfter`)** : si des operations d'outils ont ete executees apres le dernier `todo_write`, le registre emet un avis explicite (`Notice: N operations executed since update`). Si toutes les taches etaient achevees (`[x]`), une tache de prolongation en cours est automatiquement creee (`[>] Poursuivre les modifications...`).
   - **Auto-consolidation sans `todo_write` (`synthesized-from-activity`)** : si l'agent n'a pas emis de `todo_write`, le moteur extrait la derniere demande humaine (`source.kind === 'user'`, en ignorant les notifications systeme) et l'activite recente sur les fichiers pour generer de facon deterministe un tableau des taches en vol.
   - Si aucun `todo_write` n'est emis dans la generation courante, l'etat actif de la generation precedente est herite (`carried-from-prior`).

2. **Sous-agents et delegations (`subagent_*`) :**
   - Outils suivis : `subagent`, `subagent_implement`, `subagent_verify`, `subagent_investigate`, `subagent_fork` (y compris lorsqu'ils sont dispatches via PTC `tool/ptc-dispatch`).
   - Extraction de l'identifiant reel DSH (`started subagent <uuid>`, UUID v4, ou `agent-*` en filtrant les faux positifs comme `agent-preset` ou `agent-instructions`), du role et du brief de mission (`prompt`).
   - Resolution d'etat :
     - `run_in_background: false` : marque immediatement `[COMPLETED]` avec la synthese de sa reponse.
     - `run_in_background: true` : apparie l'identifiant aux avis `source.kind === 'subagent-settled'` (`senderSessionId`) ou au texte des evenements subsequents.
     - Sans notification de settlement dans la fenetre : marque explicitement `[RUNNING / IN-FLIGHT]` (`awaiting settlement`).
     - Plafonnement intelligent : tous les sous-agents `RUNNING` sont conserves, plus au maximum les 12 derniers sous-agents termines pour eviter l'inflation sur les longues campagnes.

3. **Decisions et questions utilisateur (`ask_user_question`) :**
   - Question sans reponse au moment de la coupe : marquee `[AWAITING USER]`.
   - Question repondue : la question ET le choix exact selectionne par l'utilisateur sont graves dans le marbre (`[ANSWERED] "Question" -> Decision: <reponse>`). Empeche l'agent de redemander un arbitrage deja tranche.

4. **Jobs d'arriere-plan (`run_detached`, `pwsh` background) :**
   - Suivi par `jobId` (formats `pwsh-12`, `bash-4`, `job-xxxx`). Un job lance reste `[RUNNING]` jusqu'a constatation de `job_kill` (`[KILLED]`), `job_output` terminal (`[FINISHED]`), ou avis `source.kind === 'tool-jobs'` (`[FINISHED]` / `[FAILED]`).
   - Persistance multi-generations : les jobs `[RUNNING]` du point de controle precedent sont relus par `parsePriorCheckpoint` et reportes en generation N+1.

## Echec : OUVERT, et journalise

Archiviste en erreur (modele indisponible, flux tronque, reponse sans `OBJECTIVE`/`PROGRESS`,
point de controle pas plus petit que la region) -> repli sur le resume standard, une ligne
`step: failed` dans `$DSH_HOME/plugin-data/dsh-boost-compaction/decisions.jsonl`. Un abandon
(`signal.aborted`) n'est jamais rattrape. `archivist.fallback: false` rend l'echec fatal.

L'appel passe par `ctx.llm.stream({ purpose: 'compaction' })` : le resolveur de modeles
(`boost-model-resolver`, interception `llm/stream`) l'arbitre comme la compaction standard.
Le resultat n'est volontairement PAS marque `llmStreamCall` : le texte assemble n'est pas la
projection du flux, on ne se declare pas « un appel direct ».

## Configuration

Memes cles que le moteur standard, plus une cle optionnelle `archivist` (retiree avant d'etre
transmise a la base, qui rejette les cles inconnues) :

| cle | defaut | sens |
|---|---|---|
| `enabled` | `true` | `false` : resume standard, aucun appel |
| `fallback` | `true` | repli ouvert sur le resume standard |
| `provider` / `model` | — | ensemble ; sinon `summarizationProvider/Model` du moteur, sinon derniere route |
| `maxInputChars` | 1 200 000 | budget de la chronologie ; au-dela, plafond par resultat divise par 2 (plancher 200), puis evenements les plus anciens coupes (nomme) |
| `resultChars` / `userChars` / `assistantChars` / `argsChars` | 6000 / 8000 / 2000 / 500 | plafonds de rendu |
| `maxArtifactChars` | 24 000 | plafond d'un artefact recopie (tete + queue, nomme) |
| `verbatimBudgetChars` | 200 000 | budget de l'annexe ; le plus ancien tombe d'abord (nomme) |
| `maxStubs` | 150 | souches affichees |

Toute troncature compte en points de code (`Array.from`), jamais en index UTF-16.

## Montage

On monte la classe **a la place** de la ligne `compaction-basic` du groupe `compaction` de chaque
preset (meme id, donc memes tests T-Q11/T-Q12), jamais a cote : deux moteurs se disputeraient
`ctx.compaction`. Un montage qui echoue est bruyant (la ligne passe en echec) — on prefere cela a
une session sans compaction. Retour arriere : remettre `name: '@deepseek-ai/dsh-compaction-basic'`,
ou `archivist: { enabled: false }`.

## Tests

```
node --test packages/boost-compaction/test/compaction.test.mjs
```

35 cas ; ceux qui ont decide la conception :
- **Grand livre et ecrasements :** T-L2 (perimee, pas ecrasee), T-L4 (un echec ne change aucun etat), T-L5 (soeurs non apparentees).
- **Archiviste et souches :** T-A4/T-A9 (souches bornees, erreurs en priorite), T-A6 (relecture exacte malgre balise de fermeture), T-E3/E5 (repli ouvert, abandon jamais rattrape).
- **Continuite operationnelle :** T-O1 (tableau de taches actif restitue), T-O2 (seul le dernier `todo_write` est retenu, les anciens ecrases), T-O3 (sous-agents en vol traces RUNNING), T-O4 (avis de settlement cloture le sous-agent en COMPLETED), T-O5 (sous-agent synchrone COMPLETED), T-O6 (decision `ask_user_question` f端gee), T-O7 (jobs de fond traces), T-O8 (survie multi-generations du tableau de taches et des sous-agents en vol).

Falsification faite : 12 mutations du code — chacune fait rougir au moins un cas de test.

## Ce qui n'est PAS verifie

- Une compaction reelle de bout en bout (modele reel, session reelle) : seul le montage sur un vrai
  `Context` cordis et le comportement contre une base factice sont mesures. Le journal
  `decisions.jsonl` (`archived` / `failed`, tailles, compteurs de la passe 1) est la mesure a lire
  apres la premiere compaction.
- La qualite du jugement du modele (savoir negatif pertinent, ids retenus) : aucun test ne la
  decide ; seul le journal et la lecture d'un vrai point de controle le peuvent.
- Les appels d'outils PTC (`run_code`) ne portent pas d'adresse : ils sont des artefacts « autres »
  (jamais ecrases), au jugement de l'archiviste.
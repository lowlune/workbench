# Pi SDK 0.87.1 — overené kontrakty (spike)

Verzia: `@earendil-works/pi-coding-agent@0.87.1` (Node >= 22.19).
Všetko nižšie je overené importom SDK a malým spikom (`node`, bez inicializácie
modelu/networku). Zdrojom je `dist/index.d.ts` a `dist/core/**`.

## 1. Registrácia custom toolu — `defineTool`

`defineTool` je len identity helper na zachovanie typovej inferencie:

```ts
export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
```

`ToolDefinition`:

```ts
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string;                       // meno pre LLM
  label: string;                      // UI label
  description: string;                // popis pre LLM
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;                // TypeBox ALEBO plain JSON Schema
  prepareArguments?: (args: unknown) => Static<TParams>;
  executionMode?: "sequential" | "parallel";
  renderShell?: "default" | "self";
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<TDetails>>;
  renderCall?/renderResult? // len TUI renderery, v SDK netreba
}
```

Registrácia cez extension factory:

```js
import { defineTool } from '@earendil-works/pi-coding-agent';
const ext = (pi) => {
  pi.registerTool(defineTool({ name, label, description, parameters, async execute(id, params, signal, onUpdate, ctx) { ... } }));
};
```

`AgentToolResult` (návrat z `execute`):

```ts
{ content: (TextContent | ImageContent)[], details: TDetails, usage?: Usage, terminate?: boolean }
```

### DÔLEŽITÉ: parameters môže byť plain JSON Schema

TypeBox **nie je** top-level závislosť Workbenchu (`import 'typebox'` padá na
`ERR_MODULE_NOT_FOUND`) a SDK `Type` nereexportuje. Netreba ho: validátor
`pi-ai/dist/utils/validation.js:280` explicitne vetví na `TypeBox.Kind` symbol:

```js
if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
  const coerced = coerceWithJsonSchema(args, tool.parameters); // plain JSON schema path
  ...
}
if (validator.Check(args)) return args;  // Compile(schema).Check — platí aj pre plain JSON Schema
```

Takže `parameters: { type:'object', properties:{...}, required:[...] }` je plne
podporované (overené spikom). Používame to, žiadne nové závislosti.

## 2. Extension runtime a interception pred vykonaním (permission)

Extension factory sa registruje cez `DefaultResourceLoader`:

```ts
interface DefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManager;
  extensionFactories?: InlineExtension[];   // <-- inline extensiony
  noExtensions?: boolean;                    // inline factories sa načítajú AJ tak
  noSkills?: boolean; noPromptTemplates?: boolean; noThemes?: boolean; noContextFiles?: boolean;
  appendSystemPrompt?: string[];
  ...
}
type InlineExtension = ExtensionFactory | { name: string; factory: ExtensionFactory; hidden?: boolean };
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

Overené: s `noExtensions: true` sa `extensionFactories` načítajú
(`resource-loader.js:744+ loadExtensionFactories`), `getExtensions().extensions`
ich obsahuje a `createAgentSession` ich nabinduje (`agent-session.js:2568 _buildRuntime`).
Netreba volať `session.bindExtensions()` — to je len na pripojenie UI/command
kontextu (RPC/TUI). `ctx.mode` je bez bindExtensions `undefined` a `ctx.hasUI`
je `false`.

`ExtensionAPI` (relevantné):

```ts
pi.registerTool(tool)
pi.on(eventType, handler)          // lifecycle hooky, viď §4
pi.registerCommand(name, opts)
pi.sendMessage(msg, opts) / pi.sendUserMessage(content, opts)
pi.appendEntry(customType, data)
pi.exec(command, args, opts): Promise<ExecResult>
pi.getActiveTools()/setActiveTools(names)
pi.setModel(model)/setThinkingLevel(level)
pi.events (EventBus)
```

### Blocking/permission pred vykonaním — PODPOROVANÉ

`pi.on('tool_call', async (event, ctx) => ToolCallEventResult | undefined)`.
Event má `{ type, toolName, toolCallId, input }` (input je mutovateľný, zmeny
prejdú pred vykonaním). Návrat:

```ts
interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;   // ukončiť batch, ak všetky výsledky terminate
}
```

Handler môže byť `async` a awaitovať. Overené poradie v `agent-loop.js`:
`tool_execution_start` sa emituje **pred** `prepareToolCall`, ktorý spustí
`agent.beforeToolCall` → extension `tool_call`. Ak handler awaituje (napr. IPC
round-trip na control), vykonanie toolu sa tým efektívne pozastaví. Pri
`{block:true}` sa tool nevykoná a vygeneruje sa error tool result; emituje sa
`tool_execution_end` s `isError:true` (ale `tool_result` hook sa pri blokovaní
**NEZAVOLÁ** — `afterToolCall` sa preskočí).

## 3. Interaktívna otázka

SDK **nemá** headless „ask user“ primitív pre SDK session. Možnosti:

- `ctx.ui.select/confirm/input/editor/custom` — vyžaduje nabindovaný
  `ExtensionUIContext` a `mode: "tui"|"rpc"` (`ctx.hasUI===true`). V našom
  SDK režime UI nie je nabindované, preto tieto metódy nie sú použiteľné
  (neinicializujeme TUI/RPC).
- **Používaný mechanizmus:** custom tool `ask_user` + IPC round-trip. `execute`
  pošle controlu `question.required` a awaituje Promise, ktorú vyrieši odpoveď
  z controlu (`{type:'response', interactionId, answers|reject}`). To je
  spoľahlivé a nezávislé od UI.

## 4. Lifecycle eventy — `session.subscribe`

`session.subscribe(listener: (event: AgentSessionEvent) => void): () => void`.
`AgentSessionEvent` = `AgentEvent` (okrem `agent_end`, ktorý je rozšírený) plus
session-specific:

Agent core eventy (`tool_execution_*`, `message_*`, `turn_*`, `agent_start`):

```ts
{ type:"agent_start" }
{ type:"agent_end", messages, willRetry }              // AgentSession verzia
{ type:"agent_settled" }                               // <-- spoľahlivý „hotovo"
{ type:"turn_start", turnIndex, timestamp }
{ type:"turn_end", turnIndex, message, toolResults, messageEntryId, toolResultEntryIds, ... }
{ type:"message_start", message }
{ type:"message_update", message, assistantMessageEvent }
{ type:"message_end", message }
{ type:"tool_execution_start", toolCallId, toolName, args }
{ type:"tool_execution_update", toolCallId, toolName, args, partialResult }
{ type:"tool_execution_end", toolCallId, toolName, result, isError }
```

Ďalšie AgentSession eventy: `queue_update`, `compaction_start`/`compaction_end`,
`entry_appended`, `session_info_changed`, `thinking_level_changed`,
`auto_retry_start`/`auto_retry_end`, `summarization_*`, `bash_execution_update`.

Poznámka k `tool_execution_end`: `result` je `AgentToolResult` (obsahuje
`content` aj `details`), takže pre `edit` vieme `details.diff`/`details.patch`.

## 5. Dokončenie / settle

- `agent_settled` — „agent run sa úplne usadil, žiadny retry/compaction/queued
  continuation". **Preferovaný signál.**
- `session.waitForIdle(): Promise<void>` — čaká na idle (robustné aj bez
  odchytu `agent_settled`).
- `session.isIdle`, `session.isStreaming`.
- `session.abort(): Promise<void>` — abort + čakanie na idle.
- `session.dispose()` — odpojí listenery.

## 6. Project context / AGENTS.md

```ts
loadProjectContextFiles({ cwd, agentDir }): Array<{ path: string; content: string }>
```

Načíta globálne aj projektové inštrukčné súbory (AGENTS.md a pod.).
**DefaultResourceLoader to robí automaticky** počas `reload()` (pokiaľ nie je
`noContextFiles`); sprístupňuje ich cez `getAgentsFiles()`.
`loadProjectContextFiles` hľadá globálny súbor **len v `agentDir`** a projektové
súbory **len v `cwd` a jeho predkoch** (nie v podadresároch pod `cwd`).

Workbench globálny `~/.config/workbench/AGENTS.md` teda loader sám nenájde.
Riešenie (Fáza 2, `server/pi/context.mjs`): `DefaultResourceLoader` podporuje
`agentsFilesOverride(input)`, ktorý dostane `{ agentsFiles }` a vráti upravený
zoznam. Override doň vloží Workbench globálny súbor (ak existuje a nie je už
prítomný), takže ide **systémovým kontextom** cez `renderProjectContext`
(`<project_instructions path=...>`) — nie prependom promptu. Projektový
`<cwd>/AGENTS.md` + predkovia idú z loader-a automaticky; nested pod `cwd` nie
(obmedzenie SDK).

## 7. Usage / cost

`Usage` (z `@earendil-works/pi-ai`):

```ts
{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens,
  cost: { input, output, cacheRead, cacheWrite, total } }
```

Zdroje:
- `message.usage` na `message_end` (per assistant message).
- `session.getSessionStats()` → `{ tokens:{input,output,cacheRead,cacheWrite,total}, cost:number, contextUsage?, ... }`.
- `getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined` (exportované SDK).

## 8. Tool factories (built-in)

```ts
createReadToolDefinition(cwd, opts)  / createReadTool(cwd, opts)
createEditToolDefinition(cwd, opts)  / createEditTool(cwd, opts)
createWriteToolDefinition(cwd, opts) / createWriteTool(cwd, opts)
createBashToolDefinition(cwd, opts)  / createBashTool(cwd, opts)
createGrepToolDefinition(cwd, opts)  / createGrepTool(cwd, opts)
createFindToolDefinition(cwd, opts)  / createFindTool(cwd, opts)
createLsToolDefinition(cwd, opts)    / createLsTool(cwd, opts)
createCodingTools(cwd, opts) / createReadOnlyTools(cwd, opts) / createAllTools(cwd, opts)
```

V `createAgentSession({ tools:[...] })` stačí mená (`read`,`grep`,`find`,`ls`,
`edit`,`write`,`bash`) + mená extension toolov. `excludeTools` je denylist.

Bash tool: pri nenulovom exit kóde **vyhodí** Error s textom
`"Command exited with code N"` → z `tool_execution_end` (`isError:true`) vieme
exit code parsovať. `details` obsahuje `{ truncation?, fullOutputPath? }`.

`edit` vracia `details: { diff, patch, firstChangedLine? }`. `write` má
`details: undefined` — pre `additions/deletions` treba pre-image stashnutý v
`tool_call` hooku a `generateUnifiedPatch(path, old, new)`. Overené: pre nový
súbor funguje `generateUnifiedPatch(path, '', content)` → `created` diff
(`@@ -0,0 +1,N @@`).

## 8b. Fáza 2 — enrichment typovaných eventov

- **Live `text.delta` (§19):** `message_update` nesie kumulatívny snapshot.
  Runner drží `lastText` per assistant message; `textFromMessage` +
  `diffText(prev, next)` vrátia `{ delta, resync }`. Ak je `next` rozšírením
  `prev`, emituje `{ kind:'text.delta', messageId, delta }` (len prírastok);
  pri štrukturálnej zmene (reset textu napr. po tool calle) `resync:true` a
  pošle sa plný snapshot. Plné snapshoty naďalej idú cez `{type:'message'}`
  (control `message` hook) — spätná kompatibilita. Poradie delta → snapshot je
  konzistentné, lebo snapshoty sú throttled (80 ms) a vždy nesú aspoň toľko
  textu, koľko už odišlo v deltách.
- **`text.delta` cez control:** control `text` hook nesie len `delta` (bez
  `messageId`). Aby `messageId` prežil do SSE (frontend `appendDelta` ho
  vyžaduje), `runtimes.mjs` routuje `text.delta` na `hooks.tool` (control
  `tool` hook = generický typovaný emitter a `kind` zachová). Ak by control
  neskôr pridal `textDelta` hook, uprednostní sa.
- **Štruktúrované tool party (§23):** `summarizeTool` dopĺňa `toolKind`, `path`,
  `additions`, `deletions`, `exitCode` (bash), `summary`, `diff` (edit/write,
  cez `capDiff` 120 kB) a `status`. `file.changed` nesie `change`, `additions`,
  `deletions`, `diff`. Veľké veci ostávajú v artefakte worktree diffu.
- **`currentAction` + ETA (§27/§28):** `currentAction(toolName, args)` →
  „Editing …", „Running tests", „Searching code"… `estimateEta(todos, startedAt)`
  vráti `etaLow/etaHigh` v ms len pri zmysluplnom pokroku (≥1 hotová úloha,
  > 3 s), inak polia vynechá. Posiela sa v `tool.started/progress/completed`
  a `todo.updated`. Persistenciu rieši control (Agent F).
- **Deletion detekcia (§21):** `parseDeletedPaths(command)` rozpozná jednoduché
  `rm`/`unlink`/`rmdir`/`git rm` v segmentoch (bez `&&`; `|`; triedy znakov) a
  runner pre ne po úspešnom bash-i emituje `file.changed` s `change:'deleted'`.
  Built-in `edit`/`write` nemažú, preto sa `deleted` odtiaľ nehlási.
- **Permission hardening (§25):** `tool_call` hook ostáva blokujúci (await IPC).
  Deny vracia `{ block:true, reason:"Permission denied for <tool>: <detail>." }`;
  zrušený request (abort) chytá a blokuje s čitateľným dôvodom (nemení input).


## 9. Explicitne NEPODPOROVANÉ / obmedzenia

- Žiadne priame SDK API na user question/permission v headless režime (riešime
  IPC custom toolom a `tool_call` blockingom).
- `ctx.ui.*` nedostupné bez `session.bindExtensions({ uiContext, mode })`; UI
  kontext by musel implementovať celý `ExtensionUIContext` — zámerne nerobíme.
- `tool_result` hook sa nezavolá pri blokovanom tooli (`tool_call` → block).
  Preto typed `tool.completed` emitujeme z `tool_execution_end`.
- `tool_call` neumožňuje meniť `input` s revalidáciou (mutácia je bez
  revalidácie) — používame len `block`.
- Detekcia `deleted` súborov: built-in tooly nemazú; `rm` cez bash sa
  nedá spoľahlivo klasifikovať (nechávame `file.changed` len pre edit/write).
- `text.delta` streaming: `message_update` nesie celú rozpracovanú správu
  (`message.content`), nie inkrementálny delta; runner preto emituje message
  snapshoty (throttled), nie `text.delta` eventy. (Control/frontend to už takto
  konzumuje.)

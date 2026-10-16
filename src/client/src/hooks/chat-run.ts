import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Message, Source, FileSource } from '../lib/api.ts'
import type { LogStep } from '../components/ProgressLog.tsx'
import type { TFunction } from '../lib/i18n.tsx'
import type { ContextReport } from '@shared/context.ts'
import type { AnswerModel, ModelFallbackReason } from '@shared/llm-catalogue.ts'
import { describeAnswerModel } from '../lib/answer-model.ts'

export type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'
export type ChatChunk = { type: string; [k: string]: unknown }

export interface EgressApproval {
  id: string
  kind: 'fetch' | 'search'
  /** Shown to the user in full. Never truncate it — a payload hides in the tail. */
  target: string
  reasons: string[]
  /** Wall-clock deadline, so the countdown survives a re-render. */
  expiresAt: number
}

/** What a run writes to while it streams: the hook's state setters and refs. */
export interface RunView {
  t: TFunction
  setStreaming: (text: string) => void
  setStreamingThinking: (text: string) => void
  setStatus: (text: string) => void
  setSteps: (steps: LogStep[]) => void
  setAnswerTime: (text: string) => void
  setApproval: Dispatch<SetStateAction<EgressApproval | null>>
  setContext: (report: ContextReport) => void
  rafRef: MutableRefObject<number>
  liveSessionRef: MutableRefObject<string | undefined>
  /** `lockedBy`: set when the turn locked the chat for good, naming the confidential collections and
   *  resources that did it. */
  onSessionCreated: (id: string, title: string, lockedBy?: string[]) => void
}

/** One answer being streamed: folds the server's events into the answer and the progress shown. */
export class ChatRun {
  text = ''
  thinking = ''
  readonly sources: Source[] = []
  readonly fileSources: FileSource[] = []
  readonly images: Array<{ url: string; alt: string }> = []
  storedIds: { user?: string; assistant?: string } = {}
  aborted = false
  private readonly blockedEngines: Array<{ engine: string; reason: string }> = []
  // Which picked model answered, or why the pick was refused, for the answer's footer.
  private modelNote = ''
  private errorNote = ''
  private lockNote = ''
  private model: AnswerModel | undefined
  private coverage: Coverage | undefined
  // Built here rather than in the component so a step's end time is the moment the next one
  // arrives, not the moment React happened to re-render.
  private readonly log: LogStep[] = []

  constructor(private readonly view: RunView, private readonly question: string, private readonly focusMode: FocusMode) {}

  handle(chunk: ChatChunk): void {
    if (!this.handleContent(chunk)) this.handleControl(chunk)
  }

  /** An image is a response even with no text: image mode stays silent unless it searched. */
  get produced(): boolean {
    return !!this.text || this.images.length > 0
  }

  /** The finished answer to append, or null when nothing was produced. */
  answer(): Message | null {
    if (!this.produced) return null
    return {
      id: this.storedIds.assistant,
      role: 'assistant',
      content: this.text,
      sources: this.sources,
      fileSources: this.fileSources.length > 0 ? this.fileSources : undefined,
      thinking: this.thinking || undefined,
      images: this.images.length > 0 ? this.images : undefined,
      model: this.model,
    }
  }

  /** Ends whatever step is still running and shows the log as it stands. */
  closeSteps(): void {
    this.endLastStep()
    this.view.setSteps([...this.log])
  }

  private endLastStep() {
    const last = this.log[this.log.length - 1]
    if (last && last.endedAt === undefined) last.endedAt = Date.now()
  }

  /** The answer, its sources and the notes about it; false for anything else. */
  private handleContent(chunk: ChatChunk): boolean {
    const { view } = this
    const { t } = view
    switch (chunk.type) {
      case 'text': this.appendText(chunk.delta as string); return true
      case 'thinking':
        this.thinking += chunk.delta as string
        view.setStreamingThinking(this.thinking)
        return true
      case 'image':
        this.images.push({ url: chunk.url as string, alt: chunk.alt as string })
        view.setStatus('')
        return true
      case 'status':
        // A status carrying `step` is a log entry; a bare one is the transient line it has
        // always been (errors, and flash, which has a single phase and so no log to build).
        if (chunk.step) this.pushStep({ ...(chunk.step as Omit<LogStep, 'startedAt' | 'text'>), text: chunk.text as string })
        else view.setStatus(chunk.text as string)
        return true
      case 'sources': this.sources.push(...(chunk.sources as Source[])); return true
      case 'file_sources': this.fileSources.push(...(chunk.sources as FileSource[])); return true
      case 'search_warning': this.blockedEngines.push(...(chunk.engines as Array<{ engine: string; reason: string }>)); return true
      case 'model':
        this.setModel({ id: chunk.id as string, label: chunk.label as string, kind: chunk.kind as AnswerModel['kind'], provider: chunk.provider as string })
        return true
      case 'model_notice': this.modelNote = t(`modelNotice.${chunk.reason as ModelFallbackReason}`); return true
      case 'coverage': this.coverage = { documents: chunk.documents as number, mode: chunk.mode as Coverage['mode'], trimmed: !!chunk.trimmed, irrelevant: (chunk.irrelevant as number | undefined) ?? 0 }; return true
      case 'confidential_excluded': this.lockNote = t('answer.confidentialExcluded', { count: chunk.count as number }); return true
      case 'model_error': this.errorNote = t('answer.modelError', { provider: chunk.provider as string, message: chunk.message as string }); return true
      default: return false
    }
  }

  /** The run's own bookkeeping: its session, egress prompts, the context report, and the end. */
  private handleControl(chunk: ChatChunk): void {
    const { view } = this
    switch (chunk.type) {
      case 'session':
        // The server's first event. Stop, resume and egress approvals all address the run by
        // session id, so a new chat has none to give them until this arrives.
        view.liveSessionRef.current = chunk.sessionId as string
        break
      case 'approval':
        view.setApproval({
          id: chunk.id as string,
          kind: chunk.kind as 'fetch' | 'search',
          target: chunk.target as string,
          reasons: chunk.reasons as string[],
          expiresAt: Date.now() + (chunk.timeoutMs as number),
        })
        break
      case 'approval_time':
        // Resume correcting a replayed countdown against the server's real deadline.
        view.setApproval(a => a && a.id === chunk.id ? { ...a, expiresAt: Date.now() + (chunk.timeoutMs as number) } : a)
        break
      case 'approval_closed': view.setApproval(a => (a && a.id === chunk.id ? null : a)); break
      case 'context': view.setContext(chunk as unknown as ContextReport); break
      case 'done': this.finish(chunk); break
    }
  }

  private appendText(delta: string) {
    const { view } = this
    this.text += delta
    cancelAnimationFrame(view.rafRef.current)
    const snap = this.text
    view.rafRef.current = requestAnimationFrame(() => view.setStreaming(snap))
    view.setStatus('')
    // The answer starting is what ends the last step and collapses the log.
    if (this.log.length && this.log[this.log.length - 1].endedAt === undefined) this.closeSteps()
  }

  private pushStep(step: Omit<LogStep, 'startedAt'>) {
    const last = this.log[this.log.length - 1]
    // Progress of the running step rewrites its row, keeping its start time.
    if (step.update && last?.kind === step.kind && last.endedAt === undefined) this.log[this.log.length - 1] = { ...last, ...step }
    else {
      this.endLastStep()
      this.log.push({ ...step, startedAt: Date.now() })
    }
    this.view.setSteps([...this.log])
  }

  /** Called at the start for a pick, and again at the end with what only the end knows: the
   *  hosting provider and the cost, or which default model answered. */
  private setModel(model: AnswerModel) {
    this.model = model
    this.modelNote = describeAnswerModel(model, this.view.t)
  }

  private finish(chunk: ChatChunk) {
    const { view } = this
    // Sent again at the end with the hosting provider the calls reported, which the start could not know.
    if (chunk.model) this.setModel(chunk.model as AnswerModel)
    if (chunk.elapsedMs) {
      view.setAnswerTime(answerFooter(view.t, {
        elapsedMs: chunk.elapsedMs as number, focusMode: this.focusMode, images: this.images.length,
        sources: this.sources.length, blockedEngines: this.blockedEngines.map(e => e.engine), coverage: this.coverage, modelNote: [this.modelNote, this.errorNote, this.lockNote].filter(Boolean).join(' '),
      }))
    }
    view.liveSessionRef.current = chunk.sessionId as string
    this.storedIds = { user: chunk.userMessageId as string | undefined, assistant: chunk.assistantMessageId as string | undefined }
    view.onSessionCreated(chunk.sessionId as string, (chunk.title as string | undefined) ?? this.question.slice(0, 60), chunk.chatLocked === true ? (chunk.lockedBy as string[] ?? []) : undefined)
  }
}

/** How a whole-collection answer read the collection: its documents in full, or each read for the task. */
export interface Coverage {
  documents: number
  mode: 'full' | 'extract'
  /** What the documents said was shortened to fit the model. */
  trimmed: boolean
  /** Documents read for the task that had nothing on it. */
  irrelevant: number
}

/** The line under a finished answer: time taken, what the search found (or which documents were
 *  read, for a whole-collection answer, which does not search), and which model answered. */
export function answerFooter(t: TFunction, { elapsedMs, focusMode, images, sources, blockedEngines, coverage, modelNote }: {
  elapsedMs: number
  focusMode: FocusMode
  images: number
  sources: number
  blockedEngines: string[]
  coverage?: Coverage
  modelNote: string
}): string {
  const label = t(images > 0 ? 'answer.generatedIn' : 'answer.answeredIn')
  const detail = coverage ? ` · ${coverageText(t, coverage)}` : searchText(t, focusMode, sources, blockedEngines)
  return t('answer.time', { label, seconds: (elapsedMs / 1000).toFixed(1) }) + detail + '.' + (modelNote ? ` ${modelNote}` : '')
}

function searchText(t: TFunction, focusMode: FocusMode, sources: number, blockedEngines: string[]): string {
  // Zero sources only means "the search came up empty" in the modes that always search. Flash
  // never searches, and image searches at its own discretion without reporting sources, so for
  // those a count of zero says nothing and is left out.
  const alwaysSearches = focusMode === 'balanced' || focusMode === 'thorough'
  if (sources > 0) return ` · ${t('answer.searchResults', { count: sources })}`
  if (blockedEngines.length) return ` · ${t('answer.enginesUnavailable', { engines: blockedEngines.join(', ') })}`
  return alwaysSearches ? ` · ${t('answer.noSearchResults')}` : ''
}

function coverageText(t: TFunction, { documents, mode, trimmed, irrelevant }: Coverage): string {
  if (mode === 'full') return t('answer.documentsInFull', { count: documents })
  return [
    t('answer.documentsForTask', { count: documents }),
    ...(irrelevant ? [t('answer.documentsNothingRelevant', { count: irrelevant })] : []),
    ...(trimmed ? [t('answer.documentsShortened')] : []),
  ].join(', ')
}

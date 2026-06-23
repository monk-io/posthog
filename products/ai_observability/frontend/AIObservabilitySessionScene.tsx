import { BindLogic, useActions, useValues } from 'kea'
import { combineUrl, router } from 'kea-router'
import { type ReactNode, Suspense, lazy, useEffect, useMemo, useState } from 'react'

import { IconChevronRight, IconWrench } from '@posthog/icons'
import { LemonButton, LemonTag, Spinner, SpinnerOverlay, Tooltip } from '@posthog/lemon-ui'

import { AccessControlAction } from 'lib/components/AccessControlAction'
import { TZLabel } from 'lib/components/TZLabel'
import { FEATURE_FLAGS } from 'lib/constants'
import { dayjs } from 'lib/dayjs'
import { LemonSkeleton } from 'lib/lemon-ui/LemonSkeleton'
import { lemonToast } from 'lib/lemon-ui/LemonToast'
import { Link } from 'lib/lemon-ui/Link'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { useAttachedLogic } from 'lib/logic/scenes/useAttachedLogic'
import { cn } from 'lib/utils/css-classes'
import { InsightEmptyState, InsightErrorState } from 'scenes/insights/EmptyStates'
import { maxGlobalLogic } from 'scenes/max/maxGlobalLogic'
import { SceneExport } from 'scenes/sceneTypes'
import { AIConsentPopoverWrapper } from 'scenes/settings/organization/AIConsentPopoverWrapper'
import { urls } from 'scenes/urls'

import { SceneBreadcrumbBackButton } from '~/layout/scenes/components/SceneBreadcrumbs'
import { LLMTrace } from '~/queries/schema/schema-general'
import { AccessControlLevel, AccessControlResourceType } from '~/types'

import { TraceSummary, aiObservabilitySessionDataLogic } from './aiObservabilitySessionDataLogic'
import { aiObservabilitySessionLogic } from './aiObservabilitySessionLogic'
import { buildSessionTimeline } from './buildSessionTimeline'
import { AIObservabilityTraceEvents } from './components/AIObservabilityTraceEvents'
import { SentimentBar } from './components/SentimentTag'
import { SessionPlayerControls } from './components/SessionPlayer/SessionPlayerControls'
import { SessionSeekbar } from './components/SessionPlayer/SessionSeekbar'
import { TypingIndicator } from './components/SessionPlayer/TypingIndicator'
import { TranscriptBubbleStream } from './ConversationDisplay/TranscriptBubbleStream'
import { SessionTurn } from './extractSessionTurns'
import { llmSentimentLazyLoaderLogic } from './llmSentimentLazyLoaderLogic'
import { llmSessionTitleLazyLoaderLogic } from './llmSessionTitleLazyLoaderLogic'
import { SENTIMENT_DATE_WINDOW_DAYS } from './sentimentUtils'
import { sessionPlaybackLogic } from './sessionPlaybackLogic'
import { formatLLMCost, getTraceTimestamp, sanitizeTraceUrlSearchParams } from './utils'

const LLMASessionFeedbackDisplay = lazy(() =>
    import('./LLMASessionFeedbackDisplay').then((m) => ({ default: m.LLMASessionFeedbackDisplay }))
)

// Playback phase for a turn: the user composing their request, the assistant
// working on its reply, or the fully-settled turn shown with all its detail.
type TurnPhase = 'userThinking' | 'aiThinking' | 'complete'

export const scene: SceneExport = {
    component: AIObservabilitySessionScene,
    logic: aiObservabilitySessionLogic,
}

export function AIObservabilitySessionScene(): JSX.Element {
    return <SessionDetailPanel showBreadcrumb />
}

export function SessionDetailPanel({ showBreadcrumb = false }: { showBreadcrumb?: boolean }): JSX.Element {
    const sessionLogic = aiObservabilitySessionLogic()
    const { sessionId, query } = useValues(sessionLogic)
    const sessionDataLogic = aiObservabilitySessionDataLogic({ sessionId, query })

    useAttachedLogic(sessionDataLogic, sessionLogic)

    return (
        <BindLogic logic={aiObservabilitySessionLogic} props={{}}>
            <BindLogic logic={aiObservabilitySessionDataLogic} props={{ sessionId, query }}>
                <SessionSceneWrapper showBreadcrumb={showBreadcrumb} />
            </BindLogic>
        </BindLogic>
    )
}

function SessionTraceSentimentBar({ traceId, createdAt }: { traceId: string; createdAt?: string }): JSX.Element | null {
    const { sentimentByTraceId, isTraceLoading } = useValues(llmSentimentLazyLoaderLogic)
    const { ensureSentimentLoaded } = useActions(llmSentimentLazyLoaderLogic)

    const cached = sentimentByTraceId[traceId]
    const loading = isTraceLoading(traceId)

    if (cached === undefined && !loading) {
        ensureSentimentLoaded(
            traceId,
            createdAt
                ? { dateFrom: createdAt, dateTo: dayjs(createdAt).add(SENTIMENT_DATE_WINDOW_DAYS, 'day').toISOString() }
                : undefined
        )
    }

    if (cached === null) {
        return null
    }

    return (
        <SentimentBar
            label={cached?.label ?? 'neutral'}
            score={cached?.score ?? 0}
            loading={loading || cached === undefined}
            messages={cached?.messages}
        />
    )
}

function SessionSceneWrapper({ showBreadcrumb = false }: { showBreadcrumb?: boolean }): JSX.Element {
    const { featureFlags } = useValues(featureFlagLogic)
    const showFeedback = !!featureFlags[FEATURE_FLAGS.POSTHOG_AI_CONVERSATION_FEEDBACK_LLMA_SESSIONS]
    const showSentiment = !!featureFlags[FEATURE_FLAGS.LLM_ANALYTICS_SENTIMENT]

    const { traces, responseLoading, responseError, sessionTurns, hasMoreData, nextDataLoading, summariesLoading } =
        useValues(aiObservabilitySessionDataLogic)
    const { sessionId, dateRange } = useValues(aiObservabilitySessionLogic)
    const { summarizeAllTraces, loadNextData } = useActions(aiObservabilitySessionDataLogic)
    const { dataProcessingAccepted } = useValues(maxGlobalLogic)
    const { getSessionTitle } = useValues(llmSessionTitleLazyLoaderLogic)
    const { ensureSessionTitleLoaded } = useActions(llmSessionTitleLazyLoaderLogic)
    // Compute the URL search-param passthrough once for the page, not per turn —
    // every `SessionTurnView` consumes the same `traceSearchParams`.
    const { searchParams } = useValues(router)
    const traceSearchParams = sanitizeTraceUrlSearchParams(searchParams, { removeSearch: true })

    const playback = sessionPlaybackLogic({ sessionId })
    const { playing, speed, currentMs, durationMs } = useValues(playback)
    const { togglePlay, setSpeed, seek, setTimeline } = useActions(playback)
    const built = buildSessionTimeline(sessionTurns)
    useEffect(() => {
        setTimeline(built.turnStartsMs, built.durationMs)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, sessionTurns.length])

    // Playback reveals each turn one phase at a time: the user composing (typing
    // indicator), the request landing, the assistant thinking, then its response.
    // While the player is idle (untouched) the whole conversation shows at once.
    const isScrubbing = playing || currentMs > 0
    const revealedTurnCount = isScrubbing
        ? built.turnRevealsMs.reduce((n, revealMs) => (revealMs <= currentMs ? n + 1 : n), 0)
        : sessionTurns.length
    const phaseOf = (i: number): TurnPhase =>
        currentMs < built.turnStartsMs[i]
            ? 'userThinking'
            : currentMs < built.turnResponsesMs[i]
              ? 'aiThinking'
              : 'complete'

    const showSessionSummarization =
        featureFlags[FEATURE_FLAGS.LLM_ANALYTICS_SESSION_SUMMARIZATION] ||
        featureFlags[FEATURE_FLAGS.LLM_ANALYTICS_EARLY_ADOPTERS]

    // Calculate session aggregates
    const sessionStats = traces.reduce(
        (acc, trace) => ({
            totalCost: acc.totalCost + (trace.totalCost || 0),
            totalLatency: acc.totalLatency + (trace.totalLatency || 0),
            traceCount: acc.traceCount + 1,
        }),
        { totalCost: 0, totalLatency: 0, traceCount: 0 }
    )

    // Same loader as the sessions list, time-bounded to the page's date range.
    const heroTitle = getSessionTitle(sessionId)
    const titleLoading = heroTitle === undefined
    useEffect(() => {
        ensureSessionTitleLoaded(sessionId, dateRange ?? undefined)
    }, [sessionId, dateRange, ensureSessionTitleLoaded])

    if (responseLoading) {
        return <SpinnerOverlay />
    }
    if (responseError) {
        return <InsightErrorState />
    }
    if (!traces || traces.length === 0) {
        return <InsightEmptyState heading="No traces found" detail="This session has no traces." />
    }

    return (
        <div className="relative flex flex-col gap-4 max-w-[75rem] min-h-full">
            {showBreadcrumb && <SceneBreadcrumbBackButton />}
            {titleLoading ? (
                <LemonSkeleton className="h-8 w-96 max-w-full" />
            ) : (
                heroTitle && <h1 className="text-2xl font-semibold leading-tight m-0 break-words">{heroTitle}</h1>
            )}
            <header className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex gap-1.5 flex-wrap">
                    <LemonTag size="medium" className="bg-surface-primary">
                        <span className="font-mono">{sessionId}</span>
                    </LemonTag>
                    <LemonTag size="medium" className="bg-surface-primary">
                        {sessionStats.traceCount}
                        {hasMoreData ? '+' : ''} {sessionStats.traceCount === 1 ? 'turn' : 'turns'}
                    </LemonTag>
                    {sessionStats.totalCost > 0 && (
                        <LemonTag size="medium" className="bg-surface-primary">
                            Total: {formatLLMCost(sessionStats.totalCost)}
                        </LemonTag>
                    )}
                    {sessionStats.totalLatency > 0 && (
                        <LemonTag size="medium" className="bg-surface-primary">
                            {sessionStats.totalLatency.toFixed(2)}s
                        </LemonTag>
                    )}
                    {showFeedback && (
                        <Suspense fallback={<Spinner />}>
                            <LLMASessionFeedbackDisplay sessionId={sessionId} />
                        </Suspense>
                    )}
                </div>
                {showSessionSummarization && (
                    <SummarizeAllButton
                        loading={summariesLoading}
                        dataProcessingAccepted={dataProcessingAccepted}
                        onSummarize={summarizeAllTraces}
                    />
                )}
            </header>

            <div className="flex flex-col flex-1">
                {(isScrubbing ? sessionTurns.slice(0, revealedTurnCount) : sessionTurns).map((turn, i) => (
                    <SessionTurnView
                        key={turn.trace.id}
                        turn={turn}
                        turnIndex={i}
                        allTurns={sessionTurns}
                        phase={isScrubbing ? phaseOf(i) : 'complete'}
                        showSentiment={showSentiment}
                        showSessionSummarization={!!showSessionSummarization}
                        traceSearchParams={traceSearchParams}
                    />
                ))}
                {hasMoreData && (
                    <div className="flex justify-center pt-4">
                        <LemonButton
                            type="secondary"
                            loading={nextDataLoading}
                            onClick={loadNextData}
                            data-attr="llm-session-load-more-traces"
                        >
                            Load more turns
                        </LemonButton>
                    </div>
                )}
            </div>

            {/* The player anchors to the bottom like a session-replay scrubber, so it
                stays in reach while the conversation reveals and scrolls above it. */}
            {durationMs > 0 && (
                <div className="sticky bottom-0 z-10 mt-2 flex flex-col gap-2 rounded border border-primary bg-surface-primary p-3 shadow">
                    <SessionSeekbar
                        durationMs={durationMs}
                        currentMs={currentMs}
                        turnStartsMs={built.turnStartsMs}
                        turnResponsesMs={built.turnResponsesMs}
                        onSeek={seek}
                    />
                    <div className="flex items-center gap-3 text-[11px] text-muted">
                        <span className="flex items-center gap-1">
                            <span className="w-1 h-3 rounded-full bg-muted" /> User
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="w-1 h-3 rounded-full bg-success" /> Assistant
                        </span>
                    </div>
                    <SessionPlayerControls
                        playing={playing}
                        speed={speed}
                        currentMs={currentMs}
                        durationMs={durationMs}
                        onTogglePlay={togglePlay}
                        onSetSpeed={setSpeed}
                    />
                </div>
            )}
        </div>
    )
}

function SummarizeAllButton({
    loading,
    dataProcessingAccepted,
    onSummarize,
}: {
    loading: boolean
    dataProcessingAccepted: boolean
    onSummarize: () => void
}): JSX.Element {
    if (!dataProcessingAccepted) {
        return (
            <AIConsentPopoverWrapper showArrow onApprove={onSummarize} hidden={loading}>
                <AccessControlAction
                    resourceType={AccessControlResourceType.LlmAnalytics}
                    minAccessLevel={AccessControlLevel.Editor}
                >
                    <LemonButton
                        type="primary"
                        size="small"
                        loading={loading}
                        disabledReason="AI data processing must be approved to summarize traces"
                        data-attr="llm-session-summarize-all"
                    >
                        Summarize all turns
                    </LemonButton>
                </AccessControlAction>
            </AIConsentPopoverWrapper>
        )
    }
    return (
        <AccessControlAction
            resourceType={AccessControlResourceType.LlmAnalytics}
            minAccessLevel={AccessControlLevel.Editor}
        >
            <LemonButton
                type="primary"
                size="small"
                onClick={onSummarize}
                loading={loading}
                data-attr="llm-session-summarize-all"
            >
                Summarize all turns
            </LemonButton>
        </AccessControlAction>
    )
}

function SessionTurnView({
    turn,
    turnIndex,
    allTurns,
    phase = 'complete',
    showSentiment,
    showSessionSummarization,
    traceSearchParams,
}: {
    turn: SessionTurn
    turnIndex: number
    allTurns: SessionTurn[]
    phase?: TurnPhase
    showSentiment: boolean
    showSessionSummarization: boolean
    traceSearchParams: Record<string, unknown>
}): JSX.Element {
    const { traceSummaries, loadingFullTraces, fullTraces, stepsExpandedTraceIds, expandedGenerationIds } = useValues(
        aiObservabilitySessionDataLogic
    )
    const { toggleSteps, toggleGenerationExpanded, loadFullTrace } = useActions(aiObservabilitySessionDataLogic)
    const [traceLinksShown, setTraceLinksShown] = useState(false)

    const trace = turn.trace
    const summary: TraceSummary | undefined = traceSummaries[trace.id]
    const isLoading = loadingFullTraces.has(trace.id)
    const stepsShown = stepsExpandedTraceIds.has(trace.id)
    const fullTrace = fullTraces[trace.id]
    const baseTraceParams = {
        ...traceSearchParams,
        timestamp: getTraceTimestamp(trace.createdAt),
    }
    const traceUrl = combineUrl(urls.aiObservabilityTrace(trace.id), baseTraceParams).url
    const summaryUrl = combineUrl(urls.aiObservabilityTrace(trace.id), { ...baseTraceParams, tab: 'summary' }).url

    const hasTranscript = turn.isLoaded && !!turn.userVisibleTurn
    // Span-only turns have no transcript to fall back to, so the span tree IS the
    // conversation — show it directly rather than tucked behind a disclosure.
    const isSpanOnly = turn.isLoaded && !turn.userVisibleTurn
    // Mid-playback phases reveal the turn incrementally; only a settled turn shows
    // its summary, tools, errors, steps, and the trace sidebar.
    const isComplete = phase === 'complete'

    return (
        <div className="flex flex-col">
            <div className="flex items-center gap-3 py-3 text-xs text-muted">
                <div className="flex-1 border-t" />
                <TZLabel time={trace.createdAt} formatDate="MMM D, YYYY" formatTime="h:mm A" />
                <div className="flex-1 border-t" />
            </div>
            <div className="flex gap-10 pb-4">
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                    {isComplete && showSessionSummarization && summary && (
                        <TurnSummaryLine summary={summary} summaryUrl={summaryUrl} />
                    )}

                    <TurnBody turn={turn} phase={phase} isLoading={isLoading} onLoad={() => loadFullTrace(trace.id)} />

                    {isComplete && turn.tools.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted">
                            <IconWrench className="text-sm shrink-0" />
                            {turn.tools.map((name) => (
                                <LemonTag key={name} size="small" className="font-mono">
                                    {name}
                                </LemonTag>
                            ))}
                        </div>
                    )}

                    {isComplete && (trace.errorCount ?? 0) > 0 && (
                        <div className="flex items-center gap-2 min-w-0">
                            <LemonTag type="danger" size="small" className="shrink-0">
                                {trace.errorCount === 1 ? '1 error' : `${trace.errorCount} errors`}
                            </LemonTag>
                            {turn.errors.length > 0 && (
                                <Tooltip
                                    title={
                                        <div className="flex flex-col gap-1">
                                            {turn.errors.map((e, i) => (
                                                <div key={i}>
                                                    <strong>{e.label}:</strong> {e.message}
                                                </div>
                                            ))}
                                        </div>
                                    }
                                >
                                    <span className="text-xs text-muted truncate">
                                        {turn.errors[0].label} · {turn.errors[0].message}
                                        {turn.errors.length > 1 && ` · +${turn.errors.length - 1} more`}
                                    </span>
                                </Tooltip>
                            )}
                        </div>
                    )}

                    {/* Per-turn actions sit under the assistant's response as small
                        disclosures — the agent's work and trace, one click away. */}
                    {isComplete && hasTranscript && (
                        <div className="flex flex-col gap-1.5">
                            <TurnDisclosure
                                label={stepsShown ? 'Hide steps' : 'Show steps'}
                                expanded={stepsShown}
                                onToggle={() => {
                                    if (!stepsShown && !fullTrace && !isLoading) {
                                        loadFullTrace(trace.id)
                                    }
                                    toggleSteps(trace.id)
                                }}
                            >
                                <StepsPanel
                                    traceId={trace.id}
                                    fullTrace={fullTrace}
                                    expandedEventIds={expandedGenerationIds}
                                    onToggleEventExpand={toggleGenerationExpanded}
                                />
                            </TurnDisclosure>

                            <TurnDisclosure
                                label="View trace"
                                expanded={traceLinksShown}
                                onToggle={() => setTraceLinksShown((v) => !v)}
                            >
                                <div className="flex flex-col gap-1 items-start pl-4">
                                    <Link to={traceUrl} target="_blank" className="text-xs">
                                        Open trace
                                    </Link>
                                    <Link to={summaryUrl} target="_blank" className="text-xs">
                                        View summary
                                    </Link>
                                </div>
                            </TurnDisclosure>

                            {turn.outputs.length > 0 && (
                                <TurnIntoEvalDisclosure turn={turn} turnIndex={turnIndex} allTurns={allTurns} />
                            )}
                        </div>
                    )}

                    {isComplete && isSpanOnly && (
                        <StepsPanel
                            traceId={trace.id}
                            fullTrace={fullTrace}
                            expandedEventIds={expandedGenerationIds}
                            onToggleEventExpand={toggleGenerationExpanded}
                        />
                    )}
                </div>

                {isComplete && showSentiment && (
                    <div className="w-40 shrink-0 flex flex-col gap-1 text-xs text-muted">
                        <SessionTraceSentimentBar traceId={trace.id} createdAt={trace.createdAt} />
                    </div>
                )}
            </div>
        </div>
    )
}

// A small chevron disclosure matching the conversation's other inline controls:
// a muted label that rotates a caret open and reveals its content below.
function TurnDisclosure({
    label,
    expanded,
    onToggle,
    children,
}: {
    label: string
    expanded: boolean
    onToggle: () => void
    children: ReactNode
}): JSX.Element {
    return (
        <div className="flex flex-col gap-1.5 text-xs text-muted">
            <button
                type="button"
                className="flex items-center gap-1 self-start hover:text-default cursor-pointer"
                onClick={onToggle}
            >
                <IconChevronRight className={cn('transition-transform', expanded && 'rotate-90')} />
                <span>{label}</span>
            </button>
            {expanded && children}
        </div>
    )
}

// Mock: previews turning an assistant response (plus everything before it) into an
// evaluation case. The capture isn't wired up yet — this just demonstrates the flow.
function TurnIntoEvalDisclosure({
    turn,
    turnIndex,
    allTurns,
}: {
    turn: SessionTurn
    turnIndex: number
    allTurns: SessionTurn[]
}): JSX.Element {
    const [expanded, setExpanded] = useState(false)
    // Everything the eval would treat as input: every message before this turn's
    // response — all prior turns plus this turn's own request.
    const contextCount = useMemo(
        () =>
            allTurns.slice(0, turnIndex).reduce((n, t) => n + t.newInputs.length + t.outputs.length, 0) +
            turn.newInputs.length,
        [allTurns, turnIndex, turn.newInputs.length]
    )
    const messages = contextCount === 1 ? 'message' : 'messages'
    const createEval = (): void => {
        lemonToast.success(`Evaluation created from this response and ${contextCount} ${messages} of context (mock)`)
        setExpanded(false)
    }
    return (
        <TurnDisclosure label="Turn into eval" expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
            <div className="flex flex-col gap-2 items-start pl-4">
                <span>
                    Turns the assistant's response and the {contextCount} {messages} of context before it into an
                    evaluation case.
                </span>
                <LemonButton type="primary" size="xsmall" onClick={createEval}>
                    Create evaluation
                </LemonButton>
            </div>
        </TurnDisclosure>
    )
}

function TurnSummaryLine({ summary, summaryUrl }: { summary: TraceSummary; summaryUrl: string }): JSX.Element {
    if (summary.loading) {
        return (
            <div className="flex items-center gap-2 text-muted text-sm">
                <Spinner className="text-lg" />
                <span>Generating summary...</span>
            </div>
        )
    }
    if (summary.error) {
        return (
            <Tooltip title={summary.error}>
                <span className="text-danger text-sm">Failed to generate summary</span>
            </Tooltip>
        )
    }
    return (
        <Link to={summaryUrl} className="text-sm font-medium">
            {summary.title}
        </Link>
    )
}

function TurnBody({
    turn,
    phase = 'complete',
    isLoading,
    onLoad,
}: {
    turn: SessionTurn
    phase?: TurnPhase
    isLoading: boolean
    onLoad: () => void
}): JSX.Element | null {
    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-muted text-sm py-2">
                <Spinner className="text-lg" />
                <span>Loading conversation…</span>
            </div>
        )
    }
    if (!turn.isLoaded) {
        return (
            <div className="py-2">
                <LemonButton size="small" type="secondary" onClick={onLoad}>
                    Show conversation
                </LemonButton>
            </div>
        )
    }
    if (!turn.userVisibleTurn) {
        // No chat to render — the parent renders `StepsPanel` inline below as the substitute.
        return null
    }
    // Before the request lands, the user is "composing" — a user-side typing indicator.
    if (phase === 'userThinking') {
        return <TypingIndicator type="human" />
    }
    // The request is in but the response is still "in flight" — show the request plus
    // an assistant typing indicator until the AI latency window elapses.
    if (phase === 'aiThinking') {
        return (
            <div className="flex flex-col gap-1.5">
                <TranscriptBubbleStream inputs={turn.newInputs} outputs={[]} />
                <TypingIndicator />
            </div>
        )
    }
    // `turn.newInputs` / `outputs` come pre-deduped from `extractSessionTurns`.
    return <TranscriptBubbleStream inputs={turn.newInputs} outputs={turn.outputs} />
}

function StepsPanel({
    traceId,
    fullTrace,
    expandedEventIds,
    onToggleEventExpand,
}: {
    traceId: string
    fullTrace: LLMTrace | undefined
    expandedEventIds: Set<string>
    onToggleEventExpand: (eventId: string) => void
}): JSX.Element {
    return (
        <div className="border rounded bg-bg-light p-3">
            <AIObservabilityTraceEvents
                trace={fullTrace}
                isLoading={false}
                expandedEventIds={expandedEventIds}
                onToggleEventExpand={onToggleEventExpand}
                traceId={traceId}
            />
        </div>
    )
}

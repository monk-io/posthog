import { actions, connect, kea, listeners, path, props, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'
import { actionToUrl, combineUrl, router, urlToAction } from 'kea-router'

import api from 'lib/api'
import { TaxonomicFilterGroupType } from 'lib/components/TaxonomicFilter/types'
import { urls } from 'scenes/urls'

import { groupsModel } from '~/models/groupsModel'
import { DataTableNode, HogQLQuery, LLMTrace, NodeKind, TraceQuery, TracesQuery } from '~/queries/schema/schema-general'
import { PropertyFilterType, PropertyOperator } from '~/types'

import sessionsQueryTemplate from '../../backend/queries/sessions.sql?raw'
import { SortDirection, SortState, aiObservabilitySharedLogic } from '../aiObservabilitySharedLogic'
import type { aiObservabilitySessionsViewLogicType } from './aiObservabilitySessionsViewLogicType'

export type AIObservabilitySessionsViewLogicProps = Record<string, never>

export interface SessionListRow {
    sessionId: string
    distinctId: string
    traces: number
    totalCost: number
    totalLatency: number
    errors: number
    lastSeen: string
}

export const aiObservabilitySessionsViewLogic = kea<aiObservabilitySessionsViewLogicType>([
    path(['products', 'ai_observability', 'frontend', 'tabs', 'aiObservabilitySessionsViewLogic']),
    props({} as AIObservabilitySessionsViewLogicProps),
    connect(() => ({
        values: [
            aiObservabilitySharedLogic,
            ['dateFilter', 'shouldFilterTestAccounts', 'propertyFilters'],
            groupsModel,
            ['groupsTaxonomicTypes'],
        ],
        actions: [
            aiObservabilitySharedLogic,
            ['setDates', 'setPropertyFilters', 'setShouldFilterTestAccounts', 'applyUrlState'],
        ],
    })),

    actions({
        setSessionsSort: (column: string, direction: SortDirection) => ({ column, direction }),
        selectSession: (sessionId: string | null) => ({ sessionId }),
        toggleSessionExpanded: (sessionId: string) => ({ sessionId }),
        toggleTraceExpanded: (traceId: string) => ({ traceId }),
        toggleGenerationExpanded: (uuid: string, traceId: string) => ({ uuid, traceId }),
        loadSessionTraces: (sessionId: string) => ({ sessionId }),
        loadSessionTracesSuccess: (sessionId: string, traces: LLMTrace[]) => ({ sessionId, traces }),
        loadSessionTracesFailure: (sessionId: string, error: Error) => ({ sessionId, error }),
        loadFullTrace: (traceId: string) => ({ traceId }),
        loadFullTraceSuccess: (traceId: string, trace: LLMTrace) => ({ traceId, trace }),
        loadFullTraceFailure: (traceId: string, error: Error) => ({ traceId, error }),
    }),

    reducers({
        selectedSessionId: [
            null as string | null,
            {
                selectSession: (_, { sessionId }) => sessionId,
            },
        ],
        sessionsSort: [
            { column: 'last_seen', direction: 'DESC' } as SortState,
            {
                setSessionsSort: (_, { column, direction }): SortState => ({ column, direction }),
            },
        ],

        expandedSessionIds: [
            new Set<string>() as Set<string>,
            {
                toggleSessionExpanded: (state, { sessionId }) => {
                    const newSet = new Set(state)

                    if (newSet.has(sessionId)) {
                        newSet.delete(sessionId)
                    } else {
                        newSet.add(sessionId)
                    }

                    return newSet
                },
                setDates: () => new Set<string>(),
                setPropertyFilters: () => new Set<string>(),
                setShouldFilterTestAccounts: () => new Set<string>(),
                applyUrlState: () => new Set<string>(),
            },
        ],

        expandedTraceIds: [
            new Set<string>() as Set<string>,
            {
                toggleTraceExpanded: (state, { traceId }) => {
                    const newSet = new Set(state)

                    if (newSet.has(traceId)) {
                        newSet.delete(traceId)
                    } else {
                        newSet.add(traceId)
                    }

                    return newSet
                },
                setDates: () => new Set<string>(),
                setPropertyFilters: () => new Set<string>(),
                setShouldFilterTestAccounts: () => new Set<string>(),
                applyUrlState: () => new Set<string>(),
            },
        ],

        expandedGenerationIds: [
            new Set<string>() as Set<string>,
            {
                toggleGenerationExpanded: (state, { uuid }) => {
                    const newSet = new Set(state)

                    if (newSet.has(uuid)) {
                        newSet.delete(uuid)
                    } else {
                        newSet.add(uuid)
                    }

                    return newSet
                },
                setDates: () => new Set<string>(),
                setPropertyFilters: () => new Set<string>(),
                setShouldFilterTestAccounts: () => new Set<string>(),
                applyUrlState: () => new Set<string>(),
            },
        ],

        sessionTraces: [
            {} as Record<string, LLMTrace[]>,
            {
                loadSessionTracesSuccess: (state, { sessionId, traces }) => ({
                    ...state,
                    [sessionId]: traces,
                }),
                setDates: () => ({}),
                setPropertyFilters: () => ({}),
                setShouldFilterTestAccounts: () => ({}),
                applyUrlState: () => ({}),
            },
        ],

        fullTraces: [
            {} as Record<string, LLMTrace>,
            {
                loadFullTraceSuccess: (state, { traceId, trace }) => ({
                    ...state,
                    [traceId]: trace,
                }),
                setDates: () => ({}),
                setPropertyFilters: () => ({}),
                setShouldFilterTestAccounts: () => ({}),
                applyUrlState: () => ({}),
            },
        ],

        loadingSessionTraces: [
            new Set<string>() as Set<string>,
            {
                loadSessionTraces: (state, { sessionId }) => new Set(state).add(sessionId),
                loadSessionTracesSuccess: (state, { sessionId }) => {
                    const newSet = new Set(state)
                    newSet.delete(sessionId)
                    return newSet
                },
                loadSessionTracesFailure: (state, { sessionId }) => {
                    const newSet = new Set(state)
                    newSet.delete(sessionId)
                    return newSet
                },
            },
        ],

        loadingFullTraces: [
            new Set<string>() as Set<string>,
            {
                loadFullTrace: (state, { traceId }) => new Set(state).add(traceId),
                loadFullTraceSuccess: (state, { traceId }) => {
                    const newSet = new Set(state)
                    newSet.delete(traceId)
                    return newSet
                },
                loadFullTraceFailure: (state, { traceId }) => {
                    const newSet = new Set(state)
                    newSet.delete(traceId)
                    return newSet
                },
            },
        ],

        sessionTracesErrors: [
            new Set<string>() as Set<string>,
            {
                loadSessionTracesFailure: (state, { sessionId }) => new Set(state).add(sessionId),
                loadSessionTracesSuccess: (state, { sessionId }) => {
                    const newSet = new Set(state)
                    newSet.delete(sessionId)
                    return newSet
                },
                setDates: () => new Set<string>(),
                setPropertyFilters: () => new Set<string>(),
                setShouldFilterTestAccounts: () => new Set<string>(),
                applyUrlState: () => new Set<string>(),
            },
        ],

        fullTracesErrors: [
            new Set<string>() as Set<string>,
            {
                loadFullTraceFailure: (state, { traceId }) => new Set(state).add(traceId),
                loadFullTraceSuccess: (state, { traceId }) => {
                    const newSet = new Set(state)
                    newSet.delete(traceId)
                    return newSet
                },
                setDates: () => new Set<string>(),
                setPropertyFilters: () => new Set<string>(),
                setShouldFilterTestAccounts: () => new Set<string>(),
                applyUrlState: () => new Set<string>(),
            },
        ],
    }),

    loaders(({ values }) => ({
        sessions: [
            [] as SessionListRow[],
            {
                loadSessions: async (): Promise<SessionListRow[]> => {
                    const source = values.sessionsQuery.source as HogQLQuery
                    const response = await api.query(source)
                    const columns = (response.columns ?? []) as string[]
                    const at = (name: string): number => columns.indexOf(name)
                    const rows = (response.results ?? []) as unknown[][]
                    return rows.map((row) => ({
                        sessionId: String(row[at('session_id')] ?? ''),
                        distinctId: String(row[at('distinct_id')] ?? ''),
                        traces: Number(row[at('traces')] ?? 0),
                        totalCost: Number(row[at('total_cost')] ?? 0),
                        totalLatency: Number(row[at('total_latency')] ?? 0),
                        errors: Number(row[at('errors')] ?? 0),
                        lastSeen: String(row[at('last_seen')] ?? ''),
                    }))
                },
            },
        ],
    })),

    listeners(({ actions, values }) => ({
        applyUrlState: () => actions.loadSessions(),
        setSessionsSort: () => actions.loadSessions(),
        toggleSessionExpanded: async ({ sessionId }) => {
            if (
                values.expandedSessionIds.has(sessionId) &&
                !values.sessionTraces[sessionId] &&
                !values.loadingSessionTraces.has(sessionId)
            ) {
                actions.loadSessionTraces(sessionId)
            }
        },

        loadSessionTraces: async ({ sessionId }) => {
            const dateFrom = values.dateFilter.dateFrom || undefined
            const dateTo = values.dateFilter.dateTo || undefined

            const tracesQuerySource: TracesQuery = {
                kind: NodeKind.TracesQuery,
                dateRange: {
                    date_from: dateFrom,
                    date_to: dateTo,
                },
                properties: [
                    {
                        type: PropertyFilterType.Event,
                        key: '$ai_session_id',
                        operator: PropertyOperator.Exact,
                        value: sessionId,
                    },
                ],
            }

            try {
                const response = await api.query(tracesQuerySource)

                if (response.results) {
                    actions.loadSessionTracesSuccess(sessionId, response.results)
                }
            } catch (error) {
                console.error('Error loading traces for session:', error)
                actions.loadSessionTracesFailure(sessionId, error as Error)
            }
        },

        toggleTraceExpanded: async ({ traceId }) => {
            if (
                values.expandedTraceIds.has(traceId) &&
                !values.fullTraces[traceId] &&
                !values.loadingFullTraces.has(traceId)
            ) {
                actions.loadFullTrace(traceId)
            }
        },

        loadFullTrace: async ({ traceId }) => {
            const dateFrom = values.dateFilter.dateFrom || undefined
            const dateTo = values.dateFilter.dateTo || undefined

            const traceQuery: TraceQuery = {
                kind: NodeKind.TraceQuery,
                traceId,
                dateRange: {
                    date_from: dateFrom,
                    date_to: dateTo,
                },
            }

            try {
                const response = await api.query(traceQuery)

                if (response.results && response.results[0]) {
                    actions.loadFullTraceSuccess(traceId, response.results[0])
                }
            } catch (error) {
                console.error('Error loading full trace:', error)
                actions.loadFullTraceFailure(traceId, error as Error)
            }
        },
    })),

    selectors({
        sessionsQuery: [
            (s) => [
                s.dateFilter,
                s.shouldFilterTestAccounts,
                s.propertyFilters,
                s.sessionsSort,
                s.groupsTaxonomicTypes,
            ],
            (
                dateFilter: { dateFrom: string | null; dateTo: string | null },
                shouldFilterTestAccounts: boolean,
                propertyFilters,
                sessionsSort: { column: string; direction: 'ASC' | 'DESC' },
                groupsTaxonomicTypes: TaxonomicFilterGroupType[]
            ): DataTableNode => {
                const query = sessionsQueryTemplate
                    .replace('__ORDER_BY__', sessionsSort.column)
                    .replace('__ORDER_DIRECTION__', sessionsSort.direction)

                return {
                    kind: NodeKind.DataTableNode,
                    source: {
                        kind: NodeKind.HogQLQuery,
                        query,
                        filters: {
                            dateRange: {
                                date_from: dateFilter.dateFrom || null,
                                date_to: dateFilter.dateTo || null,
                            },
                            filterTestAccounts: shouldFilterTestAccounts,
                            properties: propertyFilters,
                        },
                    },
                    columns: [
                        'session_id',
                        'distinct_id',
                        'traces',
                        'spans',
                        'generations',
                        'embeddings',
                        'tools',
                        'errors',
                        'total_cost',
                        'total_latency',
                        'first_seen',
                        'last_seen',
                    ],
                    showDateRange: true,
                    showReload: true,
                    showSearch: true,
                    showPropertyFilter: [
                        TaxonomicFilterGroupType.EventProperties,
                        TaxonomicFilterGroupType.PersonProperties,
                        ...groupsTaxonomicTypes,
                        TaxonomicFilterGroupType.Cohorts,
                        TaxonomicFilterGroupType.HogQLExpression,
                    ],
                    showTestAccountFilters: true,
                    showExport: true,
                    showColumnConfigurator: true,
                    allowSorting: true,
                }
            },
        ],
    }),

    urlToAction(({ actions, values }) => ({
        '/ai-observability/sessions/:id': ({ id }) => {
            if (id && id !== values.selectedSessionId) {
                actions.selectSession(id)
            }
        },
        '/ai-observability/sessions': () => {
            if (values.selectedSessionId) {
                actions.selectSession(null)
            }
        },
    })),

    actionToUrl(() => ({
        selectSession: ({ sessionId }) => {
            const search = router.values.searchParams
            return sessionId
                ? combineUrl(urls.aiObservabilitySession(sessionId), search).url
                : combineUrl(urls.aiObservabilitySessions(), search).url
        },
    })),
])

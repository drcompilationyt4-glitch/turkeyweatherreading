import * as fs from 'fs'
import path from 'path'
import axios from 'axios'
import { randomInt } from 'crypto'

import { URLs } from '../../constants/urls'
import type { BasePromotion, Dashboard } from '../../interface/DashboardData'
import type { MicrosoftRewardsBot } from '../../index'

interface ActivityQueries {
    title: string
    queries: string[]
}

// LLM model configuration for query generation fallback
// NOTE: minimax/minimax-m2.5 went paid-only on OpenRouter (HTTP 404 on the :free slug)
const LLM_MODELS = [
    { name: 'nvidia/nemotron-3-super-120b-a12b:free', weight: 1 / 5 },
    { name: 'nvidia/nemotron-3-ultra-550b-a55b:free', weight: 1 / 5 },
    { name: 'nvidia/nemotron-3-nano-30b-a3b:free', weight: 1 / 5 },
    { name: 'openai/gpt-oss-20b:free', weight: 1 / 5 },
    { name: 'poolside/laguna-s-2.1:free', weight: 1 / 5 },
]

function selectRandomLLMModel(): string {
    const random = randomInt(0, 1000000) / 1000000
    let cumulativeWeight = 0
    for (const model of LLM_MODELS) {
        cumulativeWeight += model.weight
        if (random <= cumulativeWeight) {
            return model.name
        }
    }
    return LLM_MODELS[0]!.name
}

async function callLLMQueryGenerator(bot: MicrosoftRewardsBot, promotion: BasePromotion): Promise<string | null> {
    const apiKey = (process.env.OPENROUTER_API_KEY || (bot.config as any)?.openRouterApiKey || '').toString().trim()
    if (!apiKey) return null

    const client = axios.create({
        baseURL: 'https://openrouter.ai/api/v1',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': '<YOUR_SITE_URL>', // Optional. Site URL for rankings on openrouter.ai.
            'X-OpenRouter-Title': '<YOUR_SITE_NAME>', // Optional. Site title for rankings on openrouter.ai.
            'Content-Type': 'application/json'
        },
        proxy: false,
        timeout: 20000
    })

    const prompt = `
Generate a natural Bing search query.
Title: "${promotion.title}"
Description: "${promotion.description || ''}"

Improve it to sound human.
2-8 words only.
Return ONLY the query.
`

    // Weighted-random primary choice, then fall through the whole model list so a
    // broken/rate-limited/unavailable model never blocks query generation.
    const primary = selectRandomLLMModel()
    const tryOrder = [primary, ...LLM_MODELS.filter(m => m.name !== primary).map(m => m.name)]

    let lastError: unknown = null
    for (const model of tryOrder) {
        try {
            const res = await client.post('/chat/completions', {
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 50
            })

            const text = res.data?.choices?.[0]?.message?.content?.trim()
            if (text) return text.split('\n')[0].trim()
            bot.logger.warn(bot.isMobile, 'SEARCH-ON-BING-LLM', `Model ${model} returned empty content`)
        } catch (err) {
            lastError = err
            bot.logger.warn(
                bot.isMobile,
                'SEARCH-ON-BING-LLM',
                `Model ${model} failed: ${err instanceof Error ? err.message : String(err)} - trying next model`
            )
        }
    }

    bot.logger.warn(
        bot.isMobile,
        'SEARCH-ON-BING-LLM',
        `All models failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
    return null
}

export async function activateSearchOnBing(bot: MicrosoftRewardsBot, promotion: BasePromotion): Promise<boolean> {
    const offerId = promotion.offerId
    const actionId = bot.nextActions.reportActivity

    if (!actionId) {
        bot.logger.warn(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `Skipping ${offerId}: "reportActivity" not discovered in bundle`
        )
        return false
    }

    const live = await bot.browser.func.ensureOffer(offerId)
    const hash = live?.hash ?? promotion.hash ?? null
    if (!hash) {
        bot.logger.warn(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `Skipping ${offerId}: no live hash for the activation offer`
        )
        return false
    }

    try {
        const { status, acknowledged } = await bot.browser.func.reportServerAction(actionId, [
            hash,
            11,
            {
                offerid: offerId,
                isPromotional: '$undefined',
                timezoneOffset: bot.userData.timezoneOffset
            }
        ])

        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `Activated activity | offerId=${offerId} | status=${status} | acknowledged=${acknowledged}`
        )
        return acknowledged
    } catch (error) {
        bot.logger.error(
            bot.isMobile,
            'SEARCH-ON-BING-ACTIVATE',
            `Activation failed | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
        )
        return false
    }
}

export function findSearchOnBingOffer(dashboard: Dashboard, offerId: string): BasePromotion | undefined {
    const offers = [
        ...Object.values(dashboard.dailySetPromotions ?? {}).flat(),
        ...(dashboard.morePromotions ?? []),
        ...(dashboard.promotionalItems ?? []),
        ...(dashboard.promotionalItem ? [dashboard.promotionalItem] : [])
    ]
    return offers.find(offer => offer.offerId === offerId)
}

export async function getSearchOnBingQueries(bot: MicrosoftRewardsBot, promotion: BasePromotion): Promise<string[]> {
    try {
        let activities: ActivityQueries[]

        if (bot.config.searchOnBingLocalQueries) {
            bot.logger.debug(bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Using local queries config file')
            activities = JSON.parse(
                fs.readFileSync(path.join(__dirname, '../bing-search-activity-queries.json'), 'utf8')
            ) as ActivityQueries[]
        } else {
            bot.logger.debug(bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Fetching queries config from remote repository')
            activities = (
                await bot.http.request<ActivityQueries[]>({
                    method: 'GET',
                    url: URLs.github.searchOnBingQueries
                })
            ).data
        }

        const match = activities.find(
            activity => bot.utils.normalizeString(activity.title) === bot.utils.normalizeString(promotion.title)
        )
        if (match?.queries.length) {
            const shuffled = bot.utils.shuffleArray(match.queries)
            bot.logger.info(
                bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `Found ${shuffled.length} queries for "${promotion.title}" | source=${bot.config.searchOnBingLocalQueries ? 'local' : 'remote'}`
            )
            return shuffled
        }

        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-QUERY',
            `No curated queries for "${promotion.title}", trying LLM query generation`
        )

        // Try LLM query generation first (user's custom logic)
        const llmQuery = await callLLMQueryGenerator(bot, promotion)
        if (llmQuery) {
            bot.logger.info(
                bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `LLM generated query for "${promotion.title}": "${llmQuery}"`
            )
            return [llmQuery]
        }

        bot.logger.info(
            bot.isMobile,
            'SEARCH-ON-BING-QUERY',
            `LLM query generation failed, falling back to the activity title and description`
        )
        return fallbackQueries(promotion)
    } catch (error) {
        bot.logger.error(
            bot.isMobile,
            'SEARCH-ON-BING-QUERY',
            `Error resolving search queries | title="${promotion.title}" | message=${error instanceof Error ? error.message : String(error)} | fallback=titleAndDescription`
        )

        // Try LLM query generation as fallback
        const llmQuery = await callLLMQueryGenerator(bot, promotion)
        if (llmQuery) {
            bot.logger.info(
                bot.isMobile,
                'SEARCH-ON-BING-QUERY',
                `LLM generated query for "${promotion.title}": "${llmQuery}"`
            )
            return [llmQuery]
        }

        return fallbackQueries(promotion)
    }
}

function fallbackQueries(promotion: BasePromotion): string[] {
    const title = (promotion.title ?? '').trim()
    const description = (promotion.description ?? '').trim()
    const derived = extractSearchTerm(description)
    return [...new Set([derived, title, description].map(value => value.trim()).filter(Boolean))]
}

// Microsoft currently supplies English instruction prefixes for this fallback path.
function extractSearchTerm(description: string): string {
    if (!description) return ''

    return description
        .trim()
        .replace(
            /^\s*(?:search(?:\s+on\s+bing|\s+bing|\s+the\s+web)?\s+for|look\s+up|find|explore|discover)\b[\s:]+/i,
            ''
        )
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim()
}

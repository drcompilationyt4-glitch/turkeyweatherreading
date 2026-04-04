import type { Page } from 'patchright'
import { randomBytes, randomInt } from 'crypto'
import { hostname } from 'os'
import axios, { AxiosRequestConfig } from 'axios'
import type { Counters, DashboardData } from '../../../interface/DashboardData'
import type { GoogleSearch, GoogleTrendsResponse } from '../../../interface/Search'

import { QueryCore } from '../../QueryEngine'
import { Workers } from '../../Workers'

type Mode = 'balanced' | 'relaxed' | 'study' | 'food' | 'gaming' | 'news'

interface CategoryWeights {
    everydayServices: number
    anime: number
    games: number
    schoolServices: number
    csStudent: number
}

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private searchPageURL = ''
    private searchCount = 0

    // Lightweight in-memory recent-topic cache to reduce repetition across runs (LRU)
    private static recentTopicLRU: string[] = []
    private static recentTopicSet: Set<string> = new Set()
    private static RECENT_CACHE_LIMIT = 500

    // Google Trends cache with timestamp
    private static googleTrendsCache: { queries: GoogleSearch[], timestamp: number, geoLocale: string } | null = null
    private static TRENDS_CACHE_TTL = 1000 * 60 * 300 // 5 hours in milliseconds

    // Model configuration with weights
    private readonly modelConfig = [
        { name: 'nvidia/nemotron-3-super-120b-a12b:free', weight: 1 / 4, supportsReasoning: false },
        { name: 'stepfun/step-3.5-flash:free', weight: 1 / 4, supportsReasoning: false },
        { name: 'liquid/lfm-2.5-1.2b-instruct:free', weight: 1 / 4, supportsReasoning: false },
        { name: 'meta-llama/llama-3.3-70b-instruct:free', weight: 1 / 4, supportsReasoning: false },
    ]

    public async doSearch(data: DashboardData, page: Page, isMobile: boolean, maxSearches?: number): Promise<number> {
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches | currentPoints=${startBalance} | maxSearches=${maxSearches ?? 'unlimited'}`)

        let totalGainedPoints = 0
        let searchCount = 0

        try {
            let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
            const missingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
            let missingPointsTotal = missingPoints.totalPoints

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `Initial search counters | mobile=${missingPoints.mobilePoints} | desktop=${missingPoints.desktopPoints} | edge=${missingPoints.edgePoints}`
            )

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Search points remaining | Edge=${missingPoints.edgePoints} | Desktop=${missingPoints.desktopPoints} | Mobile=${missingPoints.mobilePoints}`
            )

            // Determine run settings for AI query generation
            const runSeed = this.getRunSeed()
            const runId = this.getRunId(runSeed)
            const autoSettings = this.determineRunSettings(runSeed)
            const modeCfg = ((this.bot.config.searchSettings as any)?.mode as ('auto' | Mode) | undefined) || 'auto'
            const mode = modeCfg === 'auto' ? autoSettings.mode : (modeCfg as Mode)
            const diversityLevel = typeof (this.bot.config.searchSettings as any)?.diversityBase === 'number'
                ? (this.bot.config.searchSettings as any).diversityBase
                : autoSettings.diversityLevel

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `RunID=${runId} mode=${mode} diversity=${diversityLevel.toFixed(2)} pool=${autoSettings.modesPool.join(',')}`
            )

            // Generate search queries using AI (50/50 LLM and Trends)
            const geo = (this.bot.config.searchSettings as any)?.useGeoLocaleQueries
                ? (data?.userProfile?.attributes?.country || 'US')
                : 'US'

            const pointsPerSearch = (this.bot.config.searchSettings as any)?.pointsPerSearch || 5
            const neededSearches = Math.ceil(missingPointsTotal / pointsPerSearch)
            const targetSearchCount = Math.max(25, neededSearches)

            let googleSearchQueries: GoogleSearch[] = await this.getSearchQueries(
                geo,
                targetSearchCount,
                mode,
                diversityLevel,
                runSeed,
                autoSettings.modesPool
            )

            // Fallback to QueryCore if AI generation fails
            if (!googleSearchQueries.length || googleSearchQueries.length < 1) {
                this.bot.logger.warn(isMobile, 'SEARCH-BING', 'No queries from AI — falling back to QueryCore')

                const queryCore = new QueryCore(this.bot)
                const locale = (this.bot.userData.geoLocale ?? 'US').toUpperCase()
                const langCode = (this.bot.userData.langCode ?? 'en').toLowerCase()

                const fallbackQueries = await queryCore.queryManager({
                    shuffle: true,
                    related: true,
                    langCode,
                    geoLocale: locale,
                    sourceOrder: ['google', 'wikipedia', 'reddit', 'local']
                })

                googleSearchQueries = fallbackQueries.map(q => ({ topic: q, related: [] }))
            }

            // Shuffle and dedupe topics
            googleSearchQueries = this.bot.utils.shuffleArray(googleSearchQueries)
            const seen = new Set<string>()
            googleSearchQueries = googleSearchQueries.filter(q => {
                if (!q || !q.topic) return false
                const k = q.topic.toLowerCase().replace(/[^a-z0-9]/g, '')
                if (seen.has(k)) return false
                seen.add(k)
                return true
            })

            this.bot.logger.info(isMobile, 'SEARCH-BING', `Search query pool ready | count=${googleSearchQueries.length}`)

            // Go to bing
            const targetUrl = this.searchPageURL ? this.searchPageURL : this.bingHome
            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Navigating to search page | url=${targetUrl}`)

            await page.goto(targetUrl)
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            // Build queries array (mobile doesn't like related queries)
            const queries: string[] = []
            googleSearchQueries.forEach(x => {
                if (isMobile) {
                    queries.push(x.topic)
                } else {
                    queries.push(x.topic, ...(x.related || []))
                }
            })

            let stagnantLoop = 0
            const stagnantLoopMax = 10

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i] as string

                searchCounters = await this.bingSearch(page, query, isMobile)
                const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                const newMissingPointsTotal = newMissingPoints.totalPoints

                const rawGained = missingPointsTotal - newMissingPointsTotal
                const gainedPoints = Math.max(0, rawGained)

                if (gainedPoints === 0) {
                    stagnantLoop++
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                    )
                } else {
                    stagnantLoop = 0

                    const newBalance = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                    totalGainedPoints += gainedPoints

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                        'green'
                    )
                }

                missingPointsTotal = newMissingPointsTotal
                searchCount++

                if (missingPointsTotal === 0) {
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        'All required search points earned, stopping main search loop'
                    )
                    break
                }

                // Check if we've reached maxSearches limit
                if (maxSearches && searchCount >= maxSearches) {
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `Reached maxSearches limit (${maxSearches}), stopping search batch`
                    )
                    break
                }

                if (stagnantLoop > stagnantLoopMax) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `Search did not gain points for ${stagnantLoopMax} iterations, aborting main search loop`
                    )
                    stagnantLoop = 0
                    break
                }

                // Only for mobile searches
                if (stagnantLoop > 5 && isMobile) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        "Search didn't gain point for 5 iterations, likely bad User-Agent"
                    )
                    break
                }

                const remainingQueries = queries.length - (i + 1)
                const minBuffer = 20
                if (missingPointsTotal > 0 && remainingQueries < minBuffer) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `Low query buffer while still missing points, regenerating | remainingQueries=${remainingQueries} | missing=${missingPointsTotal}`
                    )

                    const extra = await this.getSearchQueries(
                        geo,
                        minBuffer,
                        mode,
                        diversityLevel,
                        runSeed,
                        autoSettings.modesPool
                    )

                    const extraStrings = extra.map(q => q.topic)
                    const merged = [...queries, ...extraStrings].map(q => q.trim()).filter(Boolean)
                    const newPool = [...new Set(merged)]
                    const reshuffled = this.bot.utils.shuffleArray(newPool)

                    // Replace remaining queries
                    queries.splice(i + 1, queries.length - i - 1, ...reshuffled)

                    this.bot.logger.debug(isMobile, 'SEARCH-BING', `Query pool regenerated | count=${queries.length}`)
                }
            }

            // Extra searches if still missing points
            if (missingPointsTotal > 0 && !isMobile) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `Search completed but still missing points, continuing with regenerated queries | remaining=${missingPointsTotal}`
                )

                let stagnantLoop = 0
                const stagnantLoopMax = 5

                while (missingPointsTotal > 0) {
                    const extra = await this.getSearchQueries(
                        geo,
                        25,
                        mode,
                        diversityLevel,
                        runSeed,
                        autoSettings.modesPool
                    )

                    const extraStrings = extra.map(q => q.topic)
                    const merged = [...queries, ...extraStrings].map(q => q.trim()).filter(Boolean)
                    const newPool = [...new Set(merged)]
                    const reshuffled = this.bot.utils.shuffleArray(newPool)

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING-EXTRA',
                        `New search query pool generated | count=${reshuffled.length}`
                    )

                    for (const query of reshuffled) {
                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            `Extra search | remaining=${missingPointsTotal} | query="${query}"`
                        )

                        searchCounters = await this.bingSearch(page, query, isMobile)
                        const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                        const newMissingPointsTotal = newMissingPoints.totalPoints

                        const rawGained = missingPointsTotal - newMissingPointsTotal
                        const gainedPoints = Math.max(0, rawGained)

                        if (gainedPoints === 0) {
                            stagnantLoop++
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                            )
                        } else {
                            stagnantLoop = 0

                            const newBalance = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                            this.bot.userData.currentPoints = newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                            totalGainedPoints += gainedPoints

                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                                'green'
                            )
                        }

                        missingPointsTotal = newMissingPointsTotal

                        if (missingPointsTotal === 0) {
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                'All required search points earned during extra searches'
                            )
                            break
                        }

                        if (stagnantLoop > stagnantLoopMax) {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `Search did not gain points for ${stagnantLoopMax} iterations, aborting extra searches`
                            )
                            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING',
                                `Aborted extra searches | startBalance=${startBalance} | finalBalance=${finalBalance}`
                            )
                            return totalGainedPoints
                        }
                    }

                    if (missingPointsTotal === 0) break
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Completed Bing searches | startBalance=${startBalance} | newBalance=${finalBalance}`
            )

            return totalGainedPoints
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-BING',
                `Error in doSearch | message=${error instanceof Error ? error.message : String(error)}`
            )
            return totalGainedPoints
        }
    }

    private async bingSearch(searchPage: Page, query: string, isMobile: boolean) {
        const maxAttempts = 5
        const refreshThreshold = 10

        this.searchCount++

        if (this.searchCount % refreshThreshold === 0) {
            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Returning to home page to clear accumulated page context | count=${this.searchCount} | threshold=${refreshThreshold}`
            )

            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Returning home to refresh state | url=${this.bingHome}`)

            const cvid = randomBytes(16).toString('hex')
            const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

            await searchPage.goto(url)
            await searchPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(searchPage)
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Starting bingSearch | query="${query}" | maxAttempts=${maxAttempts} | searchCount=${this.searchCount} | refreshEvery=${refreshThreshold} | scrollRandomResults=${this.bot.config.searchSettings.scrollRandomResults} | clickRandomResults=${this.bot.config.searchSettings.clickRandomResults}`
        )

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const searchBar = '#sb_form_q'
                const searchBox = searchPage.locator(searchBar)

                await searchPage.evaluate(() => {
                    window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
                })

                await searchPage.keyboard.press('Home')
                await searchBox.waitFor({ state: 'visible', timeout: 15000 })

                await this.bot.utils.wait(this.bot.utils.humanFormInputDelay())
                await this.bot.browser.utils.ghostClick(searchPage, searchBar, { clickCount: 3 })
                await searchBox.fill('')

                // Human-like typing with variable delays
                for (const char of query) {
                    await searchPage.keyboard.type(char, { delay: this.bot.utils.humanTypingDelay() })
                }
                await searchPage.keyboard.press('Enter')

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Submitted query to Bing | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await this.bot.utils.wait(3000)

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(searchPage, isMobile)
                }

                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(searchPage, isMobile)
                }

                await this.bot.utils.wait(
                    this.bot.utils.randomDelay(
                        this.bot.config.searchSettings.searchDelay.min,
                        this.bot.config.searchSettings.searchDelay.max
                    )
                )

                const counters = await this.bot.browser.func.getSearchPoints()

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Search counters after query | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                return counters
            } catch (error) {
                if (i >= 5) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `Failed after 5 retries | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                    )
                    break
                }

                this.bot.logger.error(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt failed | attempt=${i + 1}/${maxAttempts} | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )

                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Retrying search | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await this.bot.utils.wait(2000)
            }
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Returning current search counters after failed retries | query="${query}"`
        )

        return await this.bot.browser.func.getSearchPoints()
    }

    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            const randomScrollPosition = randomInt(0, totalHeight - viewportHeight)

            this.bot.logger.debug(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `Random scroll | viewportHeight=${viewportHeight} | totalHeight=${totalHeight} | scrollPos=${randomScrollPosition}`
            )

            await page.evaluate((scrollPos: number) => {
                window.scrollTo({ left: 0, top: scrollPos, behavior: 'auto' })
            }, randomScrollPosition)
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `An error occurred during random scroll | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async clickRandomLink(page: Page, isMobile: boolean) {
        try {
            this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Attempting to click a random search result link')

            const searchPageUrl = page.url()

            await this.bot.browser.utils.ghostClick(page, '#b_results .b_algo h2')
            await this.bot.utils.wait(this.bot.config.searchSettings.searchResultVisitTime)

            if (isMobile) {
                await page.goto(searchPageUrl)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Navigated back to search page')
            } else {
                const newTab = await this.bot.browser.utils.getLatestTab(page)
                const newTabUrl = newTab.url()

                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', `Visited result tab | url=${newTabUrl}`)

                await this.bot.browser.utils.closeTabs(newTab)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Closed result tab')
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-CLICK',
                `An error occurred during random click | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    // ======================== AI Query Generation Methods ========================

    /**
     * Primary entrypoint to obtain queries.
     * Behavior:
     *  - 50/50 LLM / Trends mix
     *  - Google Trends caching with TTL
     *  - Per-run modesPool passed to diversification so queries can vary across interleaves
     */
    private async getSearchQueries(
        geoLocale: string = 'US',
        desiredCount = 25,
        mode: Mode = 'balanced',
        diversityLevel = 0.5,
        runSeed?: number,
        modesPool?: Mode[]
    ): Promise<GoogleSearch[]> {
        const mobile = this.bot.isMobile
        this.bot.logger.info(mobile, 'SEARCH-QUERIES', `Generating ${desiredCount} queries (50% LLM / 50% Trends)`)

        const llmCount = Math.max(0, Math.ceil(desiredCount * 0.5))
        const trendsCount = Math.max(0, desiredCount - llmCount)

        // 1) Attempt LLM batch first
        let llmQueries: GoogleSearch[] = []
        let llmShortfall = 0
        try {
            if (llmCount > 0) {
                this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `Attempting LLM batch for ${llmCount} queries`)
                llmQueries = await this.getEnhancedLLMQueries(geoLocale, llmCount, mode, runSeed)
                this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `LLM returned ${llmQueries.length} items`)
                if (llmQueries.length < llmCount) llmShortfall = llmCount - llmQueries.length
            }
        } catch (err) {
            this.bot.logger.warn(mobile, 'SEARCH-QUERIES', `LLM batch failed: ${err instanceof Error ? err.message : String(err)}`)
            llmShortfall = llmCount
        }

        // 2) Attempt Trends with caching
        let trendsQueries: GoogleSearch[] = []
        const trendsNeeded = Math.max(0, trendsCount + llmShortfall)
        if (trendsNeeded > 0) {
            try {
                this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `Fetching Google Trends (up to ${trendsNeeded})`)
                const gt = await this.getCachedGoogleTrends(geoLocale)
                if (gt.length) {
                    trendsQueries = this.bot.utils.shuffleArray(gt).slice(0, trendsNeeded)
                    this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `Google trends returned ${gt.length} items, sampled ${trendsQueries.length}`)
                } else {
                    throw new Error('No usable Google trends')
                }
            } catch (tErr) {
                this.bot.logger.warn(mobile, 'SEARCH-QUERIES', `Google Trends fetch failed: ${tErr instanceof Error ? tErr.message : String(tErr)}`)
                // Fallback to Reddit
                try {
                    this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `Falling back to Reddit Trends (up to ${trendsNeeded})`)
                    const rawTrends = await this.getRedditTrends(geoLocale)
                    if (Array.isArray(rawTrends) && rawTrends.length) {
                        trendsQueries = this.bot.utils.shuffleArray(rawTrends).slice(0, trendsNeeded)
                        this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `Reddit trends returned ${rawTrends.length} items, sampled ${trendsQueries.length}`)
                    }
                } catch (rErr) {
                    this.bot.logger.warn(mobile, 'SEARCH-QUERIES', `Reddit Trends fetch failed: ${rErr instanceof Error ? rErr.message : String(rErr)}`)
                }
            }
        }

        // 3) Combine
        const combined: GoogleSearch[] = []
        const seen = new Set<string>()
        const normalizeKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
        const pushIfUnique = (q: GoogleSearch) => {
            if (!q?.topic) return false
            const key = normalizeKey(q.topic)
            if (!key || seen.has(key)) return false
            seen.add(key)
            combined.push(q)
            return true
        }

        // Start with LLM, then Trends
        if (llmQueries && llmQueries.length > 0) {
            for (const q of llmQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(q)
            }
        }

        if (trendsQueries && trendsQueries.length > 0) {
            for (const t of trendsQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(t)
            }
        }

        // 4) Final diversify and return
        if (combined.length === 0) {
            this.bot.logger.warn(mobile, 'SEARCH-QUERIES', 'No queries from AI sources — returning empty')
            return []
        }

        const rng = this.seededRng(runSeed ?? this.getRunSeed())
        const normalized = this.diversifyQueries(combined, mode, (new Date()).getDay(), rng, diversityLevel, modesPool)

        for (const item of normalized.slice(0, desiredCount)) {
            this.addToRecentTopics(item.topic || '')
        }

        return normalized.slice(0, desiredCount)
    }

    private async getCachedGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const now = Date.now()
        const mobile = this.bot.isMobile

        if (Search.googleTrendsCache &&
            Search.googleTrendsCache.geoLocale === geoLocale &&
            (now - Search.googleTrendsCache.timestamp) < Search.TRENDS_CACHE_TTL &&
            Array.isArray(Search.googleTrendsCache.queries) &&
            Search.googleTrendsCache.queries.length > 0) {

            const cached = Search.googleTrendsCache.queries
                .map(q => ({
                    topic: this.normalizeTopicString(q.topic ?? ''),
                    related: Array.isArray(q.related) ? q.related.map(r => this.normalizeTopicString(String(r))).filter(Boolean) : []
                }))
                .filter(q => !!q.topic)

            this.bot.logger.debug(mobile, 'SEARCH-GOOGLE-TRENDS', `Using cached Google Trends with ${cached.length} queries`)

            return cached.map(q => ({ topic: q.topic, related: [...q.related] }))
        }

        this.bot.logger.debug(mobile, 'SEARCH-GOOGLE-TRENDS', 'Cache empty/expired, fetching fresh Google Trends data')
        const freshQueriesRaw = await this.getGoogleTrends(geoLocale)

        const freshQueries: GoogleSearch[] = (Array.isArray(freshQueriesRaw) ? freshQueriesRaw : []).map(q => {
            const topic = this.normalizeTopicString(q.topic ?? '')
            const related = Array.isArray(q.related) ? q.related.map(r => this.normalizeTopicString(String(r))).filter(Boolean) : []
            return { topic, related }
        }).filter(q => q.topic && q.topic.length > 0)

        Search.googleTrendsCache = {
            queries: freshQueries.map(q => ({ topic: q.topic, related: Array.isArray(q.related) ? [...q.related] : [] })),
            timestamp: now,
            geoLocale
        }

        return Search.googleTrendsCache.queries.map(q => ({ topic: q.topic, related: Array.isArray(q.related) ? [...q.related] : [] }))
    }

    private async getGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []
        const mobile = this.bot.isMobile
        this.bot.logger.debug(mobile, 'SEARCH-GOOGLE-TRENDS', `Generating search queries | GeoLocale: ${geoLocale}`)
        try {
            const request: AxiosRequestConfig = {
                url: 'https://trends.google.com/_/TrendsUi/data/batchexecute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                data: `f.req=[[[i0OFE,"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`,
                proxy: false
            }
            const response = await axios.request(request as any)
            const rawText = response.data
            const trendsData = this.extractJsonFromResponse(rawText)
            if (!trendsData) {
                this.bot.logger.error(mobile, 'SEARCH-GOOGLE-TRENDS', 'Failed to parse Google Trends response')
                return queryTerms
            }
            const mappedTrendsData = trendsData.map(query => [query[0], query[9]!.slice(1)])
            this.bot.logger.debug(mobile, 'SEARCH-GOOGLE-TRENDS', `Found ${mappedTrendsData.length} search queries for ${geoLocale}`)
            if (mappedTrendsData.length < 30 && geoLocale.toUpperCase() !== 'US') {
                this.bot.logger.warn(mobile, 'SEARCH-GOOGLE-TRENDS', `Insufficient search queries (${mappedTrendsData.length} < 30), falling back to US`)
                return this.getGoogleTrends()
            }
            for (const [topic, relatedQueries] of mappedTrendsData) {
                queryTerms.push({
                    topic: topic as string,
                    related: relatedQueries as string[]
                })
            }
        } catch (error) {
            this.bot.logger.error(mobile, 'SEARCH-GOOGLE-TRENDS', `An error occurred: ${error}`)
        }
        return queryTerms
    }

    private extractJsonFromResponse(text: string): GoogleTrendsResponse[1] | null {
        const lines = text.split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                try {
                    return JSON.parse(JSON.parse(trimmed)[0][2])[1]
                } catch {
                    continue
                }
            }
        }
        return null
    }

    private async getRedditTrends(_geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const results: GoogleSearch[] = []
        const mobile = this.bot.isMobile
        this.bot.logger.debug(mobile, 'SEARCH-TRENDS-REDDIT', 'Fetching trending topics from Reddit')

        await this.bot.utils.wait(this.bot.utils.randomDelay(500, 1500))

        const tryEndpoints = [
            'https://www.reddit.com/r/all/top.json?limit=100&t=day',
            'https://www.reddit.com/r/all/hot.json?limit=100'
        ]

        for (const url of tryEndpoints) {
            try {
                const req: AxiosRequestConfig = {
                    url,
                    method: 'GET',
                    responseType: 'json',
                    timeout: 20000,
                    proxy: false,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0; +https://example.com)'
                    }
                }
                const resp = await axios.request(req as any)
                const data = resp?.data
                const children = data?.data?.children
                if (!Array.isArray(children) || children.length === 0) {
                    this.bot.logger.debug(mobile, 'SEARCH-TRENDS-REDDIT', `No items from Reddit endpoint ${url}`)
                    continue
                }
                for (const c of children) {
                    try {
                        const d = c?.data
                        if (!d) continue
                        const rawTitle = (d.title || '').toString().trim()
                        if (!rawTitle) continue
                        const title = rawTitle.replace(/&/g, '&').replace(/"/g, '"').replace(/&#39;/g, "'").replace(/</g, '<').replace(/>/g, '>').replace(/\s+/g, ' ').trim()
                        const subreddit = d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : '')
                        const related: string[] = []
                        if (subreddit) related.push(subreddit)
                        related.push(`${title} discussion`)
                        related.push(`${title} review`)
                        if (title.length < 120) {
                            related.push(`${title} explained`)
                        }
                        const uniqRelated = Array.from(new Set(related.map(r => (r || '').trim()).filter(Boolean))).slice(0, 4)
                        results.push({ topic: title, related: uniqRelated })
                    } catch {
                        continue
                    }
                }
                if (results.length) {
                    this.bot.logger.debug(mobile, 'SEARCH-TRENDS-REDDIT', `Reddit trends fetched ${results.length} items from ${url}`)
                    return results
                }
            } catch (err) {
                this.bot.logger.debug(mobile, 'SEARCH-TRENDS-REDDIT', `Reddit endpoint ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
            }
        }
        return []
    }

    private async getEnhancedLLMQueries(geoLocale: string, count: number, mode: Mode, runSeed?: number): Promise<GoogleSearch[]> {
        const { mode: ctxMode, contextNotes } = this.determineRunSettings(runSeed)
        const finalMode = mode || ctxMode
        const mobile = this.bot.isMobile
        this.bot.logger.debug(mobile, 'SEARCH-QUERIES', `Generating ${count} LLM queries in ${finalMode} mode: ${contextNotes}`)
        try {
            return await this.generateQueriesWithLLMBatch(geoLocale, count, finalMode, contextNotes, runSeed)
        } catch (err) {
            this.bot.logger.warn(mobile, 'SEARCH-QUERIES', `Enhanced LLM generation failed: ${err instanceof Error ? err.message : String(err)}`)
            return []
        }
    }

    private async generateQueriesWithLLMBatch(
        geoLocale: string,
        desiredCount = 25,
        mode: Mode = 'balanced',
        contextNotes: string = '',
        runSeed?: number
    ): Promise<GoogleSearch[]> {
        const mobile = this.bot.isMobile
        const envKey1 = (process.env.OPENROUTER_API_KEY || (this.bot.config as any)?.openRouterApiKey || '').toString().trim()
        const envKey2 = (process.env.OPENROUTER_API_KEY_2 || (this.bot.config as any)?.openRouterApiKey2 || '').toString().trim()
        const openaiKey = (process.env.OPENAI_API_KEY || (this.bot.config as any)?.openaiApiKey || '').toString().trim()

        const keys: string[] = []
        if (openaiKey) keys.push(openaiKey)
        if (envKey1) keys.push(envKey1)
        if (envKey2) keys.push(envKey2)

        if (!keys.length) {
            this.bot.logger.error(mobile, 'SEARCH-LLM', 'OpenRouter/OpenAI API key(s) missing')
            throw new Error('OpenRouter/OpenAI API key not configured')
        }

        const selectedModel = this.selectRandomModel()
        const fallbackModel = 'meta-llama/llama-3.3-70b-instruct:free'
        const categoryWeights = this.getTimeBasedCategoryWeights()
        const { systemPrompt, userPrompt } = this.generateCategoryPrompt(categoryWeights, geoLocale)

        const baseMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt.replace('${desiredCount}', desiredCount.toString()) }
        ]

        const maxTokens = Math.min(1600, 90 * desiredCount)

        const buildRequestBody = (model: string, supportsReasoning: boolean, extraMessages: any[] = []) => {
            const body: any = {
                model,
                messages: [...baseMessages, ...extraMessages],
                max_tokens: maxTokens,
                temperature: 0.6,
                stream: false
            }

            const cfgEnable = typeof (this.bot.config as any)?.openRouterReasoningEnabled === 'boolean'
                ? (this.bot.config as any).openRouterReasoningEnabled
                : true
            if (supportsReasoning && cfgEnable) {
                body.reasoning = { enabled: true }
                if (typeof (this.bot.config as any)?.openRouterReasoningEffort === 'string') body.reasoning.effort = (this.bot.config as any).openRouterReasoningEffort
                if (typeof (this.bot.config as any)?.openRouterReasoningMaxTokens === 'number') body.reasoning.max_tokens = (this.bot.config as any).openRouterReasoningMaxTokens
                if (typeof (this.bot.config as any)?.openRouterReasoningExclude === 'boolean') body.reasoning.exclude = !!(this.bot.config as any).openRouterReasoningExclude
            }

            if (this.bot.config && typeof (this.bot.config as any)?.openRouterProvider !== 'undefined') body.provider = (this.bot.config as any).openRouterProvider
            if ((this.bot.config as any)?.openRouterRequireResponseFormat) body.response_format = { type: 'json_object' }
            if (typeof (this.bot.config as any)?.openRouterUserId === 'string') body.user = (this.bot.config as any).openRouterUserId

            return body
        }

        const createAxiosClient = (apiKey: string, baseURL = 'https://openrouter.ai/api/v1') => axios.create({
            baseURL,
            headers: {
                'Content-Type': 'application/json',
                'HTTP-Referer': '<YOUR_SITE_URL>',
                'X-Title':'<YOUR_SITE_NAME>',
                'Authorization': `Bearer ${apiKey}`
            },
            proxy: false,
        })

        const extractContentFromChoice = (choice: any, rawData: any): string | null => {
            try {
                const msg = choice?.message ?? {}
                if (typeof msg.content === 'string' && msg.content.trim().length) return msg.content.trim()
                if (msg.content && typeof msg.content === 'object') {
                    const parts = msg.content.parts || msg.content.text || msg.content
                    if (Array.isArray(parts)) {
                        const combined = parts.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ').trim()
                        if (combined) return combined
                    } else if (typeof parts === 'string') {
                        return parts.trim()
                    }
                }
                const reasoningObj = msg.reasoning_details ?? msg.reasoning ?? choice?.reasoning_details ?? rawData?.reasoning_details ?? rawData?.reasoning
                if (reasoningObj) {
                    if (typeof reasoningObj.final_answer === 'string' && reasoningObj.final_answer.trim()) return reasoningObj.final_answer.trim()
                    if (typeof reasoningObj.chain_of_thought === 'string' && reasoningObj.chain_of_thought.trim()) return reasoningObj.chain_of_thought.trim()
                    const asStr = JSON.stringify(reasoningObj)
                    if (asStr && asStr.length) return asStr
                }
                if (typeof choice?.text === 'string' && choice.text.trim().length) return choice.text.trim()
                if (typeof rawData?.result?.content === 'string' && rawData.result.content.trim().length) return rawData.result.content.trim()
                if (typeof rawData?.content === 'string' && rawData.content.trim().length) return rawData.content.trim()
                if (typeof rawData === 'string' && rawData.trim().length) return rawData.trim()
                if (Array.isArray(rawData?.choices) && rawData.choices.length) {
                    const first = rawData.choices[0]
                    const candidate = first?.message?.content ?? first?.text ?? first?.content
                    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
                }
            } catch { /* ignore */ }
            return null
        }

        const sendOnce = async (apiKey: string, model: string, supportsReasoning: boolean): Promise<string> => {
            const baseURL = 'https://openrouter.ai/api/v1'
            const axiosClient = createAxiosClient(apiKey, baseURL)

            const defaultTimeout = supportsReasoning ? ( 240000) : 90000

            const doAxiosPost = async (payload: any, timeoutMs?: number) => {
                payload.stream = false
                const cfg: AxiosRequestConfig = {
                    url: '/chat/completions',
                    method: 'POST',
                    data: payload,
                    timeout: timeoutMs ?? defaultTimeout,
                    proxy: false
                }
                return axiosClient.request(cfg as any)
            }

            const extractFromResp = (resp: any) => {
                const data = resp?.data ?? resp
                const choice = Array.isArray(data?.choices) && data.choices.length ? data.choices[0] : null
                return extractContentFromChoice(choice, data)
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    if (supportsReasoning) {
                        const payload1: any = buildRequestBody(model, true, [])
                        if (!payload1.reasoning) payload1.reasoning = { enabled: true }

                        const resp1 = await doAxiosPost(payload1)
                        const choice1 = (resp1?.data ?? resp1)?.choices?.[0] ?? null
                        const assistantMsg = choice1?.message ?? null
                        const assistantContent = extractFromResp(resp1)

                        if (!assistantMsg || !assistantContent) {
                            this.bot.logger.warn(mobile, 'SEARCH-LLM', `First reasoning call returned empty (attempt ${attempt + 1})`)
                            if (attempt === 0) {
                                await new Promise(r => setTimeout(r, 800))
                                continue
                            }
                            throw new Error('Empty result from first reasoning call')
                        }

                        const preservedAssistant: any = {
                            role: 'assistant',
                            content: typeof assistantMsg.content === 'string' ? assistantMsg.content : (assistantContent || assistantMsg.content || '')
                        }
                        if (assistantMsg.reasoning_details) preservedAssistant.reasoning_details = assistantMsg.reasoning_details
                        if (assistantMsg.reasoning) preservedAssistant.reasoning = assistantMsg.reasoning
                        if (choice1?.reasoning_details) preservedAssistant.reasoning_details = preservedAssistant.reasoning_details ?? choice1.reasoning_details

                        const followupUser = {
                            role: 'user',
                            content: `Are you sure? Think carefully and provide the concise final queries (exactly ${desiredCount} items). ${contextNotes || ''}`
                        }

                        const payload2: any = {
                            model,
                            messages: [...baseMessages, preservedAssistant, followupUser],
                            max_tokens: Math.min(1024, maxTokens),
                            temperature: 0.45,
                            stream: false
                        }
                        payload2.response_format = { type: 'json_object' }
                        payload2.reasoning = { enabled: true }

                        const resp2 = await doAxiosPost(payload2)
                        const finalContent = extractFromResp(resp2)
                        if (finalContent && String(finalContent).trim().length) {
                            return String(finalContent)
                        } else {
                            this.bot.logger.warn(mobile, 'SEARCH-LLM', `Second reasoning continuation returned empty (attempt ${attempt + 1})`)
                            if (attempt === 0) {
                                await new Promise(r => setTimeout(r, 800))
                                continue
                            }
                            throw new Error('Empty result from reasoning continuation call')
                        }
                    } else {
                        const payload = buildRequestBody(model, false)
                        payload.stream = false

                        const resp = await doAxiosPost(payload)
                        const content = extractFromResp(resp)
                        if (content && String(content).trim().length) return String(content)

                        this.bot.logger.warn(mobile, 'SEARCH-LLM', `Non-reasoning model returned empty content (attempt ${attempt + 1})`)
                        if (attempt === 0) {
                            await new Promise(r => setTimeout(r, 500))
                            continue
                        }
                        throw new Error('No content from non-reasoning model')
                    }
                } catch (err: any) {
                    const status = err?.response?.status
                    if (status === 429) {
                        this.bot.logger.warn(mobile, 'SEARCH-LLM', `HTTP 429 (rate limit)`)
                        await new Promise(r => setTimeout(r, 800 + randomInt(0, 400)))
                        throw new Error(`HTTP 429`)
                    }
                    if (err?.response) {
                        const data = err.response.data
                        this.bot.logger.error(mobile, 'SEARCH-LLM', `HTTP ${status} error: ${JSON.stringify(data)}`)
                        throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`)
                    } else if (err.code === 'ECONNABORTED') {
                        this.bot.logger.warn(mobile, 'SEARCH-LLM', 'Request timeout')
                        throw new Error('Request timeout')
                    } else {
                        if (this.isRetryableError(err) && attempt === 0) {
                            await new Promise(r => setTimeout(r, 500))
                            continue
                        }
                        this.bot.logger.warn(mobile, 'SEARCH-LLM', `Request failed: ${String(err?.message ?? err)}`)
                        throw new Error(`Request failed: ${err?.message || String(err)}`)
                    }
                }
            }

            throw new Error('LLM request failed after retries')
        }

        const tryNormalizeWithFallbacks = (rawContent: string): GoogleSearch[] => {
            let content = String(rawContent ?? '').trim()
            try {
                const qIdx = content.indexOf('Query:')
                if (qIdx >= 0) {
                    const after = content.slice(qIdx + 'Query:'.length).trim()
                    if (/^[\[{]/.test(after)) content = after
                }
                content = content.replace(/^\s*\d+\s+Points\s+Remaining\s*\|/i, '').trim()
            } catch { /* ignore */ }

            try {
                const normalized = this.parseAndNormalizeLLMResponse(content)
                if (Array.isArray(normalized) && normalized.length > 0) return normalized
            } catch (e) {
                this.bot.logger.warn(mobile, 'SEARCH-LLM', `parseAndNormalizeLLMResponse failed: ${String(e)}`)
            }

            try {
                const s = String(content).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
                const normalized = this.parseAndNormalizeLLMResponse(s)
                if (Array.isArray(normalized) && normalized.length > 0) {
                    this.bot.logger.debug(mobile, 'SEARCH-LLM', 'Fallback: parsed after stripping fences')
                    return normalized
                }
            } catch { /* fallthrough */ }

            try {
                const m = String(content).match(/\[[\s\S]*\]/)
                if (m && m[0]) {
                    try {
                        const parsed = JSON.parse(m[0])
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            const normalized = this.parseAndNormalizeLLMResponse(JSON.stringify(parsed))
                            if (Array.isArray(normalized) && normalized.length > 0) return normalized
                        }
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }

            const lines = String(content).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
            if (lines.length > 0) {
                const candidates = lines.slice(0, desiredCount).map(l => {
                    const cleaned = l.replace(/^[\-\*\d\.\)\s]+/, '').replace(/^"|"$/g, '').trim()
                    return { topic: cleaned, related: [] as string[] }
                })
                if (candidates.length > 0) {
                    this.bot.logger.debug(mobile, 'SEARCH-LLM', 'Fallback: used newline-split to derive queries')
                    return candidates as GoogleSearch[]
                }
            }

            if (desiredCount === 1) {
                const plain = String(content).trim().replace(/["`]/g, '')
                const firstLine = plain.split(/\r?\n/).find(Boolean) ?? plain
                if (firstLine && firstLine.length > 0) {
                    const words = firstLine.trim().split(/\s+/).slice(0, 4).join(' ')
                    this.bot.logger.debug(mobile, 'SEARCH-LLM', 'Fallback: single-item plain text accepted')
                    return [{ topic: words, related: [] }]
                }
            }

            throw new Error('LLM returned empty or invalid queries after normalization')
        }

        let lastErr: any = null

        // Phase 1: try selected model
        for (const key of keys) {
            try {
                this.bot.logger.debug(mobile, 'SEARCH-LLM', `Trying selected model ${selectedModel.name}`)
                const content = await sendOnce(key, selectedModel.name, selectedModel.supportsReasoning)
                const normalized = tryNormalizeWithFallbacks(content)
                if (normalized.length > 0) return normalized
            } catch (err) {
                lastErr = err
                this.bot.logger.debug(mobile, 'SEARCH-LLM', `Selected model attempt failed: ${err instanceof Error ? err.message : String(err)}`)
            }
        }

        // Phase 2: try other models
        const otherModels = this.modelConfig.filter((m: any) => m.name !== selectedModel.name)
        for (const model of otherModels) {
            for (const key of keys) {
                try {
                    this.bot.logger.debug(mobile, 'SEARCH-LLM', `Trying alternative model ${model.name}`)
                    const content = await sendOnce(key, model.name, model.supportsReasoning)
                    const normalized = tryNormalizeWithFallbacks(content)
                    if (normalized.length > 0) return normalized
                } catch (err) {
                    lastErr = err
                    this.bot.logger.debug(mobile, 'SEARCH-LLM', `Alternative model ${model.name} failed: ${err instanceof Error ? err.message : String(err)}`)
                }
            }
        }

        // Phase 3: fallback model
        for (const key of keys) {
            try {
                this.bot.logger.debug(mobile, 'SEARCH-LLM', `Trying fallback model ${fallbackModel}`)
                const content = await sendOnce(key, fallbackModel, false)
                const normalized = tryNormalizeWithFallbacks(content)
                if (normalized.length > 0) return normalized
            } catch (err) {
                lastErr = err
                this.bot.logger.debug(mobile, 'SEARCH-LLM', `Fallback model failed: ${err instanceof Error ? err.message : String(err)}`)
            }
        }

        this.bot.logger.error(mobile, 'SEARCH-LLM', 'All LLM attempts failed')
        throw lastErr || new Error('LLM failed - all models exhausted')
    }

    private parseAndNormalizeLLMResponse(content: string): GoogleSearch[] {
        const safeParseJson = (s: string): any | null => {
            try { return JSON.parse(s); } catch { return null; }
        };

        const normalizeString = (s: string) =>
            String(s || '')
                .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
                .replace(/\t+/g, ' ')
                .replace(/\r/g, '\n')
                .trim();

        const stripFences = (s: string) =>
            normalizeString(s)
                .replace(/```(?:json)?/gi, '')
                .replace(/```/g, '')
                .trim();

        const raw = String(content ?? '').trim();
        const stripped = stripFences(raw).replace(/\s+$/g, '');

        const tryExtractJson = (text: string): any | null => {
            const direct = safeParseJson(text);
            if (direct !== null) return direct;

            const jsonBlockRegex = /(\{[\s\S]*?\}|\[[\s\S]*?\])/g;
            const matches = Array.from(text.matchAll(jsonBlockRegex)).map(m => m[0]);
            matches.sort((a, b) => b.length - a.length);
            for (const m of matches) {
                const parsed = safeParseJson(m);
                if (parsed !== null) return parsed;
                const trimmed = m.replace(/,\s*([\]\}])/g, '$1');
                const parsed2 = safeParseJson(trimmed);
                if (parsed2 !== null) return parsed2;
            }

            const firstJsonStart = text.search(/[\{\[]/);
            if (firstJsonStart >= 0) {
                const candidate = text.slice(firstJsonStart);
                const parsed = safeParseJson(candidate);
                if (parsed !== null) return parsed;
            }

            return null;
        };

        const parsed = tryExtractJson(stripped);
        if (parsed !== null) {
            if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
                const arr =
                    parsed.queries ||
                    parsed.items ||
                    parsed.results ||
                    parsed.topics ||
                    parsed.default ||
                    parsed.Query ||
                    parsed.data ||
                    parsed.output;

                if (Array.isArray(arr)) {
                    const normalized = arr
                        .map((it: any) => {
                            if (typeof it === 'string') return { topic: it.trim(), related: [] };
                            if (it && typeof it === 'object') {
                                const topic = String(it.topic || it.query || it.title || it.text || (Object.keys(it)[0] ?? '')).trim();
                                const related = Array.isArray(it.related) ? it.related.map(String) : [];
                                return { topic, related };
                            }
                            return null;
                        })
                        .filter(Boolean) as GoogleSearch[];
                    if (normalized.length) return normalized;
                }

                const keys = Object.keys(parsed).filter(k => typeof parsed[k] === 'string' || typeof parsed[k] === 'object');
                if (keys.length) {
                    return keys.map(k => ({ topic: k.trim(), related: [] }));
                }
            }

            if (Array.isArray(parsed)) {
                const normalized = parsed
                    .map((it: any) => {
                        if (typeof it === 'string') return { topic: it.trim(), related: [] };
                        if (it && typeof it === 'object') {
                            const topic = String(it.topic || it.query || it.title || it.text || (Object.keys(it)[0] ?? '')).trim();
                            const related = Array.isArray(it.related) ? it.related.map(String) : [];
                            return { topic, related };
                        }
                        return null;
                    })
                    .filter(Boolean) as GoogleSearch[];
                if (normalized.length) return normalized;
            }
        }

        // Not JSON — split
        const removeEmptyQuoteTokens = (s: string) =>
            s.replace(/(^|[\s,])""(?=$|[\s,])/g, '').replace(/\b""\b/g, '');

        const cleaned = removeEmptyQuoteTokens(stripped);

        const splitRespectingQuotes = (s: string): string[] => {
            const parts: string[] = [];
            let cur = '';
            let inQuote = false;
            let quoteChar: string | null = null;
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (!inQuote && (ch === '"' || ch === "'")) {
                    inQuote = true;
                    quoteChar = ch;
                    cur += ch;
                    continue;
                } else if (inQuote && ch === quoteChar) {
                    let backslashes = 0;
                    let j = i - 1;
                    while (j >= 0 && s[j] === '\\') { backslashes++; j--; }
                    if (backslashes % 2 === 0) {
                        inQuote = false;
                        quoteChar = null;
                    }
                    cur += ch;
                    continue;
                }

                if (!inQuote && (ch === '\n' || ch === '\r')) {
                    if (cur.trim()) parts.push(cur);
                    cur = '';
                    while (i + 1 < s.length && (s[i + 1] === '\n' || s[i + 1] === '\r')) i++;
                    continue;
                }

                if (!inQuote && (ch === ',' || ch === ';')) {
                    const rest = s.slice(i + 1);
                    const nextNonSpace = rest.match(/\S/);
                    if (!nextNonSpace) {
                        if (cur.trim()) parts.push(cur);
                        cur = '';
                        continue;
                    } else {
                        const idx = i + 1 + rest.search(/\S/);
                        const nc = (s[idx] ?? '');
                        if (nc === '"' || nc === "'" || /[A-Za-z0-9]/.test(nc)) {
                            if (cur.trim()) parts.push(cur);
                            cur = '';
                            continue;
                        } else {
                            cur += ch;
                            continue;
                        }
                    }
                }

                cur += ch;
            }
            if (cur.trim()) parts.push(cur);
            return parts;
        };

        let candidateParts = splitRespectingQuotes(cleaned);

        if (candidateParts.length === 1 && (cleaned.match(/,/g) || []).length > 2) {
            candidateParts = splitRespectingQuotes(cleaned.replace(/\r/g, '\n'));
        }

        const parts = candidateParts
            .map(p => String(p || '').trim())
            .filter(Boolean)
            .map(p => {
                p = p.replace(/^[\-\*\•\u2022\s]*\d+[\.\)\-\:]\s*/, '');
                p = p.replace(/^[\-\*\•\u2022\)\(\s]+/, '');

                const colonMatch = p.match(/^\s*(?:topic|query|title|item|suggestion|suggest|question|prompt)\s*[:\-]\s*(.+)$/i);
                if (colonMatch && colonMatch[1]) {
                    p = colonMatch[1].trim();
                } else {
                    const colonGeneric = p.match(/^\s*([^:]{1,40})\s*:\s*(.+)$/);
                    if (colonGeneric && colonGeneric[1] !== undefined && colonGeneric[2] !== undefined) {
                        const left = colonGeneric[1];
                        if (!/\s{2,}/.test(left) && left.length < 30) {
                            p = colonGeneric[2].trim();
                        }
                    }
                }

                if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
                    p = p.slice(1, -1).trim();
                }

                p = p.replace(/\b""\b/g, '').trim();
                p = p.replace(/\s{2,}/g, ' ').trim();
                return p;
            })
            .filter(Boolean);

        if (parts.length === 0) {
            throw new Error('LLM returned empty or unparsable content');
        }

        const results: GoogleSearch[] = parts.map(p => ({ topic: p, related: [] }));
        return results;
    }

    // ======================== Helper Methods ========================

    private normalizeTopicString(raw: string): string {
        if (!raw || typeof raw !== 'string') return ''
        let s = raw.trim()

        s = s.replace(/^\s*\d+\s+Points\s+Remaining\s*\|\s*/i, '')
        const qIdx = s.indexOf('Query:')
        if (qIdx >= 0) s = s.slice(qIdx + 'Query:'.length).trim()

        s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').replace(/`/g, '').trim()
        s = s.replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
        s = s.replace(/\[[^\]]*\]/g, '')
        s = s.replace(/"type"\s*:\s*"reasoning\.text"[^,}]*/gi, '')

        s = s.replace(/\s+/g, ' ')
        s = s.replace(/^[^\w]+|[^\w]+$/g, '')

        if (!s || /^\d+$/.test(s)) return ''

        return s.trim()
    }

    private diversifyQueries(input: GoogleSearch[], mode: Mode, weekday: number, rng: () => number, diversityLevel = 0.5, modesPool?: Mode[]): GoogleSearch[] {
        const out: GoogleSearch[] = []
        const foodExamples = ["McDonald's near me", 'Uber Eats deals', 'cheap pizza near me', 'student meal deals near me', 'Tim Hortons coupons', 'KFC coupons']
        const entertainmentSuffix = ['YouTube', 'best gameplay', 'review', 'trailer', 'stream']
        const studySuffix = ['lecture notes', 'past exam', 'Stack Overflow', 'tutorial', 'cheatsheet']
        const replaceProbBase = 0.6 * diversityLevel
        const brandAddProbBase = 0.4 * diversityLevel
        const modeTweakProbBase = 0.45 * diversityLevel
        const weekendBiasBase = 0.35 * diversityLevel
        const relatedAddProbBase = 0.25 * diversityLevel

        for (let idx = 0; idx < input.length; idx++) {
            const item = input[idx]
            if (!item) continue
            let topic = (item.topic || '').trim()
            if (!topic) continue

            const itemMode: Mode = (modesPool && modesPool.length) ? (modesPool[Math.floor(rng() * modesPool.length)] as Mode) : mode

            const baseKey = topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (Search.recentTopicSet.has(baseKey) && rng() < 0.8) {
                let attempts = 0
                let tweaked = topic
                while (attempts < 4 && Search.recentTopicSet.has(tweaked.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
                    attempts++
                    if (/cheap food/i.test(tweaked) || /cheap meal/i.test(tweaked) || /cheap eats/i.test(tweaked)) {
                        const choice = foodExamples[Math.floor(rng() * foodExamples.length)]!
                        tweaked = choice
                    } else if ((/food near me/i.test(tweaked) || /restaurants near me/i.test(tweaked)) && rng() < brandAddProbBase) {
                        const brands = ['McDonald\'s', 'Subway', 'Pizza Hut', 'Tim Hortons']
                        const brandChoice = brands[Math.floor(rng() * brands.length)]!
                        tweaked = `${tweaked} ${brandChoice}`
                    } else {
                        if (itemMode === 'relaxed' && rng() < modeTweakProbBase) {
                            const suffix = entertainmentSuffix[Math.floor(rng() * entertainmentSuffix.length)]
                            tweaked = `${tweaked} ${suffix}`
                        } else if (itemMode === 'study' && rng() < (modeTweakProbBase + 0.1)) {
                            const suffix = studySuffix[Math.floor(rng() * studySuffix.length)]
                            tweaked = `${tweaked} ${suffix}`
                        } else {
                            tweaked = `${tweaked} review`
                        }
                    }
                }
                topic = tweaked.replace(/\s+/g, ' ').trim()
            }

            if (/^cheap food near me$/i.test(topic) || /cheap food/i.test(topic) || /cheap meal/i.test(topic) || /cheap eats/i.test(topic)) {
                if (rng() < replaceProbBase) {
                    const idxChoice = Math.floor(rng() * foodExamples.length)
                    topic = foodExamples[idxChoice % foodExamples.length]!
                } else {
                    topic = 'cheap food near me'
                }
            }

            if (itemMode === 'relaxed' && rng() < modeTweakProbBase) {
                const suffixIdx = Math.floor(rng() * entertainmentSuffix.length) % entertainmentSuffix.length
                topic = `${topic} ${entertainmentSuffix[suffixIdx]!}`
            } else if (itemMode === 'study' && rng() < (modeTweakProbBase + 0.1)) {
                const suffixIdx = Math.floor(rng() * studySuffix.length) % studySuffix.length
                topic = `${topic} ${studySuffix[suffixIdx]!}`
            } else if (itemMode === 'gaming' && rng() < (modeTweakProbBase + 0.15)) {
                topic = `${topic} gameplay`
            } else if (itemMode === 'food' && rng() < (modeTweakProbBase + 0.15)) {
                topic = `${topic} near campus`
            }

            if ((weekday === 0 || weekday === 6) && rng() < weekendBiasBase) {
                const suffixIdx = Math.floor(rng() * entertainmentSuffix.length) % entertainmentSuffix.length
                topic = `${topic} ${entertainmentSuffix[suffixIdx]!}`
            }

            topic = topic.replace(/\s+/g, ' ').trim()

            const related = (item.related || [])
                .slice(0, 4)
                .filter(r => typeof r === 'string')
                .map(r => r.trim())
                .filter(Boolean) as string[]

            if (related.length < 2 && rng() < relatedAddProbBase) {
                related.push(topic + ' review')
            }

            const finalKey = topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (!Search.recentTopicSet.has(finalKey) && !out.some(o => (o.topic || '').toLowerCase().replace(/[^a-z0-9]/g, '') === finalKey)) {
                out.push({ topic, related })
                Search.recentTopicSet.add(finalKey)
                Search.recentTopicLRU.push(finalKey)
                while (Search.recentTopicLRU.length > Search.RECENT_CACHE_LIMIT) {
                    const rm = Search.recentTopicLRU.shift()
                    if (rm) Search.recentTopicSet.delete(rm)
                }
            } else {
                if (out.length < 2) out.push({ topic, related })
            }
        }

        const shuffled = this.shuffleWithRng(out, rng)
        const seen = new Set<string>()
        return shuffled.filter(q => {
            const k = q.topic.toLowerCase()
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })
    }

    private shuffleWithRng<T>(arr: T[], rng: () => number) {
        const a = arr.slice()
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1))
            const tmp = a[i] as T
            a[i] = a[j] as T
            a[j] = tmp
        }
        return a
    }

    private addToRecentTopics(topic: string) {
        try {
            const key = (topic || '').toLowerCase().replace(/[^a-z0-9]/g, '')
            if (!key) return
            if (Search.recentTopicSet.has(key)) {
                const idx = Search.recentTopicLRU.indexOf(key)
                if (idx >= 0) {
                    Search.recentTopicLRU.splice(idx, 1)
                }
            }
            Search.recentTopicLRU.push(key)
            Search.recentTopicSet.add(key)
            while (Search.recentTopicLRU.length > Search.RECENT_CACHE_LIMIT) {
                const rm = Search.recentTopicLRU.shift()
                if (rm) Search.recentTopicSet.delete(rm)
            }
        } catch {
            // swallow
        }
    }

    private getRunSeed(): number {
        const envId = process.env.GITHUB_RUN_ID || process.env.CI_RUN_ID || process.env.RUN_ID || process.env.GITHUB_RUN_NUMBER
        const host = envId || hostname() || 'unknown-host'
        const today = new Date().toISOString().slice(0, 10)
        const seedStr = `${host}|${today}`
        return this.cyrb53(seedStr)
    }

    private getRunId(seed?: number): string {
        const s = (typeof seed === 'number') ? seed : this.getRunSeed()
        return (s >>> 0).toString(36).slice(-6)
    }

    private cyrb53(str: string, seed = 0) {
        let h1 = 0xDEADBEEF ^ seed, h2 = 0x41C6CE57 ^ seed
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i)
            h1 = Math.imul(h1 ^ ch, 2654435761)
            h2 = Math.imul(h2 ^ ch, 1597334677)
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
        return 4294967296 * (2097151 & h2) + (h1 >>> 0)
    }

    private seededRng(seed: number) {
        let _seed = seed >>> 0
        return () => {
            _seed = (_seed * 1664525 + 1013904223) % 0x100000000
            return (_seed >>> 0) / 0x100000000
        }
    }

    private determineRunSettings(seed?: number): { mode: Mode, diversityLevel: number, contextNotes: string, modesPool: Mode[] } {
        const weekday = (new Date()).getDay()
        const rng = this.seededRng(seed ?? this.getRunSeed())
        let mode: Mode = 'balanced'
        if (weekday === 0 || weekday === 6) {
            mode = rng() < 0.7 ? 'relaxed' : 'food'
        } else {
            mode = rng() < 0.4 ? 'study' : 'balanced'
        }
        const configBoost = 0
        const diversityLevel = Math.max(0.1, Math.min(0.95, (rng() * 0.6) + 0.2 + (configBoost * 0.1)))
        const allModes: Mode[] = ['balanced', 'relaxed', 'study', 'food', 'gaming', 'news']
        const modesPool: Mode[] = []
        modesPool.push(mode)
        if (rng() < 0.6) {
            const idx = Math.floor(rng() * allModes.length)
            let choice: Mode = allModes[idx] ?? mode
            if (choice === mode) {
                const altIdx = (idx + 1) % allModes.length
                choice = allModes[altIdx] ?? mode
            }
            modesPool.push(choice)
        }
        if (rng() < 0.25) {
            const idx = Math.floor(rng() * allModes.length)
            let choice: Mode = allModes[idx] ?? mode
            if (modesPool.includes(choice)) {
                const alt = allModes.find(m => !modesPool.includes(m))
                choice = (alt || mode)
            }
            modesPool.push(choice)
        }
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        const topQueries = (weekday === 0 || weekday === 6) ? ['YouTube', 'Netflix', 'games', 'food delivery', 'weekend plans'] : ['how to', 'best way to', 'tutorial', 'assignment help', 'campus resources']
        const contextNotes = `Auto mode: ${mode}. Day: ${dayNames[weekday]}. Example top query: ${topQueries[Math.floor(rng() * topQueries.length)]}`
        return { mode, diversityLevel, contextNotes, modesPool }
    }

    private selectRandomModel(): { name: string, supportsReasoning: boolean } {
        const random = randomInt(0, 1000000) / 1000000
        let cumulativeWeight = 0
        for (const model of this.modelConfig) {
            cumulativeWeight += model.weight
            if (random <= cumulativeWeight) {
                return { name: model.name, supportsReasoning: model.supportsReasoning }
            }
        }
        return this.modelConfig[0]!
    }

    private getTimeBasedCategoryWeights(): CategoryWeights {
        const now = new Date()
        const hour = now.getHours()
        const dayOfWeek = now.getDay()
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
        const isAfterSchool = hour >= 15 && hour < 22
        const isWeekday = !isWeekend
        const isSchoolHours = isWeekday && hour >= 9 && hour < 17

        let weights: CategoryWeights = {
            everydayServices: 0.40,
            anime: 0.10,
            games: 0.10,
            schoolServices: 0.20,
            csStudent: 0.20
        }

        if (isWeekend) {
            weights.anime += 0.15
            weights.games += 0.15
            weights.schoolServices -= 0.10
            weights.csStudent -= 0.10
            weights.everydayServices -= 0.10
        } else if (isAfterSchool) {
            weights.anime += 0.10
            weights.games += 0.10
            weights.schoolServices -= 0.05
            weights.csStudent -= 0.05
            weights.everydayServices -= 0.10
        }

        if (isSchoolHours) {
            weights.schoolServices += 0.15
            weights.csStudent += 0.15
            weights.anime -= 0.10
            weights.games -= 0.10
            weights.everydayServices -= 0.10
        }

        if (hour >= 19 && hour < 23) {
            weights.csStudent += 0.10
            weights.schoolServices += 0.05
            weights.anime -= 0.05
            weights.games -= 0.05
            weights.everydayServices -= 0.05
        }

        const total = Object.values(weights).reduce((sum, w) => sum + w, 0)
        for (const key in weights) {
            weights[key as keyof CategoryWeights] /= total
        }
        return weights
    }

    private generateCategoryPrompt(weights: CategoryWeights, geoLocale: string): { systemPrompt: string, userPrompt: string } {
        const categories = [
            {
                name: 'everydayServices',
                systemPrompt: `You are a digital assistant that generates realistic, short web search queries for a University of Toronto undergraduate student living in ${geoLocale.toUpperCase()}. Focus on essential daily services and platforms that students use regularly for navigation, communication, entertainment, and shopping. Generate concise, search-style queries that reflect real-world usage patterns. Output ONLY JSON without any explanation.`,
                userPrompt: `Generate a JSON array of objects with "topic" (1-3 word search queries for daily services) and "related" (0-6 related searches). Examples: "google maps directions", "youtube music", "gmail login", "reddit programming", "weather forecast", "amazon prime", "netflix new releases", "spotify playlist", "instagram login", "facebook marketplace", "twitter trending", "whatsapp web", "zoom download", "food delivery near me". Avoid political or adult content. Keep searches concise and realistic.`,
                weight: weights.everydayServices
            },
            {
                name: 'anime',
                systemPrompt: `You are a digital assistant that generates realistic, short web search queries for an anime enthusiast who is a University of Toronto undergraduate student. Focus on popular anime series, streaming platforms, discussion forums, and anime-related content. Generate concise, search-style queries that reflect genuine anime fan behavior. Output ONLY JSON without any explanation.`,
                userPrompt: `Generate a JSON array of objects with "topic" (1-4 word search queries for anime content) and "related" (0-6 related searches). Examples: "attack on titan final season", "one piece episode", "demon slayer season 4", "jujutsu kaisen manga", "gogoanime streaming", "9anime new episodes", "crunchyroll subscription", "anime release schedule", "studio ghibli movies", "anime conventions near me", "best anime 2024", "anime similar to attack on titan". Include both legal and popular private streaming sites. Keep queries concise and authentic to anime fan searches.`,
                weight: weights.anime
            },
            {
                name: 'games',
                systemPrompt: `You are a digital assistant that generates realistic, short web search queries for a gaming enthusiast who is a University of Toronto undergraduate student. Focus on popular video games, gaming platforms, deals, walkthroughs, and gaming community content. Generate concise, search-style queries that reflect genuine gaming behavior. Output ONLY JSON without any explanation.`,
                userPrompt: `Generate a JSON array of objects with "topic" (1-3 word search queries for gaming content) and "related" (0-6 related searches). Examples: "steam summer sale", "valorant patch notes", "genshin impact codes", "call of duty warzone", "fortnite item shop", "roblox promo codes", "epic games free games", "overwatch 2 ranked", "league of legends patch", "counter strike 2", "elden ring dlc", "xbox game pass", "playstation store", "nintendo switch games", "game release dates 2024", "best pc games". Include game titles, platform names, and common gaming terminology. Keep queries authentic to gaming community searches.`,
                weight: weights.games
            },
            {
                name: 'schoolServices',
                systemPrompt: `You are a digital assistant that generates realistic, short web search queries for a University of Toronto undergraduate student navigating academic resources and campus services. Focus on UofT-specific platforms, services, schedules, and academic support tools. Generate concise, search-style queries that reflect genuine student academic behavior. Output ONLY JSON without any explanation.`,
                userPrompt: `Generate a JSON array of objects with "topic" (1-3 word search queries for UofT services) and "related" (0-6 related searches). Examples: "uoft acorn login", "quercus uoft", "uoft email outlook", "uoft library hours", "uoft exam schedule", "coursehero free access", "studocu notes", "uoft tuition fees", "uoft housing portal", "uoft important dates", "uoft bookstore", "uoft shuttle bus", "uoft health insurance", "uoft career center", "uoft student services", "uoft academic calendar", "uoft parking permit", "uoft gym hours". Focus on UofT-specific services and academic resources. Keep queries relevant to undergraduate student needs.`,
                weight: weights.schoolServices
            },
            {
                name: 'csStudent',
                systemPrompt: `You are a digital assistant that generates realistic, short web search queries for a University of Toronto Computer Science undergraduate student working on assignments, studying algorithms, and solving coding problems. Focus on data structures, algorithms, time complexity, and programming concepts with emphasis on finding solutions and explanations. Generate concise, search-style queries that reflect genuine CS student problem-solving behavior. Output ONLY JSON without any explanation.`,
                userPrompt: `Generate a JSON array of objects with "topic" (2-4 word search queries for CS concepts with "solution" or "coursehero" suffix) and "related" (0-6 related searches). Examples: "binary search algorithm solution coursehero", "dynamic programming problems solution", "time complexity analysis practice problems", "data structures implementation examples", "Dijkstra algorithm implementation solution", "quick sort time complexity analysis", "hash table implementation tutorial", "linked list vs array performance", "tree traversal algorithms solution", "breadth first search problems coursehero", "backtracking algorithm examples", "object oriented programming concepts examples", "database design normalization problems", "operating systems virtual memory solution", "computer networks tcp/ip tutorial", "big O notation practice problems solution", "algorithm analysis assignment help solution". Always include "solution" or "coursehero" at the end to reflect genuine student search behavior when seeking help.`,
                weight: weights.csStudent
            }
        ]

        const selectedCategory = this.selectWeightedCategory(categories, weights)
        return { systemPrompt: selectedCategory.systemPrompt, userPrompt: selectedCategory.userPrompt }
    }

    private selectWeightedCategory(categories: any[], weights: CategoryWeights): any {
        const rng = randomInt(0, 1000000) / 1000000
        let cumulativeWeight = 0
        for (const category of categories) {
            cumulativeWeight += weights[category.name as keyof CategoryWeights]
            if (rng <= cumulativeWeight) {
                return category
            }
        }
        return categories[0]
    }

    private isRetryableError(err: any): boolean {
        if (!err) return false
        const msg = String(err.message || '')
        return msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('ECONNABORTED') ||
            msg.includes('ETIMEDOUT') || msg.includes('NETWORK_ERROR')
    }
}
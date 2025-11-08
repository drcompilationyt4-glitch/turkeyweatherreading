// src/functions/activities/Search.ts
import { Page } from 'rebrowser-playwright'
import { platform, hostname } from 'os'
import axios, { AxiosRequestConfig } from 'axios';

import { Workers } from '../Workers'

import { Counters, DashboardData } from '../../interface/DashboardData'
import { GoogleSearch } from '../../interface/Search'

type GoogleTrendsResponse = [
    string,
    [
        string,
        ...null[],
        [string, ...string[]]
    ][]
];

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private searchPageURL = ''

    // Lightweight in-memory recent-topic cache to reduce repetition across runs (LRU)
    private static recentTopicLRU: string[] = []
    private static recentTopicSet: Set<string> = new Set()
    private static RECENT_CACHE_LIMIT = 500

    // Google Trends cache with timestamp
    private static googleTrendsCache: { queries: GoogleSearch[], timestamp: number, geoLocale: string } | null = null
    private static TRENDS_CACHE_TTL = 3600000 // 1 hour in milliseconds

    public async doSearch(page: Page, data: DashboardData, numSearches?: number) {
        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Starting Bing searches')

        // Human-like delay before starting searches (1-3 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

        page = await this.bot.browser.utils.getLatestTab(page)

        let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
        let missingPoints = this.calculatePoints(searchCounters)

        if (missingPoints === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Bing searches have already been completed')
            return
        }

        // Decide how many searches we may need (roughly)
        const pointsPerSearch = this.bot.config.searchSettings?.pointsPerSearch || 5
        const neededSearches = Math.ceil(missingPoints / pointsPerSearch)
        const targetSearchCount = numSearches ? Math.min(numSearches, neededSearches) : neededSearches

        // Determine run seed / mode / diversity
        const runSeed = this.getRunSeed()
        const runId = this.getRunId(runSeed)

        const autoSettings = this.determineRunSettings(runSeed)
        const modeCfg = (this.bot.config.searchSettings?.mode as ('auto' | Mode) | undefined) || 'auto'
        const mode = modeCfg === 'auto' ? autoSettings.mode : (modeCfg as Mode)
        const diversityLevel = typeof this.bot.config.searchSettings?.diversityBase === 'number'
            ? this.bot.config.searchSettings.diversityBase
            : autoSettings.diversityLevel

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', `RunID=${runId} mode=${mode} diversity=${diversityLevel.toFixed(2)} pool=${autoSettings.modesPool.join(',')}`)

        // Generate search queries (50/50 LLM and Trends)
        const geo = this.bot.config.searchSettings?.useGeoLocaleQueries ? (data?.userProfile?.attributes?.country || 'US') : 'US'

        // Pass the run-specific modesPool into query gen so queries can be diversified per-item
        let googleSearchQueries: GoogleSearch[] = await this.getSearchQueries(geo, targetSearchCount, mode, diversityLevel, runSeed, autoSettings.modesPool)

        // Final fallbacks: local file
        if (!googleSearchQueries.length || googleSearchQueries.length < 1) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'No queries from LLM/Trends — falling back to local queries.json', 'warn')
            try {
                const local = await import('../queries.json')
                const sampleSize = Math.max(5, Math.min(25, (local.default || []).length))
                const sampled = this.bot.utils.shuffleArray(local.default || []).slice(0, sampleSize)
                googleSearchQueries = sampled.map((x: any) => ({ topic: x.queries?.[0] || x.title, related: x.queries?.slice(1) || [] }))
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed loading local queries fallback: ' + (e instanceof Error ? e.message : String(e)), 'error')
            }
        }

        // Shuffle and dedupe topics (we normalize by removing non-alphanumerics)
        googleSearchQueries = this.bot.utils.shuffleArray(googleSearchQueries)
        const seen = new Set<string>()
        googleSearchQueries = googleSearchQueries.filter(q => {
            if (!q || !q.topic) return false
            const k = q.topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (seen.has(k)) return false
            seen.add(k)
            return true
        })

        // Go to bing
        await page.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
        await this.bot.utils.wait(2000)
        await this.bot.browser.utils.tryDismissAllMessages(page)

        let stagnation = 0 // consecutive searches without point progress

        const queries: string[] = []
        // Mobile search doesn't seem to like related queries
        googleSearchQueries.forEach(x => { this.bot.isMobile ? queries.push(x.topic) : queries.push(x.topic, ...(x.related || [])) })

        // Loop over Google search queries (stop when we've satisfied points or exhausted queries)
        for (let i = 0; i < queries.length; i++) {
            const query = queries[i] as string

            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `${missingPoints} Points Remaining | Query: ${query}`)

            searchCounters = await this.bingSearch(page, query)
            const newMissingPoints = this.calculatePoints(searchCounters)

            // If the new point amount is the same as before
            if (newMissingPoints === missingPoints) {
                stagnation++
            } else {
                stagnation = 0
            }

            missingPoints = newMissingPoints

            if (missingPoints === 0) break

            // Only for mobile searches
            if (stagnation > 5 && this.bot.isMobile) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 5 iterations, likely bad User-Agent', 'warn')
                break
            }

            // If we didn't gain points for 10 iterations, assume it's stuck
            if (stagnation > 10) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 10 iterations aborting searches', 'warn')
                stagnation = 0 // allow fallback loop below
                break
            }
        }

        // Only for mobile searches
        if (missingPoints > 0 && this.bot.isMobile) {
            return
        }

        // If we still got remaining search queries, generate extra ones (related-terms fallback)
        if (missingPoints > 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search completed but we're missing ${missingPoints} points, generating extra searches`)

            let i = 0
            let fallbackRounds = 0
            const extraRetries = this.bot.config.searchSettings?.extraFallbackRetries ?? 1
            while (missingPoints > 0 && fallbackRounds <= extraRetries) {
                const query = googleSearchQueries[i++] as GoogleSearch
                if (!query) break

                // Get related search terms to the Google search queries
                const relatedTerms = await this.getRelatedTerms(query?.topic)
                if (relatedTerms.length > 3) {
                    // Search for the first 2 related terms
                    for (const term of relatedTerms.slice(1, 3)) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', `${missingPoints} Points Remaining | Query: ${term}`)

                        searchCounters = await this.bingSearch(page, term)
                        const newMissingPoints = this.calculatePoints(searchCounters)

                        // If the new point amount is the same as before
                        if (newMissingPoints === missingPoints) {
                            stagnation++
                        } else {
                            stagnation = 0
                        }

                        missingPoints = newMissingPoints

                        // If we satisfied the searches
                        if (missingPoints === 0) {
                            break
                        }

                        // Try 5 more times, then give up for this fallback round
                        if (stagnation > 5) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', 'Search didn\'t gain point for 5 iterations aborting searches', 'warn')
                            return
                        }
                    }
                    fallbackRounds++
                }
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Completed searches')
    }


    private async bingSearch(searchPage: Page, query: string) {
        const platformControlKey = platform() === 'darwin' ? 'Meta' : 'Control'

        // Try a max of 5 times
        for (let i = 0; i < 5; i++) {
            try {
                // Ensure we operate on the latest tab
                searchPage = await this.bot.browser.utils.getLatestTab(searchPage)

                // Go to top of the page
                await searchPage.evaluate(() => { window.scrollTo(0, 0) })
                await this.bot.utils.wait(500)

                const searchBar = '#sb_form_q'
                // Prefer attached over visible to avoid strict visibility waits when overlays exist
                const box = searchPage.locator(searchBar)

                // Helper to find any visible & enabled input on the page
                const findAnyVisibleInput = async (p: Page) => {
                    try {
                        const inputs = await p.$$('input')
                        for (const inp of inputs) {
                            try {
                                const visible = await inp.evaluate((el: HTMLElement) => {
                                    const style = window.getComputedStyle(el)
                                    const rect = el.getBoundingClientRect()
                                    return !el.hasAttribute('disabled') && !!(rect.width && rect.height) && style.visibility !== 'hidden' && style.display !== 'none'
                                })
                                if (visible) return inp
                            } catch { /* ignore evaluation errors */ }
                        }
                    } catch { /* ignore */ }
                    return null
                }

                // Try waiting for attached; if it times out, we'll attempt alternatives (Ctrl/Cmd+E fallback)
                try {
                    await box.waitFor({ state: 'attached', timeout: 15000 })
                } catch (waitErr) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Primary selector ${searchBar} not attached; attempting keyboard shortcut (Ctrl/Cmd+E) and fallback strategies`, 'warn')

                    // 1) Try dismiss overlays then short wait
                    await this.bot.browser.utils.tryDismissAllMessages(searchPage).catch(() => {})
                    await this.bot.utils.wait(200)

                    // Helper to try platform modifier + key and then check for the primary selector
                    const tryShortcut = async (key: string) => {
                        try {
                            await searchPage.keyboard.down(platformControlKey)
                            await searchPage.keyboard.press(key)
                            await searchPage.keyboard.up(platformControlKey)
                        } catch { /* ignore */ }
                        await this.bot.utils.wait(350)
                        try {
                            const el = await searchPage.$(searchBar)
                            if (el) return el
                        } catch { /* ignore */ }
                        return null
                    }

                    // 2) Try Ctrl/Cmd+E first (user requested), then Ctrl/Cmd+K, then '/' key
                    let found: any = null
                    found = await tryShortcut('E')
                    if (!found) found = await tryShortcut('K')
                    if (!found) {
                        try { await searchPage.keyboard.press('/') } catch { /* ignore */ }
                        await this.bot.utils.wait(350)
                        try { found = await searchPage.$(searchBar) } catch { /* ignore */ }
                    }

                    // If found via shortcut, use it
                    if (found) {
                        try {
                            await (found as any).focus().catch(() => { })
                            await (found as any).fill('')
                            await (found as any).type(query, { delay: 20 })
                            await searchPage.keyboard.press('Enter')
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Focused via shortcut and executed Enter', 'log')
                        } catch (e) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Shortcut-focused input failed, will try any visible input', 'warn')
                            found = null
                        }
                    }

                    // If still nothing, try any visible input
                    if (!found) {
                        const anyInput = await findAnyVisibleInput(searchPage)
                        if (anyInput) {
                            try {
                                await anyInput.focus()
                                await anyInput.fill('')
                                await anyInput.type(query, { delay: 20 })
                                await searchPage.keyboard.press('Enter')
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Used fallback visible input + Enter', 'log')
                            } catch (e) {
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Fallback visible input failed, navigating directly', 'warn')
                                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                                await searchPage.goto(url)
                            }
                        } else {
                            // Last resort: try pressing Enter on current focus then direct navigation
                            try {
                                await searchPage.keyboard.press('Enter')
                                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Pressed Enter with no specific input focused (best-effort)', 'warn')
                                await this.bot.utils.wait(1000)
                                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                                await searchPage.goto(url)
                            } catch (e) {
                                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                                await searchPage.goto(url)
                            }
                        }
                    }
                }

                // Try interacting with primary box when present
                let navigatedDirectly = false
                try {
                    // Try focusing and filling instead of clicking (more reliable on mobile)
                    await box.focus({ timeout: 2000 }).catch(() => { /* ignore focus errors */ })
                    await box.fill('')
                    await this.bot.utils.wait(200)
                    await searchPage.keyboard.down(platformControlKey)
                    await searchPage.keyboard.press('A')
                    await searchPage.keyboard.press('Backspace')
                    await searchPage.keyboard.up(platformControlKey)
                    // type with small delay to look human
                    await box.type(query, { delay: 20 })
                    await searchPage.keyboard.press('Enter')
                } catch (typeErr) {
                    // Robust fallback: navigate directly to the search URL
                    const q = encodeURIComponent(query)
                    const url = `https://www.bing.com/search?q=${q}`
                    await searchPage.goto(url)
                    navigatedDirectly = true
                }

                // Short wait for results to settle
                await this.bot.utils.wait(3000)

                // If Enter opened a new tab, get it; otherwise stay on current
                const resultPage = navigatedDirectly ? searchPage : await this.bot.browser.utils.getLatestTab(searchPage)
                this.searchPageURL = new URL(resultPage.url()).href // Set the results page

                await this.bot.browser.utils.reloadBadPage(resultPage)

                if (this.bot.config.searchSettings?.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(resultPage)
                }

                if (this.bot.config.searchSettings?.clickRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.clickRandomLink(resultPage)
                }

                // Delay between searches (configurable)
                const minDelay = this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.min)
                const maxDelay = this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.max)
                const adaptivePad = Math.min(4000, Math.max(0, Math.floor(Math.random() * 800)))
                await this.bot.utils.wait(Math.floor(this.bot.utils.randomNumber(minDelay, maxDelay)) + adaptivePad)

                return await this.bot.browser.func.getSearchPoints()

            } catch (error) {
                if (i === 4) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed after 5 retries... An error occurred:' + error, 'error')
                    break
                }

                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed, An error occurred:' + error, 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Retrying search, attempt ${i + 1}/5`, 'warn')

                // Reset the tabs
                try {
                    const lastTab = await this.bot.browser.utils.getLatestTab(searchPage)
                    await this.closeTabs(lastTab)
                } catch { /* ignore */ }

                // Human-like delay after failure (3-5 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 5000))
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed after 5 retries, ending', 'error')
        return await this.bot.browser.func.getSearchPoints()
    }

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
        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Generating ${desiredCount} queries (70% Trends / 30% LLM; Trends fill missing)`)

        // Default to 30% LLM (i.e. 70% Trends). Respect config override but clamp 0..100.
        const llmPct = Math.max(0, Math.min(100, this.bot.config.searchSettings?.queryMix?.llmPct ?? 43))
        const llmCount = Math.max(0, Math.ceil(desiredCount * (llmPct / 100)))
        const trendsCount = Math.max(0, desiredCount - llmCount)

        // 1) Attempt LLM batch first (target llmCount)
        let llmQueries: GoogleSearch[] = []
        let llmShortfall = 0
        try {
            if (llmCount > 0) {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Attempting LLM batch for ${llmCount} queries`)
                llmQueries = await this.getEnhancedLLMQueries(geoLocale, llmCount, mode, runSeed)
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `LLM returned ${llmQueries.length} items`)
                if (llmQueries.length < llmCount) llmShortfall = llmCount - llmQueries.length
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `LLM batch failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            // per-search fallback if enabled
            if (this.bot.config.searchSettings?.enablePerSearchFallback && llmCount > 0) {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Attempting per-search LLM fallback')
                const per: GoogleSearch[] = []
                for (let i = 0; i < llmCount; i++) {
                    try {
                        const q = await this.generateSingleQueryFromLLM(geoLocale, mode)
                        if (q) per.push({ topic: q, related: [] })
                    } catch (e) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Per-search LLM iteration failed: ${e instanceof Error ? e.message : String(e)}`, 'warn')
                    }
                }
                llmQueries = per
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Per-search LLM returned ${llmQueries.length} items`)
                if (llmQueries.length < llmCount) llmShortfall = llmCount - llmQueries.length
            } else {
                llmShortfall = llmCount
            }
        }

        // 2) Attempt Trends with caching.
        // If LLM had shortfall, attempt to fetch extra trends to cover that shortfall.
        let trendsQueries: GoogleSearch[] = []
        const trendsNeeded = Math.max(0, trendsCount + llmShortfall) // request extra to cover shortfall
        if (trendsNeeded > 0) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Fetching Google Trends (up to ${trendsNeeded})`)
                const gt = await this.getCachedGoogleTrends(geoLocale)
                if (gt.length) {
                    trendsQueries = this.bot.utils.shuffleArray(gt).slice(0, trendsNeeded)
                    this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Google trends cache returned ${gt.length} items, sampled ${trendsQueries.length}`)

                    // Remove used queries from cache (if stored and matches locale)
                    if ((Search as any).googleTrendsCache && (Search as any).googleTrendsCache.geoLocale === geoLocale) {
                        const remainingQueries = gt.filter(item => !trendsQueries.includes(item))
                        ;(Search as any).googleTrendsCache.queries = remainingQueries
                    }
                } else {
                    throw new Error('No usable Google trends')
                }
            } catch (tErr) {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Google Trends fetch failed (non-fatal): ${tErr instanceof Error ? tErr.message : String(tErr)}`, 'warn')
                // Fallback to Reddit if Google Trends fails
                try {
                    this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Falling back to Reddit Trends (up to ${trendsNeeded})`)
                    const rawTrends = await this.getRedditTrends(geoLocale)
                    if (Array.isArray(rawTrends) && rawTrends.length) {
                        trendsQueries = this.bot.utils.shuffleArray(rawTrends).slice(0, trendsNeeded)
                        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Reddit trends returned ${rawTrends.length} items, sampled ${trendsQueries.length}`)
                    } else {
                        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Reddit trends returned no usable items', 'warn')
                    }
                } catch (rErr) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Reddit Trends fetch failed (non-fatal): ${rErr instanceof Error ? rErr.message : String(rErr)}`, 'warn')
                }
            }
        }

        // 3) Combine according to rules: prioritize Trends (since 70% trends), then LLM, then local fallback.
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

        // 3a) Start with Trends (sample up to trendsCount from trendsQueries)
        if (trendsQueries && trendsQueries.length > 0) {
            for (const t of trendsQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(t)
            }
        }

        // 3b) Append LLM (up to llmCount), if LLM provided items
        if (llmQueries && llmQueries.length > 0) {
            for (const q of llmQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(q)
            }
        }

        // 3c) If still short, try to pull more trends from cache (if any left)
        if (combined.length < desiredCount) {
            const missing = desiredCount - combined.length
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Top-up: need ${missing} more queries after Trends/LLM. Attempting to fill from trends cache.`)
            try {
                const gtExtra = await this.getCachedGoogleTrends(geoLocale)
                if (gtExtra && gtExtra.length) {
                    const sample = this.bot.utils.shuffleArray(gtExtra).slice(0, missing)
                    for (const s of sample) {
                        if (combined.length >= desiredCount) break
                        if (pushIfUnique(s)) {
                            if ((Search as any).googleTrendsCache && (Search as any).googleTrendsCache.geoLocale === geoLocale) {
                                (Search as any).googleTrendsCache.queries = (Search as any).googleTrendsCache.queries.filter((x: any) => x !== s)
                            }
                        }
                    }
                }
            } catch {
                // ignore and continue to local fallback
            }
        }

        // 3d) If still short, use local fallback (guaranteed)
        if (combined.length < desiredCount) {
            const missing = desiredCount - combined.length
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Filling ${missing} queries from local fallback`)
            const localCandidates = await this.getLocalQueriesFallback(Math.max(missing, 5))
            for (const l of localCandidates) {
                if (combined.length >= desiredCount) break
                pushIfUnique(l)
            }
        }

        // 4) If somehow empty, return unconditional local fallback
        if (combined.length === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'No queries from Trends/LLM/local attempt — using local fallback (final)', 'warn')
            return this.getLocalQueriesFallback(desiredCount)
        }

        // 5) Final deterministic shuffle/diversify and return up to desiredCount
        const rng = this.seededRng(runSeed ?? this.getRunSeed())
        const normalized = this.diversifyQueries(combined, mode, (new Date()).getDay(), rng, diversityLevel, modesPool)

        // add final keys to recent cache to reduce repetition across runs
        for (const item of normalized.slice(0, desiredCount)) {
            this.addToRecentTopics(item.topic || '')
        }

        return normalized.slice(0, desiredCount)
    }







    /**
     * Get Google Trends with caching - pop from cache if available, otherwise fetch new
     */
    private async getCachedGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const now = Date.now()

        // Check if we have valid cached data
        if (Search.googleTrendsCache &&
            Search.googleTrendsCache.geoLocale === geoLocale &&
            (now - Search.googleTrendsCache.timestamp) < Search.TRENDS_CACHE_TTL &&
            Search.googleTrendsCache.queries.length > 0) {

            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Using cached Google Trends with ${Search.googleTrendsCache.queries.length} queries remaining`)
            return [...Search.googleTrendsCache.queries] // Return copy to prevent mutation issues
        }

        // Cache is empty/expired, fetch new data
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Cache empty/expired, fetching fresh Google Trends data')
        const freshQueries = await this.getGoogleTrends(geoLocale)

        // Update cache
        Search.googleTrendsCache = {
            queries: freshQueries,
            timestamp: now,
            geoLocale
        }

        return freshQueries
    }

    private async getEnhancedLLMQueries(geoLocale: string, count: number, mode: Mode, runSeed?: number): Promise<GoogleSearch[]> {
        const { mode: ctxMode, contextNotes } = this.determineRunSettings(runSeed)
        const finalMode = mode || ctxMode
        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Generating ${count} LLM queries in ${finalMode} mode: ${contextNotes}`)

        try {
            return await this.generateQueriesWithLLMBatch(geoLocale, count, finalMode, contextNotes, runSeed)
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Enhanced LLM generation failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            return []
        }
    }

    private async getLocalQueriesFallback(desiredCount: number): Promise<GoogleSearch[]> {
        try {
            const local = await import('../queries.json')
            const sampleSize = Math.max(5, Math.min(25, (local.default || []).length))
            const sampled = this.bot.utils.shuffleArray(local.default || []).slice(0, sampleSize)
            return sampled.map((x: any) => ({ topic: x.queries?.[0] || x.title, related: x.queries?.slice(1) || [] }))
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Failed loading local queries fallback: ' + (e instanceof Error ? e.message : String(e)), 'error')
            return [];
        }
    }

    private async getGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = []
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Generating search queries, can take a while! | GeoLocale: ${geoLocale}`)

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
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Failed to parse Google Trends response', 'error')
                return queryTerms
            }

            const mappedTrendsData = trendsData.map(query => [query[0], query[9]!.slice(1)])
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Found ${mappedTrendsData.length} search queries for ${geoLocale}`)

            if (mappedTrendsData.length < 30 && geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Insufficient search queries (${mappedTrendsData.length} < 30), falling back to US`, 'warn')
                return this.getGoogleTrends()
            }

            for (const [topic, relatedQueries] of mappedTrendsData) {
                queryTerms.push({
                    topic: topic as string,
                    related: relatedQueries as string[]
                })
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'An error occurred:' + error, 'error')
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

    /**
     * Replace the previous Google Trends approach with Reddit-based trending fetch.
     * - Try r/all/top.json?t=day (no auth)
     * - Fallback to r/all/hot.json
     * - Produce GoogleSearch[] where topic = post title; related contains subreddit and small variants.
     */
    private async getRedditTrends(_geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const results: GoogleSearch[] = []
        this.bot.log(this.bot.isMobile, 'SEARCH-TRENDS-REDDIT', 'Fetching trending topics from Reddit (r/all top/day fallback to hot)')

        // human-like delay
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

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
                    timeout: (this.bot.config?.googleTrends?.timeoutMs) || 20000,
                    proxy: false,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0; +https://example.com)'
                    }
                }
                const resp = await axios.request(req as any)
                const data = resp?.data
                const children = data?.data?.children
                if (!Array.isArray(children) || children.length === 0) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-TRENDS-REDDIT', `No items from Reddit endpoint ${url}`, 'warn')
                    continue
                }

                for (const c of children) {
                    try {
                        const d = c?.data
                        if (!d) continue
                        // Take title, subreddit and some metadata
                        const rawTitle = (d.title || '').toString().trim()
                        if (!rawTitle) continue

                        // Clean up common HTML entities (basic)
                        const title = rawTitle.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

                        // Build related suggestions: subreddit, 'discussion', 'review', 'how to'
                        const subreddit = d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : '')
                        const related: string[] = []
                        if (subreddit) related.push(subreddit)
                        // short variants to help diversify searches
                        related.push(`${title} discussion`)
                        related.push(`${title} review`)
                        // add "how to" only when title suggests tutorial/problem keywords are unlikely
                        if (title.length < 120) {
                            related.push(`${title} explained`)
                        }
                        // dedupe related
                        const uniqRelated = Array.from(new Set(related.map(r => (r || '').trim()).filter(Boolean))).slice(0, 4)

                        results.push({ topic: title, related: uniqRelated })
                    } catch {
                        // ignore malformed child
                        continue
                    }
                }

                if (results.length) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-TRENDS-REDDIT', `Reddit trends fetched ${results.length} items from ${url}`)
                    // return moderately sized results, caller will sample
                    return results
                }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'SEARCH-TRENDS-REDDIT', `Reddit endpoint ${url} failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
                // try next endpoint
            }
        }

        // if all failed, return empty array (caller will fallback to local)
        return []
    }

    private async getRelatedTerms(term: string): Promise<string[]> {
        try {
            // Human-like delay before fetching related terms (0.5-1.5s)
            await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

            const request = {
                url: `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(term)}`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                proxy: false
            }

            const response = await axios.request(request as any)
            return response.data?.[1] as string[] || []
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING-RELATED', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }

        return []
    }

    private async randomScroll(page: Page) {
        try {
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            if (totalHeight <= viewportHeight) return
            const randomScrollPosition = Math.floor(Math.random() * (totalHeight - viewportHeight))

            await page.evaluate((scrollPos: number) => { window.scrollTo(0, scrollPos) }, randomScrollPosition)

            // Human-like delay after scrolling (2-5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-RANDOM-SCROLL', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }
    }

    // Restored working clickRandomLink implementation
    private async clickRandomLink(page: Page) {
        try {
            // Small wait+click to open a result if present
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
            await page.click('#b_results .b_algo h2', { timeout: 2000 }).catch(() => { })

            // Only used if the browser shows an Edge continuation popup
            await this.closeContinuePopup(page)

            // Stay for 10 seconds for page to load and "visit"
            await this.bot.utils.wait(10000)

            // Will get current tab if no new one is created
            let lastTab = await this.bot.browser.utils.getLatestTab(page)
            let lastTabURL = new URL(lastTab.url())

            // If click opened a new tab, close it and return to search results. Limit loops.
            let i = 0
            while (lastTabURL.href !== this.searchPageURL && i < 5) {
                await this.closeTabs(lastTab)
                lastTab = await this.bot.browser.utils.getLatestTab(page)
                lastTabURL = new URL(lastTab.url())
                i++
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-RANDOM-CLICK', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }
    }

    private async closeTabs(lastTab: Page) {
        const browser = lastTab.context()
        const tabs = browser.pages()

        // Human-like delay before closing tabs (0.5-1.5 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        try {
            if (tabs.length > 2) {
                // Close the last tab
                await lastTab.close()
                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', `More than 2 were open, closed the last tab: "${new URL(lastTab.url()).host}"`)
            } else if (tabs.length === 1) {
                // If only 1 tab is open, open a new one to search in
                const newPage = await browser.newPage()
                await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

                await newPage.goto(this.bingHome)
                await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))
                this.searchPageURL = newPage.url()

                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'There was only 1 tab open, created a new one')
            } else {
                // Else reset the last tab back to the search listing or Bing.com
                lastTab = await this.bot.browser.utils.getLatestTab(lastTab)
                await lastTab.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'An error occurred:' + (error instanceof Error ? error.message : String(error)), 'error')
        }
    }

    private calculatePoints(counters: Counters) {
        const mobileData = counters.mobileSearch?.[0] // Mobile searches
        const genericData = counters.pcSearch?.[0] // Normal searches
        const edgeData = counters.pcSearch?.[1] // Edge searches

        if (this.bot.isMobile && mobileData) {
            return (mobileData.pointProgressMax || 0) - (mobileData.pointProgress || 0)
        }

        const edgeMissing = edgeData ? ((edgeData.pointProgressMax || 0) - (edgeData.pointProgress || 0)) : 0
        const genericMissing = genericData ? ((genericData.pointProgressMax || 0) - (genericData.pointProgress || 0)) : 0

        return edgeMissing + genericMissing
    }

    private async closeContinuePopup(page: Page) {
        try {
            await page.waitForSelector('#sacs_close', { timeout: 1000 })
            const continueButton = await page.$('#sacs_close')

            if (continueButton) {
                // Human-like delay before closing popup (0.3-1 second)
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))
                await continueButton.click()
            }
        } catch (error) {
            // Continue if element is not found or other error occurs
        }
    }

    // ----------------------- Helpers for deterministic per-run randomness --------------------

    private getRunSeed(): number {
        const cfgId = this.bot.config?.searchSettings?.instanceId
        const envId = process.env.GITHUB_RUN_ID || process.env.CI_RUN_ID || process.env.RUN_ID || process.env.GITHUB_RUN_NUMBER
        const host = cfgId || envId || hostname() || 'unknown-host'
        const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
        const seedStr = `${host}|${today}`
        return this.cyrb53(seedStr)
    }

    private getRunId(seed?: number): string {
        const s = (typeof seed === 'number') ? seed : this.getRunSeed()
        return (s >>> 0).toString(36).slice(-6)
    }

    // cyrb53 string hash -> number
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

    /**
     * Determine run settings.
     * - weekday biases mode, but we return a pool (modesPool) so per-query mode selection (enables interleaving).
     */
    private determineRunSettings(seed?: number): { mode: Mode, diversityLevel: number, contextNotes: string, modesPool: Mode[] } {
        const weekday = (new Date()).getDay()
        const rng = this.seededRng(seed ?? this.getRunSeed())

        // Default mode bias: weekend biased towards relaxed, weekdays balanced/study
        let mode: Mode = 'balanced'
        if (weekday === 0 || weekday === 6) {
            mode = rng() < 0.7 ? 'relaxed' : 'food'
        } else {
            // weekday: sometimes study, sometimes balanced
            mode = rng() < 0.4 ? 'study' : 'balanced'
        }

        const configBoost = typeof this.bot.config.searchSettings?.randomnessBoost === 'number' ? this.bot.config.searchSettings.randomnessBoost : 0
        // diversityLevel between 0.1..0.95
        const diversityLevel = Math.max(0.1, Math.min(0.95, (rng() * 0.6) + 0.2 + (configBoost * 0.1)))

        // Build a pool of modes for this run so queries can be interleaved across related modes
        const allModes: Mode[] = ['balanced', 'relaxed', 'study', 'food', 'gaming', 'news']
        const modesPool: Mode[] = []

        // Keep primary mode present, then add 1-2 varied modes (weekday/weekend biased)
        modesPool.push(mode)
        // Add one complementary mode with some bias
        if (rng() < 0.6) {
            const idx = Math.floor(rng() * allModes.length)
            let choice: Mode = allModes[idx] ?? mode
            if (choice === mode) {
                const altIdx = (idx + 1) % allModes.length
                choice = allModes[altIdx] ?? mode
            }
            modesPool.push(choice)
        }
        // Occasionally add a third mode to create more interleave diversity
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

    // Diversify queries to reduce repetition and make them feel more "human".
    // Accepts an optional modesPool for per-item mode selection (enables interleaving).
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

            // choose per-item mode: either from modesPool or fall back to global mode
            const itemMode: Mode = (modesPool && modesPool.length) ? (modesPool[Math.floor(rng() * modesPool.length)] as Mode) : mode

            // Normalize and check against recent topics - attempt variations if we've seen it recently
            const baseKey = topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (Search.recentTopicSet.has(baseKey) && rng() < 0.8) {
                // try to tweak it: add a suffix, brand, or rewrite up to a few attempts
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
                        // generic suffix add
                        if (itemMode === 'relaxed' && rng() < modeTweakProbBase) {
                            const suffix = entertainmentSuffix[Math.floor(rng() * entertainmentSuffix.length)]
                            tweaked = `${tweaked} ${suffix}`
                        } else if (itemMode === 'study' && rng() < (modeTweakProbBase + 0.1)) {
                            const suffix = studySuffix[Math.floor(rng() * studySuffix.length)]
                            tweaked = `${tweaked} ${suffix}`
                        } else {
                            // try swap words order or add "review" etc.
                            tweaked = `${tweaked} review`
                        }
                    }
                }
                topic = tweaked.replace(/\s+/g, ' ').trim()
            }

            // Avoid repetitive generic phrase — replace sometimes
            if (/^cheap food near me$/i.test(topic) || /cheap food/i.test(topic) || /cheap meal/i.test(topic) || /cheap eats/i.test(topic)) {
                if (rng() < replaceProbBase) {
                    const idxChoice = Math.floor(rng() * foodExamples.length)
                    topic = foodExamples[idxChoice % foodExamples.length]!
                } else {
                    topic = 'cheap food near me'
                }
            }

            // Mode-based tweaks: relaxed -> more YouTube/gaming; study -> more focused study suffix
            if (itemMode === 'relaxed' && rng() < modeTweakProbBase) {
                const suffixIdx = Math.floor(rng() * entertainmentSuffix.length) % entertainmentSuffix.length
                topic = `${topic} ${entertainmentSuffix[suffixIdx]!}`
            } else if (itemMode === 'study' && rng() < (modeTweakProbBase + 0.1)) {
                const suffixIdx = Math.floor(rng() * studySuffix.length) % studySuffix.length
                topic = `${topic} ${studySuffix[suffixIdx]!}`
            } else if (itemMode === 'gaming' && rng() < (modeTweakProbBase + 0.15)) {
                // gaming specific tweak
                topic = `${topic} gameplay`
            } else if (itemMode === 'food' && rng() < (modeTweakProbBase + 0.15)) {
                topic = `${topic} near campus`
            }

            // Weekend bias: more entertainment
            if ((weekday === 0 || weekday === 6) && rng() < weekendBiasBase) {
                const suffixIdx = Math.floor(rng() * entertainmentSuffix.length) % entertainmentSuffix.length
                topic = `${topic} ${entertainmentSuffix[suffixIdx]!}`
            }

            topic = topic.replace(/\s+/g, ' ').trim()

            // Build related list conservatively
            const related = (item.related || [])
                .slice(0, 4)
                .filter(r => typeof r === 'string')
                .map(r => r.trim())
                .filter(Boolean) as string[]

            if (related.length < 2 && rng() < relatedAddProbBase) {
                // add helpful related
                related.push(topic + ' review')
            }

            // final dedupe against per-run output & recent cache
            const finalKey = topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (!Search.recentTopicSet.has(finalKey) && !out.some(o => (o.topic || '').toLowerCase().replace(/[^a-z0-9]/g, '') === finalKey)) {
                out.push({ topic, related })
                // tentatively add to recent (but keep order via addToRecentTopics at the end)
                Search.recentTopicSet.add(finalKey)
                Search.recentTopicLRU.push(finalKey)
                // maintain LRU size
                while (Search.recentTopicLRU.length > Search.RECENT_CACHE_LIMIT) {
                    const rm = Search.recentTopicLRU.shift()
                    if (rm) Search.recentTopicSet.delete(rm)
                }
            } else {
                // if duplicate to recent, still push if we have very few items (to avoid zero results); otherwise skip
                if (out.length < 2) out.push({ topic, related })
            }
        }

        // Deterministic shuffle and dedupe via rng
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

    // add a topic to the recent LRU cache
    private addToRecentTopics(topic: string) {
        try {
            const key = (topic || '').toLowerCase().replace(/[^a-z0-9]/g, '')
            if (!key) return
            if (Search.recentTopicSet.has(key)) {
                // move to back (most recent)
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

    // Updated: replaced deepseek preferred model with z-ai/glm-4.5-air:free
    // Kept most logic the same. Adjusted example searches to favor services (chatgpt, youtube, gmail, deepseek)
    // and games/platforms (steam, roblox) while keeping UofT items present but less frequent. Kept axios usage
    // and proxy:false. Added optional reasoning flag support in request body when using GLM-4.5-Air.

    // Updated: replaced deepseek preferred model with z-ai/glm-4.5-air:free
    // Kept most logic the same. Adjusted example searches to favor services (chatgpt, youtube, gmail, deepseek)
    // and games/platforms (steam, roblox) while keeping UofT items present but less frequent. Kept axios usage
    // and proxy:false. Added reasoning_enabled = true for GLM-4.5-Air (thinking mode). Increased timeout for longer reasoning.

    // Updated: replaced deepseek preferred model with z-ai/glm-4.5-air:free
    // Kept most logic the same. Adjusted example searches to favor services (chatgpt, youtube, gmail, deepseek)
    // and games/platforms (steam, roblox) while keeping UofT items present but less frequent. Kept axios usage
    // and proxy:false. Added reasoning_enabled = true for GLM-4.5-Air (thinking mode). Increased timeout for longer reasoning.

// NOTE: remove any hard-coded API keys in your repo and rotate compromised keys immediately.

// --- generateQueriesWithLLMBatch ---
    private async generateQueriesWithLLMBatch(
        geoLocale: string,
        desiredCount = 25,
        mode: Mode = 'balanced',
        contextNotes: string = '',
        runSeed?: number
    ): Promise<GoogleSearch[]> {
        const envKey1 = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim()
        const envKey2 = (process.env.OPENROUTER_API_KEY_2 || this.bot.config?.openRouterApiKey2 || '').toString().trim()
        const keys = [envKey1, envKey2].filter(k => !!k)
        if (!keys.length) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'OpenRouter API key(s) missing. Set OPENROUTER_API_KEY and/or OPENROUTER_API_KEY_2 or bot.config.openRouterApiKey', 'error')
            throw new Error('OpenRouter API key not configured')
        }

        const preferredModel = this.bot.config?.openRouterPreferredModel || 'z-ai/glm-4.5-air:free'
        const fallbackModel = this.bot.config?.openRouterFallbackModel || 'meta-llama/llama-3.3-70b-instruct:free'

        const rng = this.seededRng(runSeed ?? this.getRunSeed())

        const realisticPatterns = [
            'Prefer very short queries (1-3 words), but allow up to 4 words for partial anime titles or short phrases (e.g., "reincarnated as slime").',
            'Mix one-word hot queries (YouTube, GitHub) with short 2-4 word specifics (e.g., "vegetarian fajitas", "attack on titan").',
            'Favor student-relevant items: course codes, prof names, campus places, streaming/youtube creators, game titles, quick recipes, wiki pages, anime site queries.',
            'Avoid long prose; produce concise search-style phrases or titles. Keep JSON-only output.'
        ]

        const exampleSearches = [
            'deepseek', 'chatgpt', 'youtube', 'gmail', 'deepseek', 'chatgpt', 'youtube music', 'gmail login',
            'attack on titan', 'reincarnated as slime', 're:zero', 'anime streaming sites', 'crunchyroll', 'myanimelist',
            'steam', 'roblox', 'steam store', 'roblox login', 'uoft', 'uoft email', 'csc108', 'mat137',
            'prof smith office hours', 'wiki relativity', 'quick ramen recipe', 'how to git'
        ]

        const systemPrompt = `You are an assistant that outputs JSON only: a single JSON array of objects. Each object must contain: - "topic": a short realistic search query a University of Toronto undergraduate might type (prefer 1-3 words; allow up to 4 words for partial/full anime titles or short phrases). - "related": an array of 0..6 short related searches.  Guidelines: - Use ${geoLocale.toUpperCase()} locale when relevant. - Keep queries concise and search-like: single words ("youtube", "github"), short phrases ("vegetarian fajitas", "attack on titan"), or short commands/questions ("how to git", "wiki relativity"). - For anime-related queries, produce search-style titles or partial titles (examples: "attack on titan", "reincarnated as slime", "re:zero"), or site queries ("anime streaming sites", "crunchyroll", "myanimelist"). - Favor student-relevant items: course codes (CSC108), prof names, campus locations, streaming creators, quick recipes, known tools (chatgpt, qwen, openrouter). - Avoid politically sensitive or adult content. - Avoid repeating the same phrase; be diverse **but services (chatgpt, youtube, gmail, deepseek) and platforms (steam, roblox) may appear more often** to match real human search behaviour. - Use the example search history to match tone and brevity: ${exampleSearches.slice(0,8).join(', ')} ... plus anime/site and student examples. - Output MUST be valid JSON only (no explanation). This request context: ${contextNotes}. Use style tip: ${realisticPatterns[Math.floor(rng() * realisticPatterns.length)]}. For mode: ${mode}.`

        const userPrompt = `Generate up to ${desiredCount} concise search queries a University of Toronto undergraduate might use. Prefer short queries (1-3 words), allow up to 4 words for partial anime titles or short site phrases. Output JSON array only.`

        const baseMessages = [ { role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt } ]

        const maxTokens = Math.min(1600, 90 * desiredCount)

        // Build request body using OpenRouter 'reasoning' object
        const buildRequestBody = (model: string) => {
            const body: any = {
                model,
                messages: baseMessages,
                max_tokens: maxTokens,
                temperature: 0.6
            }

            if (/glm-4.5-air/i.test(model) || /glm-4.5/i.test(model)) {
                // Default to enabling reasoning per your request; allow overrides in config
                const cfgEnable = typeof this.bot.config?.openRouterReasoningEnabled === 'boolean'
                    ? this.bot.config.openRouterReasoningEnabled
                    : true

                body.reasoning = { enabled: !!cfgEnable }

                if (body.reasoning.enabled) {
                    body.reasoning.effort = typeof this.bot.config?.openRouterReasoningEffort === 'string'
                        ? this.bot.config.openRouterReasoningEffort
                        : 'medium'
                    if (typeof this.bot.config?.openRouterReasoningMaxTokens === 'number') {
                        body.reasoning.max_tokens = this.bot.config.openRouterReasoningMaxTokens
                    }
                    if (typeof this.bot.config?.openRouterReasoningExclude === 'boolean') {
                        body.reasoning.exclude = !!this.bot.config.openRouterReasoningExclude
                    }
                }
            }

            return body
        }

        const sendOnce = async (apiKey: string, model: string): Promise<string> => {
            const body = buildRequestBody(model)
            const reasoningOn = body.reasoning && body.reasoning.enabled === true
            const timeoutMs = reasoningOn ? (this.bot.config?.openRouterReasoningTimeoutMs || 240000) : 90000

            const requestConfig: AxiosRequestConfig = {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://github.com/tourdefrance',
                    'X-Title': 'TourDeFrance Search Bot'
                },
                data: body,
                timeout: timeoutMs,
                proxy: false
            }

            // Try + one retry on "empty" content
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await axios.request(requestConfig as any)

                    // representative choice/message
                    const choice = Array.isArray(resp?.data?.choices) && resp.data.choices.length ? resp.data.choices[0] : null
                    const msg = choice?.message || {}

                    // extract content from the usual and reasoning fields
                    let content: string | undefined
                    if (typeof msg.content === 'string' && msg.content.trim().length) {
                        content = msg.content
                    } else if (typeof msg.reasoning === 'string' && msg.reasoning.trim().length) {
                        content = msg.reasoning
                    } else if (msg.reasoning && typeof msg.reasoning === 'object') {
                        try { content = JSON.stringify(msg.reasoning) } catch { content = String(msg.reasoning || '') }
                    } else if (choice && typeof choice.text === 'string' && choice.text.trim().length) {
                        content = choice.text
                    } else if (typeof resp?.data?.result?.content === 'string' && resp.data.result.content.trim().length) {
                        content = resp.data.result.content
                    } else if (typeof resp?.data?.content === 'string' && resp.data.content.trim().length) {
                        content = resp.data.content
                    } else if (typeof resp?.data === 'string' && resp.data.trim().length) {
                        content = resp.data
                    }

                    if (!content || !String(content).trim()) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM',
                            `LLM returned empty content (attempt ${attempt+1}); status=${resp?.status} body-keys=${resp && typeof resp.data === 'object' ? Object.keys(resp.data) : typeof resp.data}`,
                            'warn')
                        if (attempt === 0) {
                            await new Promise(res => setTimeout(res, reasoningOn ? 2000 : 500))
                            continue
                        }
                        throw new Error('No content from LLM (empty response)')
                    }

                    return String(content)
                } catch (error: any) {
                    if (error.response) {
                        const status = error.response.status
                        const data = error.response.data
                        throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`)
                    } else if (error.code === 'ECONNABORTED') {
                        throw new Error('Request timeout')
                    } else if (error.message && error.message.includes('No content')) {
                        throw error
                    } else {
                        if (attemptRetryable(error)) {
                            if (attempt === 0) {
                                await new Promise(res => setTimeout(res, 500))
                                continue
                            }
                        }
                        throw new Error(`Request failed: ${error.message || String(error)}`)
                    }
                }
            }

            // Guarantee we never fall through without throwing (TypeScript safety)
            throw new Error('LLM request failed after retries (batch sendOnce)')

            // small helper: retryable error heuristic
            function attemptRetryable(err: any) {
                if (!err) return false
                const msg = String(err.message || '')
                return msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('ECONNABORTED')
            }
        }

        let lastErr: any = null

        // try preferred model/key combos
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying preferred model ${preferredModel} with an API key`)
                const content = await sendOnce(key, preferredModel)

                // parse robustly (strip code fences if present)
                let parsed: any = null
                try { parsed = JSON.parse(String(content)) } catch {
                    const s = String(content).replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
                    try { parsed = JSON.parse(s) }
                    catch {
                        const jsonMatch = String(content).match(/\[[\s\S]*\]/)
                        if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
                        else throw new Error('No JSON array found in LLM response')
                    }
                }

                if (!Array.isArray(parsed)) throw new Error('LLM returned non-array JSON')

                const normalized: GoogleSearch[] = parsed.map((item: any) => {
                    let topic = ''
                    if (typeof item.topic === 'string') topic = item.topic
                    else if (typeof item === 'string') topic = item
                    else if (item && item[0] && typeof item[0] === 'string') topic = item[0]
                    topic = topic.trim().replace(/(^"|"$)/g, '')

                    const words = topic.split(/\s+/).filter(Boolean)
                    const maxWords = /anime|crunchyroll|myanimelist|attack|reincarnated|re:zero/i.test(topic) ? 4 : 3
                    const finalWords = words.slice(0, Math.max(1, Math.min(maxWords, words.length)))
                    let cleaned = finalWords.join(' ').replace(/[^\w\s:-]/g, '').trim()
                    if (cleaned.length > 40) cleaned = cleaned.split(/\s+/).slice(0, 4).join(' ').slice(0, 40).trim()

                    const related = Array.isArray(item.related) ? item.related.map((r: any) => {
                        if (typeof r !== 'string') return ''
                        const rw = r.trim().split(/\s+/).slice(0, 4).join(' ').replace(/[^\w\s-]/g, '').trim()
                        return rw
                    }).filter((r: string) => r.length > 0) : []

                    return { topic: cleaned, related }
                }).filter(x => x.topic && x.topic.length > 0)

                if (normalized.length === 0) throw new Error('LLM returned empty or invalid queries after normalization')

                return normalized
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Preferred model attempt failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            }
        }

        // fallback model attempts
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying fallback model ${fallbackModel} with an API key`)
                const content = await sendOnce(key, fallbackModel)

                let parsed: any = null
                try { parsed = JSON.parse(String(content)) } catch {
                    const trimmed = String(content).replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
                    const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
                    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
                    else parsed = JSON.parse(trimmed)
                }
                if (!Array.isArray(parsed)) throw new Error('LLM returned non-array JSON')

                const normalized: GoogleSearch[] = parsed.map((item: any) => {
                    let topic = ''
                    if (typeof item.topic === 'string') topic = item.topic
                    else if (typeof item === 'string') topic = item
                    else if (item && item[0] && typeof item[0] === 'string') topic = item[0]
                    topic = topic.trim().replace(/(^"|"$)/g, '')
                    const words = topic.split(/\s+/).filter(Boolean)
                    const maxWords = /anime|crunchyroll|myanimelist|attack|reincarnated|re:zero/i.test(topic) ? 4 : 3
                    const finalWords = words.slice(0, Math.max(1, Math.min(maxWords, words.length)))
                    let cleaned = finalWords.join(' ').replace(/[^\w\s:-]/g, '').trim()
                    if (cleaned.length > 40) cleaned = cleaned.split(/\s+/).slice(0, 4).join(' ').slice(0, 40).trim()
                    const related = Array.isArray(item.related) ? item.related.map((r: any) => {
                        if (typeof r !== 'string') return ''
                        const rw = r.trim().split(/\s+/).slice(0, 4).join(' ').replace(/[^\w\s-]/g, '').trim()
                        return rw
                    }).filter((r: string) => r.length > 0) : []
                    return { topic: cleaned, related }
                }).filter(x => x.topic && x.topic.length > 0)

                if (normalized.length === 0) throw new Error('LLM returned empty or invalid queries after normalization')

                return normalized
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Fallback model attempt failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'All LLM attempts failed; will allow Trends/local fallback upstream', 'error')
        throw lastErr || new Error('LLM failed')
    }

// --- generateSingleQueryFromLLM ---
    private async generateSingleQueryFromLLM(geoLocale: string = 'US', mode: Mode = 'balanced'): Promise<string | null> {
        const envKey1 = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim()
        const envKey2 = (process.env.OPENROUTER_API_KEY_2 || this.bot.config?.openRouterApiKey2 || '').toString().trim()
        const keys = [envKey1, envKey2].filter(k => !!k)
        if (!keys.length) throw new Error('OpenRouter API key not configured')

        const preferredModel = this.bot.config?.openRouterPreferredModel || 'z-ai/glm-4.5-air:free'
        const fallbackModel = this.bot.config?.openRouterFallbackModel || 'meta-llama/llama-3.3-70b-instruct:free'

        const systemPrompt = `You are an assistant that outputs only one short search query (plain text) a typical undergraduate student might use. Keep it short (3-8 words). Use ${geoLocale.toUpperCase()} locale if relevant. Avoid politics & adult content. Output MUST be only the query string. Mode hint: ${mode}.`
        const userPrompt = `Provide a single concise search query a university undergrad might use.`

        const makeBody = (model: string) => {
            const body: any = {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 60,
                temperature: 0.8
            }

            if (/glm-4.5-air/i.test(model) || /glm-4.5/i.test(model)) {
                const cfg = typeof this.bot.config?.openRouterReasoningEnabled === 'boolean' ? this.bot.config.openRouterReasoningEnabled : true
                body.reasoning = { enabled: !!cfg }
                if (body.reasoning.enabled) {
                    body.reasoning.effort = typeof this.bot.config?.openRouterReasoningEffort === 'string' ? this.bot.config.openRouterReasoningEffort : 'medium'
                    if (typeof this.bot.config?.openRouterReasoningMaxTokens === 'number') {
                        body.reasoning.max_tokens = this.bot.config.openRouterReasoningMaxTokens
                    }
                }
            }

            return body
        }

        const sendOnce = async (apiKey: string, model: string): Promise<string> => {
            const body = makeBody(model)
            const reasoningOn = body.reasoning && body.reasoning.enabled === true
            const timeoutMs = reasoningOn ? (this.bot.config?.openRouterReasoningTimeoutMs || 180000) : 60000

            const requestConfig: AxiosRequestConfig = {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://github.com/tourdefrance',
                    'X-Title': 'TourDeFrance Search Bot'
                },
                data: body,
                timeout: timeoutMs,
                proxy: false
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await axios.request(requestConfig as any)
                    const choice = Array.isArray(resp?.data?.choices) && resp.data.choices.length ? resp.data.choices[0] : null
                    const msg = choice?.message || {}

                    let rawContent: string | undefined
                    if (typeof msg.content === 'string' && msg.content.trim().length) rawContent = msg.content
                    else if (typeof msg.reasoning === 'string' && msg.reasoning.trim().length) rawContent = msg.reasoning
                    else if (msg.reasoning && typeof msg.reasoning === 'object') {
                        try { rawContent = JSON.stringify(msg.reasoning) } catch { rawContent = String(msg.reasoning || '') }
                    } else if (choice && typeof choice.text === 'string' && choice.text.trim().length) rawContent = choice.text
                    else if (typeof resp?.data?.result?.content === 'string' && resp.data.result.content.trim().length) rawContent = resp.data.result.content
                    else if (typeof resp?.data === 'string' && resp.data.trim().length) rawContent = resp.data

                    if (!rawContent || !String(rawContent).trim()) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Single-query LLM returned empty content (attempt ${attempt+1}); status=${resp?.status} body-keys=${resp && typeof resp.data === 'object' ? Object.keys(resp.data) : typeof resp.data}`, 'warn')
                        if (attempt === 0) {
                            await new Promise(res => setTimeout(res, reasoningOn ? 1500 : 300))
                            continue
                        }
                        throw new Error('No content from LLM (empty response)')
                    }
                    return String(rawContent)
                } catch (error: any) {
                    if (error.response) {
                        const status = error.response.status
                        const data = error.response.data
                        throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`)
                    } else if (error.code === 'ECONNABORTED') {
                        throw new Error('Request timeout')
                    } else {
                        if (attempt === 0) {
                            await new Promise(res => setTimeout(res, 500))
                            continue
                        }
                        throw new Error(`Request failed: ${error.message || String(error)}`)
                    }
                }
            }

            // Guarantee a throw if nothing returned
            throw new Error('LLM request failed after retries (single sendOnce)')
        }

        let lastErr: any = null
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying preferred model ${preferredModel}`)
                const raw = await sendOnce(key, preferredModel)
                const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim()
                const cleaned = stripFences(raw).split(/\r?\n/).map(l => l.trim()).filter(l => l.length)[0] || raw.trim()
                const final = cleaned.replace(/(^"|"$)/g, '').trim()
                if (!final || final.length < 2) throw new Error('Parsed query too short')
                return final.length > 200 ? final.slice(0, 200) : final
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Preferred single-query failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            }
        }

        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying fallback model ${fallbackModel}`)
                const raw = await sendOnce(key, fallbackModel)
                const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim()
                const cleaned = stripFences(raw).split(/\r?\n/).map(l => l.trim()).filter(l => l.length)[0] || raw.trim()
                const final = cleaned.replace(/(^"|"$)/g, '').trim()
                if (!final || final.length < 2) throw new Error('Parsed query too short')
                return final.length > 200 ? final.slice(0, 200) : final
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Fallback single-query failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            }
        }

        throw lastErr || new Error('LLM single-query failed')
    }





}

// Types used in this file
type Mode = 'balanced' | 'relaxed' | 'study' | 'food' | 'gaming' | 'news'

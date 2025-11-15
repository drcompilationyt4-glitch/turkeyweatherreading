// src/functions/activities/Search.ts
import { Page } from 'rebrowser-playwright'
import { platform, hostname } from 'os'
import axios, { AxiosRequestConfig } from 'axios'
import { Workers } from '../Workers'
import { Counters, DashboardData } from '../../interface/DashboardData'
import { GoogleSearch } from '../../interface/Search'
// import { getChromeVersion } from "../../util/UserAgent";

type Mode = 'balanced' | 'relaxed' | 'study' | 'food' | 'gaming' | 'news'
type GoogleTrendsResponse = [
    string,
    [
        string,
        ...null[],
        [string, ...string[]]
    ][]
]

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
    // Lightweight in-memory recent-topic cache to reduce repetition across runs (LRU)
    private static recentTopicLRU: string[] = []
    private static recentTopicSet: Set<string> = new Set()
    private static RECENT_CACHE_LIMIT = 500
    // Google Trends cache with timestamp
    private static googleTrendsCache: { queries: GoogleSearch[], timestamp: number, geoLocale: string } | null = null
    private static TRENDS_CACHE_TTL = 1000 * 60 * 300 // 1 hour in milliseconds

    // Updated model configuration with weights
    private readonly modelConfig = [
        { name: 'google/gemini-2.0-flash-exp:free', weight: 0.5, supportsReasoning: false },
        { name: 'deepseek/deepseek-chat-v3-0324:free', weight: 0.5, supportsReasoning: false }
    ]

    constructor(bot: any) {
        super(bot)
    }

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
        // [Previous implementation remains unchanged]
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
        const llmPct = Math.max(0, Math.min(100, this.bot.config.searchSettings?.queryMix?.llmPct ?? 45))
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
        // Put these inside your Search class (adjust visibility as needed)



// In-memory dedupe across runs
    private recentGeneratedQueries: Set<string> = new Set<string>()

// --- Helper: sanitize a raw topic string coming from LLMs / trends / logs ---
    private normalizeTopicString(raw: string): string {
        if (!raw || typeof raw !== 'string') return ''
        let s = raw.trim()

        // Remove common log/provenance prefixes like "33 Points Remaining | Query:"
        s = s.replace(/^\s*\d+\s+Points\s+Remaining\s*\|\s*/i, '')
        const qIdx = s.indexOf('Query:')
        if (qIdx >= 0) s = s.slice(qIdx + 'Query:'.length).trim()

        // Remove code fences and backticks
        s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').replace(/`/g, '').trim()

        // Remove serialized small JSON/snippets that accidentally appear (defensive)
        s = s.replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, '') // remove {...} blocks
        s = s.replace(/\[[^\]]*\]/g, '') // remove [...] fragments

        // Remove repeated "type":"reasoning.text" artifacts
        s = s.replace(/"type"\s*:\s*"reasoning\.text"[^,}]*/gi, '')

        // Collapse whitespace, strip leading/trailing punctuation (but keep internal -/:)
        s = s.replace(/\s+/g, ' ')
        s = s.replace(/^[^\w]+|[^\w]+$/g, '')

        // If numeric or empty return empty
        if (!s || /^\d+$/.test(s)) return ''

        return s.trim()
    }

// --- Helper: create simple variants for a given topic (for diversification) ---
    private makeVariantsForTopic(topic: string, geoLocale: string, maxVariants = 6): string[] {
        const out: string[] = []
        if (!topic || typeof topic !== 'string') return out
        const base = topic.trim()
        if (!base) return out

        const year = new Date().getFullYear().toString()
        const modifiers = [
            `${base} ${year}`,
            `${base} tutorial`,
            `${base} example`,
            `${base} definition`,
            `${base} news`,
            `${base} how to`,
        ]

        // geo-specific modifier
        if (geoLocale && geoLocale !== 'US') modifiers.push(`${base} ${geoLocale}`)
        else modifiers.push(`${base} usa`)

        // ensure normalized + deduped
        const seen = new Set<string>()
        for (const m of modifiers) {
            const nm = this.normalizeTopicString(m)
            if (!nm) continue
            const lk = nm.toLowerCase()
            if (seen.has(lk) || lk === base.toLowerCase()) continue
            seen.add(lk)
            out.push(nm)
            if (out.length >= maxVariants) break
        }

        return out
    }

// --- Helper: pick diversified unique queries from a pool while avoiding usedSet (dedupe across runs) ---
    private pickDiversified(pool: string[], usedSet: Set<string>, desiredCount: number, geoLocale: string): string[] {
        const out: string[] = []
        const chosenLower = new Set<string>()

        const pushIfUnique = (q: string) => {
            if (!q) return false
            const cleaned = this.normalizeTopicString(q)
            if (!cleaned) return false
            const lk = cleaned.toLowerCase()
            if (chosenLower.has(lk)) return false
            if (usedSet && usedSet.has(lk)) return false
            chosenLower.add(lk)
            out.push(cleaned)
            return true
        }

        // 1) prefer pool top-down
        for (const p of pool) {
            if (out.length >= desiredCount) break
            pushIfUnique(p)
        }

        // 2) generate variants from pool items
        for (const p of pool) {
            if (out.length >= desiredCount) break
            const variants = this.makeVariantsForTopic(p, geoLocale, 6)
            for (const v of variants) {
                if (out.length >= desiredCount) break
                pushIfUnique(v)
            }
        }

        // 3) fallback generic modifiers if still short
        const genericAddons = ['tutorial', 'example', 'news', String(new Date().getFullYear())]
        for (const mod of genericAddons) {
            if (out.length >= desiredCount) break
            for (const p of pool) {
                if (out.length >= desiredCount) break
                pushIfUnique(`${p} ${mod}`)
            }
        }

        // 4) last-resort small tweaks
        if (out.length < desiredCount) {
            const lastMods = ['how to', 'guide', 'info', 'tips']
            for (const lm of lastMods) {
                if (out.length >= desiredCount) break
                for (const p of pool) {
                    if (out.length >= desiredCount) break
                    pushIfUnique(`${p} ${lm}`)
                }
            }
        }

        return out.slice(0, desiredCount)
    }

// --- Updated getCachedGoogleTrends with actual use of pickDiversified ---
    private async getCachedGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const now = Date.now()

        // If cache present & valid, return a diversified deep copy using pickDiversified
        if (Search.googleTrendsCache &&
            Search.googleTrendsCache.geoLocale === geoLocale &&
            (now - Search.googleTrendsCache.timestamp) < Search.TRENDS_CACHE_TTL &&
            Array.isArray(Search.googleTrendsCache.queries) &&
            Search.googleTrendsCache.queries.length > 0) {

            const cached = Search.googleTrendsCache.queries
                .map(q => ({
                    topic: this.normalizeTopicString(q.topic ?? (typeof q === 'string' ? String(q) : '')),
                    related: Array.isArray(q.related) ? q.related.map(r => this.normalizeTopicString(String(r))).filter(Boolean) : []
                }))
                .filter(q => !!q.topic)

            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Using cached Google Trends with ${cached.length} queries (diversifying)`)

            // Build a pool of topics (strings) from cached topics (preserve order)
            const pool = cached.map(q => q.topic)

            // Use recentGeneratedQueries as usedSet to avoid repeats across runs (if present)
            const usedSet = (this.recentGeneratedQueries && this.recentGeneratedQueries instanceof Set) ? this.recentGeneratedQueries : new Set<string>()

            // Try to diversify to the same number as cached (so callers expecting size get similar length)
            const desiredCount = Math.max(1, cached.length)

            // pickDiversified will return unique normalized strings
            const diversifiedTopics = this.pickDiversified(pool, usedSet, desiredCount, geoLocale)

            // If diversification succeeded, assemble GoogleSearch[] preserving any related items if original topic matched
            const result: GoogleSearch[] = diversifiedTopics.map(dt => {
                // try to find original related for the exact topic; fallback to empty
                const orig = cached.find(c => c.topic.toLowerCase() === dt.toLowerCase())
                return { topic: dt, related: orig ? [...orig.related] : [] }
            })

            // If for some reason diversification returned empty, fall back to normalized cached entries
            if (!result.length) {
                return cached.map(q => ({ topic: q.topic, related: [...q.related] }))
            }

            return result
        }

        // Cache is empty/expired: fetch fresh trends
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Cache empty/expired, fetching fresh Google Trends data')
        // getGoogleTrends is expected to exist and return GoogleSearch[]
        const freshQueriesRaw = await this.getGoogleTrends(geoLocale)

        // Defensive normalization and cleaning
        const freshQueries: GoogleSearch[] = (Array.isArray(freshQueriesRaw) ? freshQueriesRaw : []).map(q => {
            const topic = this.normalizeTopicString(q.topic ?? (typeof q === 'string' ? String(q) : ''))
            const related = Array.isArray(q.related) ? q.related.map(r => this.normalizeTopicString(String(r))).filter(Boolean) : []
            return { topic, related }
        }).filter(q => q.topic && q.topic.length > 0)

        // Update cache (store normalized copy)
        Search.googleTrendsCache = {
            queries: freshQueries.map(q => ({ topic: q.topic, related: Array.isArray(q.related) ? [...q.related] : [] })),
            timestamp: now,
            geoLocale
        }

        // Return deep copy
        return Search.googleTrendsCache.queries.map(q => ({ topic: q.topic, related: Array.isArray(q.related) ? [...q.related] : [] }))
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
                        const title = rawTitle.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/</g, '<').replace(/>/g, '>').replace(/\s+/g, ' ').trim()
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

    private selectRandomModel(): { name: string, supportsReasoning: boolean } {
        const random = Math.random()
        let cumulativeWeight = 0
        for (const model of this.modelConfig) {
            cumulativeWeight += model.weight
            if (random <= cumulativeWeight) {
                return { name: model.name, supportsReasoning: model.supportsReasoning }
            }
        }
        // Fallback to the first model
        return this.modelConfig[0]!
    }

    private getTimeBasedCategoryWeights(): CategoryWeights {
        const now = new Date()
        const hour = now.getHours()
        const dayOfWeek = now.getDay() // 0 = Sunday, 6 = Saturday
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
        const isAfterSchool = hour >= 15 && hour < 22 // 3 PM - 10 PM
        const isWeekday = !isWeekend
        const isSchoolHours = isWeekday && hour >= 9 && hour < 17

        // Base weights with adjustments based on time and day
        let weights: CategoryWeights = {
            everydayServices: 0.40,  // Higher base probability
            anime: 0.10,
            games: 0.10,
            schoolServices: 0.20,
            csStudent: 0.20
        }

        // Adjust weights based on time and day
        if (isWeekend) {
            // Weekend bias towards entertainment (anime and games)
            weights.anime += 0.15
            weights.games += 0.15
            weights.schoolServices -= 0.10
            weights.csStudent -= 0.10
            weights.everydayServices -= 0.10
        } else if (isAfterSchool) {
            // After school on weekdays - still entertainment focused but less extreme
            weights.anime += 0.10
            weights.games += 0.10
            weights.schoolServices -= 0.05
            weights.csStudent -= 0.05
            weights.everydayServices -= 0.10
        }

        // School hours on weekdays - focus on school and CS
        if (isSchoolHours) {
            weights.schoolServices += 0.15
            weights.csStudent += 0.15
            weights.anime -= 0.10
            weights.games -= 0.10
            weights.everydayServices -= 0.10
        }

        // Evening study time (7-11 PM) - strong CS student focus
        if (hour >= 19 && hour < 23) {
            weights.csStudent += 0.10
            weights.schoolServices += 0.05
            weights.anime -= 0.05
            weights.games -= 0.05
            weights.everydayServices -= 0.05
        }

        // Normalize to ensure total is 1.0
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

        // Select categories based on weights
        const selectedCategory = this.selectWeightedCategory(categories, weights)
        return { systemPrompt: selectedCategory.systemPrompt, userPrompt: selectedCategory.userPrompt }
    }

    private selectWeightedCategory(categories: any[], weights: CategoryWeights): any {
        const rng = Math.random()
        let cumulativeWeight = 0
        for (const category of categories) {
            cumulativeWeight += weights[category.name as keyof CategoryWeights]
            if (rng <= cumulativeWeight) {
                return category
            }
        }
        // Fallback to the first category if something goes wrong
        return categories[0]
    }

    private async generateQueriesWithLLMBatch(
        geoLocale: string,
        desiredCount = 25,
        mode: Mode = 'balanced',
        contextNotes: string = '',
        runSeed?: number
    ): Promise<GoogleSearch[]> {
        // --- Keys & config ---
        const envKey1 = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim();;
        const envKey2 = (process.env.OPENROUTER_API_KEY_2 || this.bot.config?.openRouterApiKey2 || '').toString().trim();
        const openaiKey = (process.env.OPENAI_API_KEY || this.bot.config?.openaiApiKey || '').toString().trim();

        // Prefer explicit OpenAI key if present; otherwise use OpenRouter keys (these are tried in order).
        const keys: string[] = [];
        if (openaiKey) keys.push(openaiKey); // first try official OpenAI key (or set by user)
        [envKey1, envKey2].forEach(k => { if (k) keys.push(k); });

        if (!keys.length) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'OpenRouter/OpenAI API key(s) missing. Set OPENAI_API_KEY or OPENROUTER_API_KEY(s) or bot.config', 'error');
            throw new Error('OpenRouter/OpenAI API key not configured');
        }

        // Model selection
        const selectedModel = this.selectRandomModel();
        const fallbackModel = 'meta-llama/llama-3.3-70b-instruct:free';
        const categoryWeights = this.getTimeBasedCategoryWeights();
        const { systemPrompt, userPrompt } = this.generateCategoryPrompt(categoryWeights, geoLocale);

        const baseMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt.replace('${desiredCount}', desiredCount.toString()) }
        ];

        const maxTokens = Math.min(1600, 90 * desiredCount);

        // Build request bodies (both axios and SDK-compatible shapes)
        const buildRequestBody = (model: string, supportsReasoning: boolean, extraMessages: any[] = []) => {
            const body: any = {
                model,
                messages: [...baseMessages, ...extraMessages],
                max_tokens: maxTokens,
                temperature: 0.6,
                stream: false
            };

            // reasoning options if supported and configured
            const cfgEnable = typeof this.bot.config?.openRouterReasoningEnabled === 'boolean'
                ? this.bot.config.openRouterReasoningEnabled
                : true;
            if (supportsReasoning && cfgEnable) {
                body.reasoning = { enabled: true };
                if (typeof this.bot.config?.openRouterReasoningEffort === 'string') body.reasoning.effort = this.bot.config.openRouterReasoningEffort;
                if (typeof this.bot.config?.openRouterReasoningMaxTokens === 'number') body.reasoning.max_tokens = this.bot.config.openRouterReasoningMaxTokens;
                if (typeof this.bot.config?.openRouterReasoningExclude === 'boolean') body.reasoning.exclude = !!this.bot.config.openRouterReasoningExclude;
            }

            if (this.bot.config && typeof this.bot.config.openRouterProvider !== 'undefined') body.provider = this.bot.config.openRouterProvider;
            if (this.bot.config?.openRouterRequireResponseFormat) body.response_format = { type: 'json_object' };
            if (typeof this.bot.config?.openRouterUserId === 'string') body.user = this.bot.config.openRouterUserId;

            return body;
        };

        // axios client factory for OpenRouter / compatible endpoints
        const createAxiosClient = (apiKey: string, baseURL = 'https://openrouter.ai/api/v1') => axios.create({
            baseURL,
            headers: {
                'Content-Type': 'application/json',
                'HTTP-Referer': this.bot.config?.openRouter?.referer ?? '<YOUR_SITE_URL>',
                'X-Title': this.bot.config?.openRouter?.title ?? '<YOUR_SITE_NAME>',
                'Authorization': `Bearer ${apiKey}`
            },
            proxy: false,
        });

        // Try to dynamically import official OpenAI SDK (optional) to avoid using axios for SDK users
        let OpenAIDefault: any = null;
        try {
            // dynamic import so code works even if SDK not installed
            // For CommonJS and ESM compatibility:
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            OpenAIDefault = await import('openai').then(m => (m && (m as any).default) ? (m as any).default : m);
        } catch {
            OpenAIDefault = null;
        }

        const createOpenAIClient = (apiKey: string, baseURL?: string) => {
            if (!OpenAIDefault) return null;
            // official SDK expects { apiKey, baseURL } in newer versions
            try {
                const options: any = { apiKey };
                if (baseURL) options.baseURL = baseURL;
                if (this.bot.config?.openRouter?.referer) options.defaultHeaders = {
                    'HTTP-Referer': this.bot.config.openRouter.referer,
                    'X-Title': this.bot.config.openRouter.title ?? '<YOUR_SITE_NAME>'
                };
                // instantiate SDK client
                return new OpenAIDefault(options);
            } catch {
                return null;
            }
        };

        // Helper: extract content from a choice / rawData similar to your previous helper
        const extractContentFromChoice = (choice: any, rawData: any): string | null => {
            try {
                const msg = choice?.message ?? {};
                if (typeof msg.content === 'string' && msg.content.trim().length) return msg.content.trim();
                if (msg.content && typeof msg.content === 'object') {
                    const parts = msg.content.parts || msg.content.text || msg.content;
                    if (Array.isArray(parts)) {
                        const combined = parts.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join(' ').trim();
                        if (combined) return combined;
                    } else if (typeof parts === 'string') {
                        return parts.trim();
                    }
                }
                const reasoningObj = msg.reasoning_details ?? msg.reasoning ?? choice?.reasoning_details ?? rawData?.reasoning_details ?? rawData?.reasoning;
                if (reasoningObj) {
                    if (typeof reasoningObj.final_answer === 'string' && reasoningObj.final_answer.trim()) return reasoningObj.final_answer.trim();
                    if (typeof reasoningObj.chain_of_thought === 'string' && reasoningObj.chain_of_thought.trim()) return reasoningObj.chain_of_thought.trim();
                    const asStr = JSON.stringify(reasoningObj);
                    if (asStr && asStr.length) return asStr;
                }
                if (typeof choice?.text === 'string' && choice.text.trim().length) return choice.text.trim();
                if (typeof rawData?.result?.content === 'string' && rawData.result.content.trim().length) return rawData.result.content.trim();
                if (typeof rawData?.content === 'string' && rawData.content.trim().length) return rawData.content.trim();
                if (typeof rawData === 'string' && rawData.trim().length) return rawData.trim();
                if (Array.isArray(rawData?.choices) && rawData.choices.length) {
                    const first = rawData.choices[0];
                    const candidate = first?.message?.content ?? first?.text ?? first?.content;
                    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
                }
            } catch { /* ignore and fallback */ }
            return null;
        };

        const isRateLimit429 = (err: any) => {
            try {
                const status = err?.response?.status;
                const data = err?.response?.data;
                return { ok: status === 429, data };
            } catch { return { ok: false, data: null }; }
        };

        // sendOnce supports either SDK client or axios client. Returns raw string content from model.
        const sendOnce = async (apiKey: string, model: string, supportsReasoning: boolean): Promise<string> => {
            // prefer official SDK if available and apiKey looks like OPENAI key
            const baseURL = this.bot.config?.openRouterBaseURL ?? 'https://openrouter.ai/api/v1';
            const useSDK = !!OpenAIDefault && !!openaiKey && apiKey === openaiKey;
            const openaiClient = useSDK ? createOpenAIClient(apiKey, this.bot.config?.openRouterBaseURL) : null;
            const axiosClient = createAxiosClient(apiKey, baseURL);

            const defaultTimeout = supportsReasoning ? (this.bot.config?.openRouterReasoningTimeoutMs || 240000) : 90000;

            const doAxiosPost = async (payload: any, timeoutMs?: number) => {
                payload.stream = false;
                const cfg: AxiosRequestConfig = {
                    url: '/chat/completions',
                    method: 'POST',
                    data: payload,
                    timeout: timeoutMs ?? defaultTimeout,
                    proxy: false
                };
                return axiosClient.request(cfg as any);
            };

            // Helper to extract SDK/axios response consistently
            const extractFromResp = (resp: any) => {
                // axios response: resp.data
                const data = resp?.data ?? resp;
                const choice = Array.isArray(data?.choices) && data.choices.length ? data.choices[0] : null;
                return extractContentFromChoice(choice, data);
            };

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    if (supportsReasoning) {
                        // Step 1: initial reasoning call
                        const payload1: any = buildRequestBody(model, true, []);
                        if (!payload1.reasoning) payload1.reasoning = { enabled: true };

                        let resp1: any;
                        if (openaiClient) {
                            // SDK path
                            resp1 = await (openaiClient.chat?.completions?.create
                                ? openaiClient.chat.completions.create(payload1)
                                : openaiClient.createChatCompletion?.(payload1)); // try different SDK shapes
                        } else {
                            resp1 = await doAxiosPost(payload1);
                        }

                        const choice1 = (resp1?.data ?? resp1)?.choices?.[0] ?? null;
                        const assistantMsg = choice1?.message ?? null;
                        const assistantContent = extractFromResp(resp1);
                        if (!assistantMsg || !assistantContent) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `First reasoning call returned empty (attempt ${attempt + 1})`, 'warn');
                            if (attempt === 0) {
                                await new Promise(r => setTimeout(r, 800));
                                continue;
                            }
                            throw new Error('Empty result from first reasoning call');
                        }

                        // preserve assistant message for follow-up
                        const preservedAssistant: any = {
                            role: 'assistant',
                            content: typeof assistantMsg.content === 'string' ? assistantMsg.content : (assistantContent || assistantMsg.content || '')
                        };
                        if (assistantMsg.reasoning_details) preservedAssistant.reasoning_details = assistantMsg.reasoning_details;
                        if (assistantMsg.reasoning) preservedAssistant.reasoning = assistantMsg.reasoning;
                        if (choice1?.reasoning_details) preservedAssistant.reasoning_details = preservedAssistant.reasoning_details ?? choice1.reasoning_details;

                        const followupUser = {
                            role: 'user',
                            content: `Are you sure? Think carefully and provide the concise final queries (exactly ${desiredCount} items). ${contextNotes || ''}`
                        };

                        const payload2: any = {
                            model,
                            messages: [...baseMessages, preservedAssistant, followupUser],
                            max_tokens: Math.min(1024, maxTokens),
                            temperature: 0.45,
                            stream: false
                        };
                        if (this.bot.config && typeof this.bot.config.openRouterProvider !== 'undefined') payload2.provider = this.bot.config.openRouterProvider;
                        if (this.bot.config?.openRouterRequireResponseFormat) payload2.response_format = { type: 'json_object' };
                        if (this.bot.config?.openRouterReasoningEnabled) payload2.reasoning = { enabled: true };

                        let resp2: any;
                        if (openaiClient) {
                            resp2 = await (openaiClient.chat?.completions?.create
                                ? openaiClient.chat.completions.create(payload2)
                                : openaiClient.createChatCompletion?.(payload2));
                        } else {
                            resp2 = await doAxiosPost(payload2);
                        }

                        const finalContent = extractFromResp(resp2);
                        if (finalContent && String(finalContent).trim().length) {
                            return String(finalContent);
                        } else {
                            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Second reasoning continuation returned empty (attempt ${attempt + 1})`, 'warn');
                            if (attempt === 0) {
                                await new Promise(r => setTimeout(r, 800));
                                continue;
                            }
                            throw new Error('Empty result from reasoning continuation call');
                        }
                    } else {
                        // non-reasoning single-call flow
                        const payload = buildRequestBody(model, false);
                        if (this.bot.config && typeof this.bot.config.openRouterProvider !== 'undefined') payload.provider = this.bot.config.openRouterProvider;
                        if (this.bot.config?.openRouterRequireResponseFormat) payload.response_format = { type: 'json_object' };
                        payload.stream = false;

                        let resp: any;
                        if (openaiClient) {
                            resp = await (openaiClient.chat?.completions?.create
                                ? openaiClient.chat.completions.create(payload)
                                : openaiClient.createChatCompletion?.(payload));
                        } else {
                            resp = await doAxiosPost(payload);
                        }

                        const content = extractFromResp(resp);
                        if (content && String(content).trim().length) return String(content);

                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Non-reasoning model returned empty content (attempt ${attempt + 1})`, 'warn');
                        if (attempt === 0) {
                            await new Promise(r => setTimeout(r, 500));
                            continue;
                        }
                        throw new Error('No content from non-reasoning model');
                    }
                } catch (err: any) {
                    const rl = isRateLimit429(err);
                    if (rl.ok) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `HTTP 429 (upstream rate limit): ${JSON.stringify(rl.data)}`, 'warn');
                        await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 400)));
                        throw new Error(`HTTP 429: ${JSON.stringify(rl.data)}`);
                    }
                    if (err?.response) {
                        const status = err.response.status;
                        const data = err.response.data;
                        // special-case OpenRouter privacy 404 message
                        try {
                            const message = typeof data?.error?.message === 'string' ? data.error.message : JSON.stringify(data);
                            if (message && message.toLowerCase().includes('zero data retention')) {
                                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `OpenRouter privacy settings blocking endpoints: ${message}`, 'error');
                            }
                        } catch { /* ignore */ }

                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `HTTP ${status} error: ${JSON.stringify(data)}`, 'error');
                        throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
                    } else if (err.code === 'ECONNABORTED') {
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'Request timeout', 'warn');
                        throw new Error('Request timeout');
                    } else {
                        if (this.isRetryableError && this.isRetryableError(err) && attempt === 0) {
                            await new Promise(r => setTimeout(r, 500));
                            continue;
                        }
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Request failed: ${String(err?.message ?? err)}`, 'warn');
                        throw new Error(`Request failed: ${err?.message || String(err)}`);
                    }
                } // end try/catch
            } // end attempts

            throw new Error('LLM request failed after retries (sendOnce)');
        }; // end sendOnce

        // --- Normalization & fallback parsing (same logic as you had) ---
        const tryNormalizeWithFallbacks = (rawContent: string): GoogleSearch[] => {
            let content = String(rawContent ?? '').trim();
            try {
                const qIdx = content.indexOf('Query:');
                if (qIdx >= 0) {
                    const after = content.slice(qIdx + 'Query:'.length).trim();
                    if (/^[\[{]/.test(after)) content = after;
                }
                content = content.replace(/^\s*\d+\s+Points\s+Remaining\s*\|/i, '').trim();
            } catch { /* ignore */ }

            try {
                const normalized = this.parseAndNormalizeLLMResponse(content);
                if (Array.isArray(normalized) && normalized.length > 0) return normalized;
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `parseAndNormalizeLLMResponse failed: ${String(e)}`, 'warn');
            }

            try {
                const s = String(content).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
                const normalized = this.parseAndNormalizeLLMResponse(s);
                if (Array.isArray(normalized) && normalized.length > 0) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'Fallback: parsed after stripping fences', 'warn');
                    return normalized;
                }
            } catch { /* fallthrough */ }

            try {
                const m = String(content).match(/\[[\s\S]*\]/);
                if (m && m[0]) {
                    try {
                        const parsed = JSON.parse(m[0]);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            const normalized = this.parseAndNormalizeLLMResponse(JSON.stringify(parsed));
                            if (Array.isArray(normalized) && normalized.length > 0) return normalized;
                        }
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }

            const lines = String(content).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            if (lines.length > 0) {
                const candidates = lines.slice(0, desiredCount).map(l => {
                    const cleaned = l.replace(/^[\-\*\d\.\)\s]+/, '').replace(/^"|"$/g, '').trim();
                    return { topic: cleaned, related: [] as string[] };
                });
                if (candidates.length > 0) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'Fallback: used newline-split to derive queries', 'warn');
                    return candidates as GoogleSearch[];
                }
            }

            if (desiredCount === 1) {
                const plain = String(content).trim().replace(/["`]/g, '');
                const firstLine = plain.split(/\r?\n/).find(Boolean) ?? plain;
                if (firstLine && firstLine.length > 0) {
                    const words = firstLine.trim().split(/\s+/).slice(0, 4).join(' ');
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'Fallback: single-item plain text accepted', 'warn');
                    return [{ topic: words, related: [] }];
                }
            }

            throw new Error('LLM returned empty or invalid queries after normalization');
        };

        // --- Attempt phases: selected model, alternative models, fallback model ---
        let lastErr: any = null;

        // Phase 1: try selected model with available keys (keys ordered: openaiKey first if present)
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying selected model ${selectedModel.name} with reasoning=${selectedModel.supportsReasoning}`);
                const content = await sendOnce(key, selectedModel.name, selectedModel.supportsReasoning);
                const normalized = tryNormalizeWithFallbacks(content);
                if (normalized.length > 0) return normalized;
                throw new Error('LLM returned empty or invalid queries after normalization (post-fallbacks)');
            } catch (err) {
                lastErr = err;
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Selected model attempt failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
            }
        }

        // Phase 2: try other models from modelConfig
        const otherModels = this.modelConfig.filter((m: any) => m.name !== selectedModel.name);
        for (const model of otherModels) {
            for (const key of keys) {
                try {
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying alternative model ${model.name}`);
                    const content = await sendOnce(key, model.name, model.supportsReasoning);
                    const normalized = tryNormalizeWithFallbacks(content);
                    if (normalized.length > 0) return normalized;
                    throw new Error('LLM returned empty or invalid queries after normalization (post-fallbacks)');
                } catch (err) {
                    lastErr = err;
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Alternative model ${model.name} failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
                }
            }
        }

        // Phase 3: fallback llama model attempts
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying fallback model ${fallbackModel}`);
                const content = await sendOnce(key, fallbackModel, false);
                const normalized = tryNormalizeWithFallbacks(content);
                if (normalized.length > 0) return normalized;
                throw new Error('LLM returned empty or invalid queries after normalization (post-fallbacks)');
            } catch (err) {
                lastErr = err;
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Fallback model failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'All LLM attempts failed; will allow Trends/local fallback upstream', 'error');
        throw lastErr || new Error('LLM failed - all models exhausted');
    }

    /**
     * Helper method to parse and normalize LLM responses
     */
    private parseAndNormalizeLLMResponse(content: string): GoogleSearch[] {
        // Defensive normalization of many possible LLM output shapes into GoogleSearch[]
        const safeParseJson = (s: string): any | null => {
            try { return JSON.parse(s) } catch { return null }
        }

        const stripFences = (s: string) => String(s).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
        const firstJsonArrayInText = (s: string): any | null => {
            const m = String(s).match(/\[[\s\S]*\]/)
            if (!m) return null
            return safeParseJson(m[0])
        }

        const raw = String(content ?? '').trim()
        let parsed: any = null

        // 1) Try direct JSON parse
        parsed = safeParseJson(raw)

        // 2) Try after stripping fences
        if (parsed === null) parsed = safeParseJson(stripFences(raw))

        // 3) Try extracting a JSON array from anywhere in the text
        if (parsed === null) parsed = firstJsonArrayInText(raw)

        // 4) Some LLMs return arrays/objects embedded in text: try to parse JSON object fragments
        if (parsed === null) {
            try {
                const maybe = raw.match(/\{(?:[^{}]|\{[^{}]*\})*\}/g)
                if (maybe && maybe.length) {
                    for (const chunk of maybe) {
                        const obj = safeParseJson(chunk)
                        if (obj && (Array.isArray(obj) || typeof obj === 'object')) {
                            parsed = obj
                            break
                        }
                    }
                }
            } catch { /* ignore */ }
        }

        // 5) If it's an object that contains common array fields, extract them
        if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
            if (Array.isArray(parsed.queries)) parsed = parsed.queries
            else if (Array.isArray(parsed.default)) parsed = parsed.default
            else if (Array.isArray(parsed.items)) parsed = parsed.items
            else if (Array.isArray(parsed.results)) parsed = parsed.results
            else if (Array.isArray(parsed.topics)) parsed = parsed.topics
            else if (Array.isArray(parsed.Query)) parsed = parsed.Query
            else {
                // Maybe object where keys are topics: { "topic1": {}, "topic2": {} } -> make array of keys
                const keys = Object.keys(parsed).filter(k => typeof parsed[k] === 'object' || typeof parsed[k] === 'string')
                if (keys.length) {
                    parsed = keys
                } else {
                    // leave as-is for fallback to plain-text parsing
                    parsed = null
                }
            }
        }

        // 6) If still null, attempt newline / bullet parsing (plain text lists)
        if (parsed === null) {
            const lines = stripFences(raw)
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => l.length > 0)
            // Remove lines that look like metadata (e.g. "title:" or "subtitle:")
            const filtered = lines.filter(l => !/^[a-z0-9_-]+:\s*/i.test(l) && !/^#+\s*/.test(l))
            if (filtered.length > 0) parsed = filtered
        }

        // 7) Last fallback: treat entire raw string as single topic
        if (parsed === null) parsed = [raw]

        // Ensure we have an array now
        if (!Array.isArray(parsed)) throw new Error('LLM returned non-array JSON or unparsable content')

        // Normalize each entry into GoogleSearch { topic: string, related: string[] }
        const normalizeItem = (item: any): GoogleSearch | null => {
            let topicRaw = ''
            let relatedRaw: any[] = []

            // If item looks like an array of reasoning tokens: [{ type: 'reasoning.text', text: '...' }, ...]
            if (Array.isArray(item) && item.length && typeof item[0] === 'object' && ('type' in item[0])) {
                // Safely extract text-like fields from each token
                const texts: string[] = item.map((it: any) => {
                    if (!it) return ''
                    if (typeof it.text === 'string' && it.text.trim()) return it.text.trim()
                    if (typeof it.content === 'string' && it.content.trim()) return it.content.trim()
                    if (typeof it.message === 'string' && it.message.trim()) return it.message.trim()
                    if (typeof it === 'string' && it.trim()) return it.trim()
                    // try nested fields
                    if (it?.message?.content && typeof it.message.content === 'string') return it.message.content.trim()
                    return ''
                }).filter(Boolean)
                const combined: string = texts.join(' ').trim()
                if (combined.length > 0) {
                    const firstLine = combined.split(/\r?\n/)[0] ?? combined
                    return { topic: firstLine.slice(0, 80), related: [] }
                }
            }

            if (typeof item === 'string') {
                // some strings might include JSON-like fragments; keep whole string for later cleaning
                topicRaw = item
            } else if (Array.isArray(item)) {
                // array like ["topic", "related1", ...] — take first as topic, rest as related
                if (item.length === 0) return null
                const first = item[0]
                topicRaw = typeof first === 'string' ? first : (first?.text ?? first?.content ?? '')
                relatedRaw = item.slice(1).map((r: any) => typeof r === 'string' ? r : (r?.text ?? r?.content ?? ''))
            } else if (item && typeof item === 'object') {
                // object shapes: { topic: "...", related: [...] } or { query: "...", queries: [...] }
                if (typeof item.topic === 'string') topicRaw = item.topic
                else if (typeof item.query === 'string') topicRaw = item.query
                else if (typeof item.title === 'string') topicRaw = item.title
                else if (typeof item.text === 'string') topicRaw = item.text
                else if (typeof item.content === 'string') topicRaw = item.content
                else if (typeof item[0] === 'string') topicRaw = item[0]

                // collect related fields
                if (Array.isArray(item.related)) relatedRaw = item.related
                else if (Array.isArray(item.queries)) relatedRaw = item.queries
                else if (Array.isArray(item.suggestions)) relatedRaw = item.suggestions
                else if (typeof item.suggestions === 'string') relatedRaw = [item.suggestions]
                else relatedRaw = []

                // special-case: some objects are reasoning fragments with shape { type: 'reasoning.text', text: '...' }
                if (!topicRaw && (item.type === 'reasoning.text' || item.type === 'text')) {
                    topicRaw = item.text ?? item.content ?? ''
                }
            } else {
                return null
            }

            if (!topicRaw || typeof topicRaw !== 'string') return null

            // Clean and trim the topic
            let topic = topicRaw.trim()
            // remove bullets/numbering prefixes
            topic = topic.replace(/^[\-\*\•\d\.\)\s]+/, '').replace(/^"|"$/g, '').trim()
            // remove surrounding punctuation but keep internal hyphens and colons
            topic = topic.replace(/^[^\w]+|[^\w]+$/g, '')

            // Word-limits: anime-related topics allow up to 4 words, otherwise 3 (configurable heuristics)
            const animeRegex = /anime|crunchyroll|myanimelist|re:? ?zero|isekai|reincarnat/i
            const maxWords = animeRegex.test(topic.toLowerCase()) ? 4 : 3
            const words = topic.split(/\s+/).filter(Boolean).slice(0, maxWords)
            let cleaned = words.join(' ').replace(/[^\w\s:-]/g, '').trim()

            // enforce a reasonable length cap (40 chars) and max 4 words
            if (cleaned.length > 40) {
                cleaned = cleaned.split(/\s+/).slice(0, 4).join(' ').slice(0, 40).trim()
            }

            if (!cleaned) return null

            // Normalize related items: take up to 4 words per related entry, remove weird chars
            const related: string[] = Array.isArray(relatedRaw) ? relatedRaw.map((r: any) => {
                if (typeof r !== 'string') return ''
                let rr = r.trim().replace(/^[\-\*\d\.\)\s]+/, '').replace(/[^\w\s-]/g, '')
                rr = rr.split(/\s+/).slice(0, 4).join(' ').trim()
                return rr
            }).filter(Boolean) : []

            return { topic: cleaned, related }
        }

        // Map and filter
        const normalized: GoogleSearch[] = parsed.map((p: any) => normalizeItem(p)).filter(Boolean) as GoogleSearch[]

        if (!Array.isArray(normalized) || normalized.length === 0) {
            throw new Error('LLM returned empty or invalid queries after normalization')
        }

        return normalized
    }



    /**
     * Helper method to determine if an error is retryable
     */
    private isRetryableError(err: any): boolean {
        if (!err) return false
        const msg = String(err.message || '')
        return msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('ECONNABORTED') ||
            msg.includes('ETIMEDOUT') || msg.includes('NETWORK_ERROR')
    }

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
                temperature: 0.8,
                proxy: false
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
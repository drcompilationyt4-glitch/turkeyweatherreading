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

        // Generate search queries (LLM primary, Trends fill)
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
     *  - Configurable LLM / Trends mix
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
        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Generating ${desiredCount} queries (LLM primary, Trends fill; local fills missing)`)

        // 75% LLM (rounded up), remaining Trends
        const llmPct = Math.max(0, Math.min(100, this.bot.config.searchSettings?.queryMix?.llmPct ?? 75))
        const llmCount = Math.max(0, Math.ceil(desiredCount * (llmPct / 100)))
        const trendsCount = Math.max(0, desiredCount - llmCount)

        // 1) Attempt LLM batch first
        let llmQueries: GoogleSearch[] = []
        try {
            if (llmCount > 0) {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Attempting LLM batch for ${llmCount} queries`)
                llmQueries = await this.getEnhancedLLMQueries(geoLocale, llmCount, mode, runSeed)
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `LLM returned ${llmQueries.length} items`)
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `LLM batch failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            // per-search fallback if enabled
            if (this.bot.config.searchSettings?.enablePerSearchFallback) {
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
            }
        }

        // 2) Attempt Trends (only for the number of remaining slots)
        let trendsQueries: GoogleSearch[] = []
        if (trendsCount > 0) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Fetching Google Trends (up to ${trendsCount})`)
                const gt = await this.getGoogleTrends(geoLocale)
                if (gt.length) {
                    trendsQueries = this.bot.utils.shuffleArray(gt).slice(0, trendsCount)
                    this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Google trends returned ${gt.length} items, sampled ${trendsQueries.length}`)
                } else {
                    throw new Error('No usable Google trends')
                }
            } catch (tErr) {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Google Trends fetch failed (non-fatal): ${tErr instanceof Error ? tErr.message : String(tErr)}`, 'warn')
                // Fallback to Reddit if Google Trends fails
                try {
                    this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Falling back to Reddit Trends (up to ${trendsCount})`)
                    const rawTrends = await this.getRedditTrends(geoLocale)
                    if (Array.isArray(rawTrends) && rawTrends.length) {
                        trendsQueries = this.bot.utils.shuffleArray(rawTrends).slice(0, trendsCount)
                        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Reddit trends returned ${rawTrends.length} items, sampled ${trendsQueries.length}`)
                    } else {
                        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Reddit trends returned no usable items', 'warn')
                    }
                } catch (rErr) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Reddit Trends fetch failed (non-fatal): ${rErr instanceof Error ? rErr.message : String(rErr)}`, 'warn')
                }
            }
        }

        // 3) Combine according to rules:
        const combined: GoogleSearch[] = []
        const seen = new Set<string>()

        const pushIfUnique = (q: GoogleSearch) => {
            if (!q?.topic) return false
            const key = q.topic.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (!key || seen.has(key)) return false
            seen.add(key)
            combined.push(q)
            return true
        }

        if (llmQueries && llmQueries.length > 0) {
            // Keep LLM items first (up to desiredCount)
            for (const q of llmQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(q)
            }

            // Now append trends up to remaining slots
            for (const t of trendsQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(t)
            }

            // If still short, fill missing with local queries (do NOT discard LLM)
            if (combined.length < desiredCount) {
                const missing = desiredCount - combined.length
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `Trends insufficient — topping up ${missing} from local fallback`)
                const localCandidates = await this.getLocalQueriesFallback(Math.max(missing, 5))
                for (const l of localCandidates) {
                    if (combined.length >= desiredCount) break
                    pushIfUnique(l)
                }
            }
        } else {
            // LLM returned nothing — use trends first, then local
            for (const t of trendsQueries) {
                if (combined.length >= desiredCount) break
                pushIfUnique(t)
            }
            if (combined.length < desiredCount) {
                const missing = desiredCount - combined.length
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `LLM empty — filling ${missing} from local fallback`)
                const localCandidates = await this.getLocalQueriesFallback(Math.max(missing, 5))
                for (const l of localCandidates) {
                    if (combined.length >= desiredCount) break
                    pushIfUnique(l)
                }
            }
        }

        // 4) If still somehow empty (extremely unlikely), return local fallback unconditionally
        if (combined.length === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'No queries from LLM/Trends/local attempt — using local fallback (final)', 'warn')
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

    /**
     * Batch LLM request: ask OpenRouter (or compatible) for JSON array of queries.
     * Returns normalized GoogleSearch[]
     */
    private async generateQueriesWithLLMBatch(
        geoLocale: string,
        desiredCount = 25,
        mode: Mode = 'balanced',
        contextNotes: string = '',
        runSeed?: number
    ): Promise<GoogleSearch[]> {
        // --- START: Updated to support two OpenRouter API keys and preferred/fallback models ---
        const envKey1 = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim()
        const envKey2 = (process.env.OPENROUTER_API_KEY_2 || this.bot.config?.openRouterApiKey2 || '').toString().trim()

        const keys = [envKey1, envKey2].filter(k => !!k)
        if (!keys.length) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'OpenRouter API key(s) missing. Set OPENROUTER_API_KEY and/or OPENROUTER_API_KEY_2 or bot.config.openRouterApiKey', 'error')
            throw new Error('OpenRouter API key not configured')
        }

        // Preferred (better but less stable) model and fallback (original) model.
        // You can override via bot.config.openRouterPreferredModel / openRouterFallbackModel
        const preferredModel = this.bot.config?.openRouterPreferredModel || 'minimax/minimax-m2:free'
        const fallbackModel = this.bot.config?.openRouterFallbackModel || 'meta-llama/llama-3.3-70b-instruct:free'

        // Use runSeed to choose examples deterministically
        const rng = this.seededRng(runSeed ?? this.getRunSeed())
        const realisticPatterns = [
            'Instead of generic "cheap food near me", use specific examples like "McDonald\'s delivery promo" or "best sushi near campus"',
            'Avoid repetitive phrasing - vary between questions ("How to..."), commands ("Find..."), and direct requests ("Best pizza in [city]")',
            'Incorporate day-specific context: weekday = academic/work, weekend = entertainment/leisure',
            'Add location context naturally: "near campus", "downtown", "in [city]"'
        ]

        const systemPrompt = `You are an assistant that outputs a JSON array only. Each item must be an object with:
- "topic": a short search query a typical university student might type.
- "related": an array of 0..6 related searches (short strings).

Return up to ${desiredCount} diverse items if possible. Avoid politically sensitive & adult topics. Output must be valid JSON only (no explanatory text). Use ${geoLocale.toUpperCase()} locale where relevant. Be varied and avoid repeating the same simple phrases (e.g., don't output "cheap food near me" repeatedly). This request context: ${contextNotes}. Use the style guidance: ${realisticPatterns[Math.floor(rng() * realisticPatterns.length)]}. For mode: ${mode}.`

        const userPrompt = `Generate up to ${desiredCount} concise search queries a university undergrad might use.`

        // Build the messages and body template (we'll swap model)
        const baseMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]

        const maxTokens = Math.min(1600, 90 * desiredCount)

        // Helper to send one request with given key+model
        const sendOnce = async (apiKey: string, model: string) => {
            const body = {
                model,
                messages: baseMessages,
                max_tokens: maxTokens,
                temperature: 0.8
            }

            const requestConfig: AxiosRequestConfig = {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                data: body,
                timeout: 25000,
                proxy: false // ensure no proxy
            }

            const resp = await axios.request(requestConfig as any)
            let content: string | undefined
            const choices = resp?.data?.choices
            if (Array.isArray(choices) && choices.length) {
                content = choices[0]?.message?.content || choices[0]?.text
            } else if (typeof resp?.data === 'string') {
                content = resp.data
            } else if (resp?.data?.result?.content) {
                content = resp.data.result.content
            }

            if (!content) throw new Error('No content from LLM')
            return content
        }

        // Sequence: preferredModel with key1, preferredModel with key2, fallbackModel with key1, fallbackModel with key2
        let lastErr: any = null
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying preferred model ${preferredModel} with one of the API keys`)
                const content = await sendOnce(key, preferredModel)
                // parse & normalize result (same logic as before)
                let parsed: any
                try {
                    parsed = JSON.parse(String(content))
                } catch (e) {
                    const trimmed = String(content).replace(/```json(?:\n)?/g, '').replace(/```/g, '')
                    parsed = JSON.parse(trimmed)
                }

                if (!Array.isArray(parsed)) throw new Error('LLM returned non-array JSON')

                const normalized: GoogleSearch[] = parsed.map((item: any) => {
                    const topic = typeof item.topic === 'string' ? item.topic : (typeof item === 'string' ? item : '')
                    const related = Array.isArray(item.related) ? item.related.filter((r: any) => typeof r === 'string') : []
                    return { topic, related }
                }).filter(x => x.topic && x.topic.length > 1)

                return normalized
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Preferred model attempt with a key failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
                // try next key
            }
        }

        // If preferred model failed for both keys, try fallback model
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying fallback model ${fallbackModel} with one of the API keys`)
                const content = await sendOnce(key, fallbackModel)
                // parse & normalize result (same logic as before)
                let parsed: any
                try {
                    parsed = JSON.parse(String(content))
                } catch (e) {
                    const trimmed = String(content).replace(/```json(?:\n)?/g, '').replace(/```/g, '')
                    parsed = JSON.parse(trimmed)
                }

                if (!Array.isArray(parsed)) throw new Error('LLM returned non-array JSON')

                const normalized: GoogleSearch[] = parsed.map((item: any) => {
                    const topic = typeof item.topic === 'string' ? item.topic : (typeof item === 'string' ? item : '')
                    const related = Array.isArray(item.related) ? item.related.filter((r: any) => typeof r === 'string') : []
                    return { topic, related }
                }).filter(x => x.topic && x.topic.length > 1)

                return normalized
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Fallback model attempt with a key failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
                // try next key
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'All OpenRouter attempts failed, throwing to allow fallback', 'error')
        throw lastErr || new Error('LLM failed')
        // --- END: Updated ---
    }

    // private getRepetitivePatternsWarning(rng?: () => number): string {
    //     const warnings = [
    //         '"cheap food near me" → use specific examples like "Chipotle catering options" or "best sushi in [city]"',
    //         '"how to" → vary with "tips for", "guide to", "best way to", or just the topic itself',
    //         'Always include natural location context when relevant (e.g., "near campus", "downtown", "in [city]")',
    //         'Mix question format and direct search terms for diversity'
    //     ];
    //
    //     if (!warnings.length) return ''
    //
    //     const idx = typeof rng === 'function'
    //         ? Math.floor(Math.max(0, Math.min(0.999999, rng())) * warnings.length)
    //         : Math.floor(Math.random() * warnings.length)
    //
    //     return (warnings[idx] ?? warnings[0]) as string
    // }

    /**
     * Single-query LLM generation (used in per-search mode or per-search fallback).
     * Returns single string or null.
     */
    private async generateSingleQueryFromLLM(geoLocale: string = 'US', mode: Mode = 'balanced'): Promise<string | null> {
        // --- START: Updated to support two API keys + preferred/fallback model sequence ---
        const envKey1 = (process.env.OPENROUTER_API_KEY || this.bot.config?.openRouterApiKey || '').toString().trim()
        const envKey2 = (process.env.OPENROUTER_API_KEY_2 || this.bot.config?.openRouterApiKey2 || '').toString().trim()
        const keys = [envKey1, envKey2].filter(k => !!k)
        if (!keys.length) throw new Error('OpenRouter API key not configured')

        const preferredModel = this.bot.config?.openRouterPreferredModel || 'minimax/minimax-m2:free'
        const fallbackModel = this.bot.config?.openRouterFallbackModel || 'meta-llama/llama-3.3-70b-instruct:free'

        const systemPrompt = `You are an assistant that outputs only one short search query (plain text) a typical undergraduate student might type. Keep it short (3-8 words). Use ${geoLocale.toUpperCase()} locale if relevant. Avoid politics & adult content. Output MUST be only the query string. Mode hint: ${mode}.`
        const userPrompt = `Provide a single concise search query a university undergrad might use.`

        const makeBody = (model: string) => ({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 60,
            temperature: 0.8
        })

        const sendOnce = async (apiKey: string, model: string) => {
            const requestConfig: AxiosRequestConfig = {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                data: makeBody(model),
                timeout: 15000,
                proxy: false
            }
            const resp = await axios.request(requestConfig as any)
            const choices = resp?.data?.choices
            let rawContent = choices?.[0]?.message?.content || choices?.[0]?.text || (typeof resp?.data === 'string' ? resp.data : undefined)
            if (!rawContent) throw new Error('No content from LLM')
            return String(rawContent)
        }

        // Try preferred model with key1 then key2
        let lastErr: any = null
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying preferred model ${preferredModel} for single-query with a key`)
                const raw = await sendOnce(key, preferredModel)
                const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim()
                const cleanedLines = stripFences(raw).split(/\r?\n/).map(l => l.trim()).filter(l => l.length)
                const candidate = cleanedLines.length ? cleanedLines[0] : String(raw).trim()
                const final = String(candidate).replace(/(^"|"$)/g, '').trim()
                if (!final || final.length < 2) throw new Error('Parsed query too short')
                return final.length > 200 ? final.slice(0, 200) : final
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Preferred single-query attempt failed with a key: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            }
        }

        // Try fallback model with key1 then key2
        for (const key of keys) {
            try {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Trying fallback model ${fallbackModel} for single-query with a key`)
                const raw = await sendOnce(key, fallbackModel)
                const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim()
                const cleanedLines = stripFences(raw).split(/\r?\n/).map(l => l.trim()).filter(l => l.length)
                const candidate = cleanedLines.length ? cleanedLines[0] : String(raw).trim()
                const final = String(candidate).replace(/(^"|"$)/g, '').trim()
                if (!final || final.length < 2) throw new Error('Parsed query too short')
                return final.length > 200 ? final.slice(0, 200) : final
            } catch (err) {
                lastErr = err
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Fallback single-query attempt failed with a key: ${err instanceof Error ? err.message : String(err)}`, 'warn')
            }
        }

        throw lastErr || new Error('LLM single-query failed')
        // --- END: Updated ---
    }
}

// Types used in this file
type Mode = 'balanced' | 'relaxed' | 'study' | 'food' | 'gaming' | 'news'

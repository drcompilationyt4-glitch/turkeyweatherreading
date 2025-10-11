import { Page } from 'rebrowser-playwright'
import { platform } from 'os'
import https from 'https'

import { Workers } from '../Workers'

import { Counters, DashboardData } from '../../interface/DashboardData'
import { GoogleSearch } from '../../interface/Search'
import { AxiosRequestConfig } from 'axios'

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

    // store last response status for diagnostics
    private _lastOpenRouterStatusCode?: number

    public async doSearch(page: Page, data: DashboardData) {
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

        // --- LLM FIRST, FALLBACK TO TRENDS + LOCAL ---
        const geo = this.bot.config.searchSettings.useGeoLocaleQueries ? (data?.userProfile?.attributes?.country || 'US') : 'US'
        let googleSearchQueries: GoogleSearch[] = await this.getSearchQueries(geo)

        // Fallback: if trends/LLM failed or insufficient, sample from local queries file (extra safety)
        if (!googleSearchQueries.length || googleSearchQueries.length < 10) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Primary queries insufficient, falling back to local queries.json', 'warn')
            try {
                const local = await import('../queries.json')
                const sampleSize = Math.max(5, Math.min(this.bot.config.searchSettings.localFallbackCount || 25, (local.default || []).length))
                const sampled = this.bot.utils.shuffleArray(local.default || []).slice(0, sampleSize)
                googleSearchQueries = sampled.map((x: { title: string; queries: string[] }) => ({ topic: x.queries?.[0] || x.title, related: x.queries?.slice(1) || [] }))
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed loading local queries fallback: ' + (e instanceof Error ? e.message : String(e)), 'error')
            }
        }

        // Shuffle and dedupe topics
        googleSearchQueries = this.bot.utils.shuffleArray(googleSearchQueries)
        const seen = new Set<string>()
        googleSearchQueries = googleSearchQueries.filter(q => {
            if (!q || !q.topic) return false
            const k = q.topic.toLowerCase()
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

        // Loop over Google search queries
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
            const extraRetries = this.bot.config.searchSettings.extraFallbackRetries || 1
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
                await box.waitFor({ state: 'attached', timeout: 15000 })

                // Try dismissing overlays before interacting
                await this.bot.browser.utils.tryDismissAllMessages(searchPage)
                await this.bot.utils.wait(200)

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

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(resultPage)
                }

                if (this.bot.config.searchSettings.clickRandomResults) {
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

    // === LLM-FIRST QUERY GENERATION (with fallbacks) ===
    private async getSearchQueries(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        // 60% chance used previously in other code, but here we will attempt LLM first always.
        this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Attempting LLM-based query generation (primary path)')

        try {
            const llmResult = await this.generateQueriesWithLLM(geoLocale)

            if (Array.isArray(llmResult) && llmResult.length > 0) {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', `LLM returned ${llmResult.length} queries`)
                return llmResult
            } else {
                this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'LLM returned empty/invalid result, falling back to Google Trends', 'warn')
            }
        } catch (err) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'LLM generation failed: ' + (err instanceof Error ? err.message : String(err)), 'error')
        }

        // Fall back to Google Trends
        try {
            const trends = await this.getGoogleTrends(geoLocale)
            if (Array.isArray(trends) && trends.length > 0) return trends
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'SEARCH-QUERIES', 'Fallback Google Trends failed: ' + (e instanceof Error ? e.message : String(e)), 'warn')
        }

        // Local fallback handled by caller if needed
        return []
    }

    /**
     * Use OpenRouter (chat completions) to ask for a JSON array of "university-student-like" search queries.
     * Expected output: [{ topic: "example topic", related: ["r1","r2", ...] }, ...]
     *
     * If the first attempt fails and a proxy appears to be configured (via environment or this.bot.config.proxy),
     * this will retry the request with environment proxy variables temporarily removed (i.e., no proxy).
     */
    private async generateQueriesWithLLM(geoLocale: string): Promise<GoogleSearch[]> {
        const envKey = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined;
        const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined;
        const apiKey = envKey || cfgKey;
        if (!apiKey) throw new Error('OpenRouter API key not configured');

        const systemPrompt = `You are an assistant that outputs a JSON array only. Each item must be an object with:
- "topic": a short search query a typical university student might type (games, course topics, assignments, campus services, local food, cheap textbooks, study techniques).
- "related": an array of 0..6 related searches (short strings).

Return at least 25 items if possible. Avoid politically sensitive or adult topics. Output must be valid JSON only (no explanatory text). Include geo context where relevant (e.g., use ${geoLocale.toUpperCase()} locale when producing location-specific queries).`;

        const userPrompt = `Generate a diverse list of short search queries a typical university student (undergrad) would use. Include games, course queries (e.g., "econ midterm study guide"), campus services, cheap food spots, debugging/programming help, and popular non-suspicious entertainment. Output only JSON.`;

        const body = {
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 1200,
            temperature: 0.7
        };

        const payload = JSON.stringify(body);
        const timeoutMs = (this.bot.config?.openRouter?.timeoutMs) || 10000;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(this.bot.config?.openRouter?.referer ? { 'Referer': this.bot.config.openRouter.referer, 'HTTP-Referer': this.bot.config.openRouter.referer } : {}),
            ...(this.bot.config?.openRouter?.title ? { 'X-Title': this.bot.config.openRouter.title } : {})
        };

        let rawResponse = '';
        let statusCode: number | undefined;

        // Attempt 1: normal request (this will use environment proxy variables if present = "with proxy")
        try {
            rawResponse = await this.performOpenRouterRequest(payload, headers, timeoutMs, false)
            statusCode = this._lastOpenRouterStatusCode
        } catch (err) {
            const details = (err as Error).message || String(err)
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `OpenRouter request failed (first attempt): ${details}`, 'error')

            // If a proxy appears to be configured, retry without environment proxy vars ("without proxy").
            const envHasProxy = Boolean(process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy)
            const botHasProxyConfig = Boolean(this.bot.config?.proxy)
            if (envHasProxy || botHasProxyConfig) {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', 'Detected proxy configuration; retrying OpenRouter request without environment proxy variables', 'warn')
                try {
                    rawResponse = await this.performOpenRouterRequest(payload, headers, timeoutMs, true)
                    statusCode = this._lastOpenRouterStatusCode
                } catch (err2) {
                    const details2 = (err2 as Error).message || String(err2)
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `OpenRouter retry without proxy failed: ${details2}`, 'error')
                    throw err2
                }
            } else {
                // No proxy detected — rethrow original error
                throw err
            }
        }

        // top-level parse attempt
        let responseData: any;
        try {
            responseData = JSON.parse(rawResponse);
        } catch {
            responseData = rawResponse;
        }

        const extractContent = (obj: any): string | undefined => {
            if (!obj) return undefined;
            if (Array.isArray(obj.choices) && obj.choices.length) {
                const first = obj.choices[0];
                if (first?.message?.content) return first.message.content;
                if (first?.text) return first.text;
                if (obj.choices.every((c: any) => c?.delta)) {
                    return obj.choices.map((c: any) => c.delta?.content || '').join('');
                }
            }
            if (typeof obj.output_text === 'string') return obj.output_text;
            if (obj.result?.content) return obj.result.content;
            if (obj.generated_text) return obj.generated_text;
            return undefined;
        };

        let content: string | undefined = extractContent(responseData);

        // SSE-style parsing (data: ...)
        if (!content && typeof rawResponse === 'string') {
            const s = rawResponse.trim();
            if (/^data: /m.test(s)) {
                const lines = s.split(/\r?\n/);
                const jsonPieces: string[] = [];
                for (const line of lines) {
                    const m = line.match(/^data:\s*(.*)$/);
                    // Ensure match exists and group 1 is a string
                    if (!m || typeof m[1] !== 'string') continue;
                    const payloadChunk = m[1].trim();
                    if (payloadChunk === '[DONE]') continue;
                    if (payloadChunk.length === 0) continue;
                    jsonPieces.push(payloadChunk);
                }

                // parse from last to first the JSON chunks
                for (let i = jsonPieces.length - 1; i >= 0; i--) {
                    const chunk = jsonPieces[i];
                    if (!chunk) continue;
                    try {
                        const parsedChunk = JSON.parse(chunk);
                        const maybe = extractContent(parsedChunk);
                        if (maybe) {
                            content = maybe;
                            break;
                        }
                    } catch {
                        // ignore partial/invalid chunk
                    }
                }

                if (!content && jsonPieces.length) {
                    // join as fallback (still a string)
                    content = jsonPieces.join('\n');
                }
            }
        }

        if (!content && typeof rawResponse === 'string') {
            content = rawResponse;
        }

        if (!content) {
            const snippet = typeof rawResponse === 'string' ? rawResponse.slice(0, 2000) : String(rawResponse);
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `No content extracted from OpenRouter (status=${statusCode}). Body snippet: ${snippet}`, 'error');
            throw new Error('No content returned from OpenRouter');
        }

        // strip fences and parse JSON
        const stripFences = (txt: string) => String(txt).replace(/```(?:json)?/g, '').trim();
        let parsed: any;
        try {
            parsed = JSON.parse(content);
        } catch {
            const trimmed = stripFences(content);
            try {
                parsed = JSON.parse(trimmed);
            } catch {
                const match = trimmed.match(/(\[.*\]|\{.*\})/s);
                if (match && typeof match[1] === 'string') {
                    try {
                        parsed = JSON.parse(match[1]);
                    } catch {
                        this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Failed to parse LLM JSON output. Preview: ${trimmed.slice(0,500)}`, 'error');
                        throw new Error('Failed to parse LLM JSON output');
                    }
                } else {
                    this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `No JSON-like content in LLM output. Preview: ${trimmed.slice(0,500)}`, 'error');
                    throw new Error('Failed to parse LLM JSON output');
                }
            }
        }

        if (!Array.isArray(parsed)) {
            if (parsed?.data && Array.isArray(parsed.data)) parsed = parsed.data;
            else if (parsed?.items && Array.isArray(parsed.items)) parsed = parsed.items;
            else {
                this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `LLM returned non-array JSON: ${JSON.stringify(parsed).slice(0,1000)}`, 'error');
                throw new Error('LLM returned non-array JSON');
            }
        }

        const normalized: GoogleSearch[] = parsed.map((item: any) => {
            let topic = '';
            if (typeof item.topic === 'string') topic = item.topic;
            else if (typeof item === 'string') topic = item;
            else if (typeof item?.title === 'string') topic = item.title;

            const related = Array.isArray(item.related) ? item.related.filter((r: any) => typeof r === 'string') : [];
            return { topic: String(topic).trim(), related };
        }).filter((x: GoogleSearch) => !!x.topic && x.topic.length > 1);

        if (!normalized.length) {
            this.bot.log(this.bot.isMobile, 'SEARCH-LLM', `Parsed JSON but no valid search items found. Parsed length: ${Array.isArray(parsed) ? parsed.length : 0}`, 'error');
            throw new Error('LLM returned empty or invalid results');
        }

        return normalized;
    }

    /**
     * Perform the HTTPS request to OpenRouter. If disableEnvProxy is true, temporarily removes
     * environment proxy variables (HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy) for the duration
     * of the request so the request is made without the OS/env proxy.
     */
    private async performOpenRouterRequest(payload: string, headers: Record<string, string>, timeoutMs: number, disableEnvProxy: boolean): Promise<string> {
        const url = new URL('https://openrouter.ai/api/v1/chat/completions');
        // Save existing env proxy vars if asked to disable them
        const savedEnv: Record<string, string | undefined> = {}
        const proxyEnvKeys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']

        if (disableEnvProxy) {
            for (const k of proxyEnvKeys) {
                savedEnv[k] = process.env[k]
                if (process.env[k]) delete process.env[k]
            }
        }

        try {
            return await new Promise<string>((resolve, reject) => {
                const req = https.request({
                    hostname: url.hostname,
                    port: url.port || 443,
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers,
                    agent: undefined as any // explicitly undefined to avoid agent/proxy reuse
                }, (res) => {
                    const statusCode = res.statusCode;
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                    res.on('end', () => {
                        const raw = Buffer.concat(chunks).toString('utf8');
                        // store for caller diagnostics
                        this._lastOpenRouterStatusCode = statusCode;
                        resolve(raw);
                    });
                });

                req.on('error', (err) => reject(err));
                req.setTimeout(timeoutMs, () => req.destroy(new Error('OpenRouter request timeout')));
                req.write(payload);
                req.end();
            })
        } finally {
            // Restore environment proxy variables
            if (disableEnvProxy) {
                for (const k of proxyEnvKeys) {
                    if (typeof savedEnv[k] === 'string') process.env[k] = savedEnv[k] as string
                    else delete process.env[k]
                }
            }
        }
    }

    private async getGoogleTrends(geoLocale: string = 'US'): Promise<GoogleSearch[]> {
        const queryTerms: GoogleSearch[] = [];
        this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Generating search queries | GeoLocale: ${geoLocale}`);

        // Human-like delay before fetching trends (increased for safety)
        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000));

        try {
            // Enhanced request configuration
            const request: AxiosRequestConfig = {
                url: 'https://trends.google.com/_/TrendsUi/data/batchexecute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'Accept': '*/*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://trends.google.com/trends/',
                    'Origin': 'https://trends.google.com'
                },
                data: `f.req=[[[i0OFE,"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`,
                responseType: 'text',
                timeout: (this.bot.config?.googleTrends?.timeoutMs) || 20000,
                // Important: Explicitly handle proxy configuration
                proxy: this.bot.config?.proxy?.proxyBingTerms || false
            };

            // Improved DNS handling with better error management
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const dns = require('dns');
                const lookup = (hostname: string, options: any, callback: Function) => {
                    dns.lookup(hostname, { family: 4 }, (err: any, address: any, family: any) => {
                        if (err) {
                            // Fallback to default lookup if IPv4 fails
                            dns.lookup(hostname, (err2: any, address2: any, family2: any) => {
                                callback(err2, address2, family2);
                            });
                        } else {
                            callback(err, address, family);
                        }
                    });
                };
                request.httpsAgent = new (require('https').Agent)({
                    keepAlive: true,
                    lookup,
                    // Additional security options
                    rejectUnauthorized: true
                });
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'DNS agent creation failed, using default: ' + (e instanceof Error ? e.message : String(e)), 'warn');
            }

            // Make the request with enhanced error handling
            const response = await this.bot.axios.request(request as any);

            // Handle different response formats
            let rawText: string;
            if (typeof response.data === 'string') {
                rawText = response.data;
            } else if (Buffer.isBuffer(response.data)) {
                rawText = response.data.toString('utf8');
            } else {
                rawText = JSON.stringify(response.data);
            }

            // Check for empty or invalid responses
            if (!rawText || rawText.length < 10) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Empty or invalid response from Google Trends', 'warn');
                return [];
            }

            const trendsData = this.extractJsonFromResponse(rawText);

            if (!trendsData || !Array.isArray(trendsData)) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Failed to parse valid trends data from response', 'warn');

                // Fallback to US locale if original wasn't US
                if (geoLocale.toUpperCase() !== 'US') {
                    this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Falling back to US locale', 'warn');
                    return this.getGoogleTrends('US');
                }
                return [];
            }

            // Process the trends data
            const mappedTrendsData = trendsData.map((query: any) => [
                query[0],
                query[9] ? query[9].slice(1) : []
            ]);

            // More generous fallback logic
            if (mappedTrendsData.length < 50 && geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Insufficient trends for ${geoLocale} (${mappedTrendsData.length}), falling back to US`, 'warn');
                return this.getGoogleTrends('US');
            }

            // Build query terms with validation
            for (const [topic, relatedQueries] of mappedTrendsData) {
                if (topic && typeof topic === 'string' && topic.trim().length > 0) {
                    queryTerms.push({
                        topic: topic.trim(),
                        related: Array.isArray(relatedQueries) ? relatedQueries.filter(q => typeof q === 'string') : []
                    });
                }
            }

            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', `Successfully fetched ${queryTerms.length} search queries`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Error fetching trends: ' + errorMessage, 'error');

            // Specific handling for IP-related errors
            if (errorMessage.includes('IP address') || errorMessage.includes('Invalid IP')) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Google is blocking requests due to IP issues. Consider:', 'error');
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', '- Using a VPN or proxy rotation:cite[1]', 'error');
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', '- Increasing delays between requests:cite[4]', 'error');
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', '- Reducing request frequency:cite[1]', 'error');
            }

            // Fallback to US locale on any error if original wasn't US
            if (geoLocale.toUpperCase() !== 'US') {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Falling back to US locale after error', 'warn');
                return this.getGoogleTrends('US');
            }
        }

        return queryTerms;
    }

    private extractJsonFromResponse(text: string): GoogleTrendsResponse[1] | null {
        const lines = String(text).split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                try {
                    // some batchexecute responses are nested JSON; this was the earlier heuristic
                    return JSON.parse(JSON.parse(trimmed)[0][2])[1]
                } catch {
                    continue
                }
            }
        }

        return null
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
                }
            }

            const response = await this.bot.axios.request(request, this.bot.config.proxy?.proxyBingTerms)

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
}

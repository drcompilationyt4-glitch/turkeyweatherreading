// src/functions/activities/SearchOnBing.ts  (fixed)
import { Page } from 'rebrowser-playwright'
import * as fs from 'fs'
import path from 'path'

// If you want to load .env automatically when running locally, either
// call require('dotenv').config() in your app entry or uncomment the line below:
// import 'dotenv/config'

import { Workers } from '../Workers'
import { MorePromotion, PromotionalItem } from '../../interface/DashboardData'
import { AxiosRequestConfig } from 'axios'

export class SearchOnBing extends Workers {
    /**
     * Main flow to perform "Search on Bing" activity.
     */
    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem) {
        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Trying to complete SearchOnBing')

        try {
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))
            await this.bot.browser.utils.tryDismissAllMessages(page)

            const query = await this.getSearchQuery(activity.title)

            const searchBar = '#sb_form_q'
            const box = page.locator(searchBar)
            await box.waitFor({ state: 'attached', timeout: 50000 }).catch(() => { /* fallback below */ })

            try {
                await this.bot.browser.utils.tryDismissAllMessages(page)
                await this.bot.utils.wait(200)

                await box.focus({ timeout: 60000 }).catch(() => { /* ignore focus errors */ })
                await box.fill('')
                await this.bot.utils.wait(200)
                await page.keyboard.type(query, { delay: 20 })
                await this.bot.utils.wait(this.bot.utils.randomNumber(200, 800))
                await page.keyboard.press('Enter')
            } catch (typeErr) {
                const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
                await page.goto(url).catch(() => { /* last-resort navigation */ })
            }

            await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 5000))
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

            try { await page.close() } catch (e) { /* ignore close errors */ }

            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Completed the SearchOnBing successfully')
        } catch (error) {
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'An error occurred:' + String(error), 'error')
        }
    }

    /**
     * Resolve a short search query for a given promotion title.
     * Try LLM first (if an OpenRouter API key is available). If LLM fails or no key,
     * fall back to local queries.json or remote queries.json, then finally the title.
     */
    private async getSearchQuery(title: string): Promise<string> {
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        interface Queries {
            title: string;
            queries: string[]
        }

        let queries: Queries[] = []

        try {
            // --- Attempt LLM first if API key present ---
            const envKey = process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined
            const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined
            const apiKey = envKey || cfgKey

            if (apiKey) {
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Attempting LLM-first fallback for title: ${title}`)
                try {
                    const llmQuery = await this.callOpenRouterForQuery(title, apiKey)
                    if (llmQuery) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `LLM-first answer: ${llmQuery} | question: ${title}`)

                        if (this.bot.config && this.bot.config.cacheGeneratedQueries) {
                            try {
                                const localPath = path.join(__dirname, '../queries.json')
                                let existing: Queries[] = []
                                if (fs.existsSync(localPath)) {
                                    try {
                                        existing = JSON.parse(fs.readFileSync(localPath, 'utf8'))
                                        if (!Array.isArray(existing)) existing = []
                                    } catch {
                                        existing = []
                                    }
                                }
                                existing.push({ title, queries: [llmQuery] })
                                fs.writeFileSync(localPath, JSON.stringify(existing, null, 2), 'utf8')
                                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Cached generated query for title: ${title}`)
                            } catch (cacheErr) {
                                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Caching failed: ${String(cacheErr)}`, 'warn')
                            }
                        }

                        return llmQuery
                    } else {
                        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'LLM-first fallback returned empty or failed; continuing to other sources', 'warn')
                    }
                } catch (llmErr) {
                    // callOpenRouterForQuery already logs details; still note and continue.
                    this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `LLM-first attempt threw: ${String(llmErr)}. Falling back to queries.json`, 'warn')
                }
            } else {
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'No OpenRouter API key found (process.env.OPENROUTER_API_KEY or bot.config.openRouterApiKey). Skipping LLM-first step.', 'log')
            }

            // --- If we get here, either no API key or LLM failed; proceed to local/remote queries ---

            if (this.bot.config && this.bot.config.searchOnBingLocalQueries) {
                const localPath = path.join(__dirname, '../queries.json')
                try {
                    const data = fs.readFileSync(localPath, 'utf8')
                    const parsed = JSON.parse(data)
                    if (Array.isArray(parsed)) queries = parsed
                    else queries = []
                } catch (err) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Failed to parse local queries.json: ' + String(err), 'warn')
                    queries = []
                }
            } else {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))

                const axiosReq: AxiosRequestConfig = {
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/main/src/functions/queries.json',
                    timeout: 8000,
                    responseType: 'text'
                }

                const response = await this.bot.axios.request(axiosReq).catch(() => ({ data: null }))
                let remoteData: any = response && response.data ? response.data : null

                if (typeof remoteData === 'string') {
                    try {
                        remoteData = JSON.parse(remoteData)
                    } catch (parseErr) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'Failed to JSON.parse remote queries.json; falling back to empty array', 'warn')
                        remoteData = null
                    }
                }

                if (Array.isArray(remoteData)) {
                    queries = remoteData
                } else if (remoteData && typeof remoteData === 'object') {
                    if (Array.isArray((remoteData as any).queries)) queries = (remoteData as any).queries
                    else if (Array.isArray((remoteData as any).default)) queries = (remoteData as any).default
                    else queries = []
                } else {
                    queries = []
                }
            }

            // Find match (normalized)
            const answers = Array.isArray(queries) ? queries.find(x => this.normalizeString(x.title) === this.normalizeString(title)) : undefined
            if (answers && Array.isArray(answers.queries) && answers.queries.length > 0) {
                const answer = this.bot.utils.shuffleArray(answers.queries)[0] as string
                this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Found local/remote answer: ${answer} | question: ${title}`)
                return answer
            }

            // No LLM result earlier and no local/remote queries matched: fall back to title
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `No local/remote query found for: ${title}. Falling back to title for query.`)
            return title

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'An error occurred while resolving query:' + String(error), 'error')
            return title
        }
    }

    private normalizeString(input: string): string {
        // Normalize accents, remove diacritics, keep printable ASCII characters, remove question/exclamation,
        // normalize whitespace and lowercase for consistent comparisons.
        if (typeof input !== 'string') return ''
        const decomposed = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
        const asciiOnly = decomposed.replace(/[^\x20-\x7E]/g, '') // printable ASCII
        const noPunct = asciiOnly.replace(/[?!]/g, '') // remove these punctuation (keep other characters)
        return noPunct.trim().toLowerCase()
    }

    /**
     * Calls OpenRouter's chat completions endpoint to generate a short query.
     * If bot.config.openRouterForceDirect === true, request will set proxy: false to bypass axios proxy.
     */
    private async callOpenRouterForQuery(title: string, providedApiKey?: string): Promise<string | null> {
        try {
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800))

            const envKey = providedApiKey || (process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.trim() : undefined)
            const cfgKey = this.bot.config?.openRouterApiKey ? String(this.bot.config.openRouterApiKey).trim() : undefined
            const apiKey = envKey || cfgKey

            if (!apiKey) {
                this.bot.log(this.bot.isMobile, 'OPENROUTER', 'Missing OpenRouter API key (process.env.OPENROUTER_API_KEY or bot.config.openRouterApiKey).', 'warn')
                return null
            }

            const model = (this.bot.config && this.bot.config.openRouterModel) || 'openai/gpt-4o-mini:2024-12-17'

            const promptSystem = `You are a concise assistant that outputs a single short Bing search query. Output only the query (no commentary).`
            const promptUser = `Promotional title: "${title}". Provide a concise search query (2-8 words) that a user would enter into Bing to find relevant pages.`

            const payload: any = {
                model,
                messages: [
                    { role: 'system', content: promptSystem },
                    { role: 'user', content: promptUser }
                ],
                max_tokens: 64,
                temperature: (this.bot.config && typeof this.bot.config.openRouterTemperature === 'number') ? this.bot.config.openRouterTemperature : 0.2,
            }

            if (this.bot.config && typeof this.bot.config.openRouterProvider === 'string') {
                payload.provider = this.bot.config.openRouterProvider
            }
            if (this.bot.config && this.bot.config.openRouterZdrOnly) {
                payload.zdr = true
            }

            // Only force bypass when explicit config is set; otherwise let axios follow normal proxy settings.
            const forceDirect = !!(this.bot.config && this.bot.config.openRouterForceDirect === true)

            const resp = await this.bot.axios.request({
                method: 'POST',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: payload,
                timeout: 15000,
                ...(forceDirect ? { proxy: false } : {})
            })

            // Robustly extract textual content from possible response shapes
            let llmText: string | undefined
            const tryExtract = (obj: any): string | undefined => {
                if (!obj) return undefined
                if (Array.isArray(obj.choices) && obj.choices.length) {
                    const first = obj.choices[0]
                    if (first?.message?.content && typeof first.message.content === 'string') return first.message.content
                    if (typeof first.text === 'string') return first.text
                    // some providers return {choices: [{ delta: { content: '...' }}, ...]}
                    if (obj.choices.every((c: any) => c?.delta) ) {
                        return obj.choices.map((c: any) => c.delta?.content || '').join('')
                    }
                }
                if (typeof obj.output_text === 'string') return obj.output_text
                if (Array.isArray(obj.result) && obj.result.length > 0) {
                    const r0 = obj.result[0]
                    if (r0?.content) {
                        if (Array.isArray(r0.content) && typeof r0.content[0] === 'string') return r0.content[0]
                        if (typeof r0.content === 'string') return r0.content
                    }
                }
                if (typeof obj.generated_text === 'string') return obj.generated_text
                return undefined
            }

            // resp.data might be string or object
            if (resp && resp.data) {
                if (typeof resp.data === 'string') {
                    // Could be raw JSON string or plain text — try JSON parse
                    try {
                        const parsed = JSON.parse(resp.data)
                        llmText = tryExtract(parsed) || String(parsed)
                    } catch {
                        // not JSON — treat as plain text
                        llmText = resp.data
                    }
                } else if (typeof resp.data === 'object') {
                    llmText = tryExtract(resp.data) || (typeof resp.data === 'string' ? resp.data : undefined)
                } else {
                    llmText = String(resp.data)
                }
            }

            if (!llmText) return null

            // Clean and normalize: handle fenced JSON or plain text robustly, avoid accessing possibly-undefined matches.
            const textStr = String(llmText)

            // 1) Attempt to extract JSON blocks inside ``` or JSON-like blocks safely
            const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g
            const jsonPieces: string[] = []
            let match: RegExpExecArray | null
            while ((match = jsonBlockRegex.exec(textStr)) !== null) {
                // Guard access to capture group
                const group = match[1]
                if (typeof group === 'string' && group.trim()) jsonPieces.push(group.trim())
            }

            // 2) If no fenced JSON blocks, try to find standalone JSON-like substrings (e.g. starting with { and ending with })
            if (jsonPieces.length === 0) {
                // This tries to find top-level JSON objects in the string safely
                const simpleJsonRegex = /({[\s\S]*})/g
                const simpleMatches: string[] = []
                let sm: RegExpExecArray | null
                while ((sm = simpleJsonRegex.exec(textStr)) !== null) {
                    const g = sm[1]
                    if (typeof g === 'string' && g.trim()) simpleMatches.push(g.trim())
                }
                // prefer simpleMatches if we found any
                if (simpleMatches.length) jsonPieces.push(...simpleMatches)
            }

            // 3) Conservative attempt to parse any jsonPieces (only strings) — ensure element is a string before JSON.parse
            let finalText: string | null = null
            for (let i = 0; i < jsonPieces.length; i++) {
                const piece = jsonPieces[i]
                if (typeof piece !== 'string' || piece.trim() === '') continue
                try {
                    const p = JSON.parse(piece)
                    // If parser returns a string directly
                    if (typeof p === 'string' && p.trim()) {
                        finalText = p.trim()
                        break
                    }
                    // If it's an object, try to read known fields
                    if (p && typeof p === 'object') {
                        if (typeof p.query === 'string' && p.query.trim()) {
                            finalText = p.query.trim(); break
                        }
                        if (typeof p.text === 'string' && p.text.trim()) {
                            finalText = p.text.trim(); break
                        }
                        if (typeof p.output === 'string' && p.output.trim()) {
                            finalText = p.output.trim(); break
                        }
                        // fallback: stringify the object and take the first non-empty line
                        const objStr = JSON.stringify(p)
                        if (objStr) {
                            const firstLine = objStr.split('\n').map(s => s.trim()).filter(Boolean)[0]
                            if (firstLine) { finalText = firstLine; break }
                        }
                    }
                } catch (e) {
                    // ignore parse error for this piece and continue trying others
                }
            }

            // 4) Fallback: take the first non-empty plain line after removing fences
            if (!finalText) {
                const stripFences = (s: string) => s.replace(/```(?:json)?/g, '')
                const cleaned = stripFences(textStr).split('\n').map(s => s.trim()).filter(Boolean)[0] || ''
                const stripped = cleaned.replace(/^['\"]|['\"]$/g, '').trim()
                finalText = stripped.length > 200 ? stripped.slice(0, 200) : stripped
            }

            return finalText || null
        } catch (err: any) {
            const status = err?.response?.status
            const respData = err?.response?.data

            if (status === 404 && respData && typeof respData === 'object') {
                const msg = (respData?.error?.message) || String(respData)
                if (typeof msg === 'string' && msg.includes('No endpoints found matching your data policy')) {
                    this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed due to OpenRouter privacy settings. Please enable model endpoints at https://openrouter.ai/settings/privacy', 'error')
                    return null
                }
            }

            const errMsg = err?.response ? `status ${status} - ${JSON.stringify(respData)}` : String(err)
            this.bot.log(this.bot.isMobile, 'OPENROUTER', 'LLM call failed: ' + errMsg, 'error')
            return null
        }
    }
}

import type { Cookie } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import fs from 'fs'
import path from 'path'
import { randomInt } from 'crypto'

import type { Account, ConfigSaveFingerprint } from '../interface/Account'
import type { Config, QueryEngine } from '../interface/Config'
import { validateAccounts, validateConfig } from './Validator'

let configCache: Config

// The legacy (v2) build shares ONE source of truth with the main app, located in src/:
//   accounts -> <projectRoot>/src/accounts.json
//   config   -> <projectRoot>/src/config.json
// (The main app may write a temporary single-account override to distv2/accounts.json
//  while it runs a legacy retry for a failed account - we prefer that override.)
function getProjectRoot(): string {
    const cwd = process.cwd()
    if (fs.existsSync(path.join(cwd, 'package.json'))) return cwd

    let dir = __dirname
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir
        dir = path.dirname(dir)
    }

    return cwd
}

export function loadAccounts(): Account[] {
    try {
        let file = 'accounts.json'

        if (process.argv.includes('-dev')) {
            file = 'accounts.dev.json'
        }

        const root = getProjectRoot()

        // When the main app runs a legacy retry it writes a temporary single-account
        // file at distv2/accounts.json. Prefer that override, otherwise use the shared source.
        const overrideFile = path.join(root, 'distv2', file)
        const sharedFile = path.join(root, 'src', file)

        const accountFile = fs.existsSync(overrideFile) ? overrideFile : sharedFile

        if (!fs.existsSync(accountFile)) {
            throw new Error(`accounts.json not found - expected at ${sharedFile} (or a distv2 override)`)
        }

        const accounts = fs.readFileSync(accountFile, 'utf-8')
        const accountsData = JSON.parse(accounts)

        validateAccounts(accountsData)

        // ✅ Shuffle accounts (Fisher-Yates)
        for (let i = accountsData.length - 1; i > 0; i--) {
            const j = randomInt(0, i + 1)
            ;[accountsData[i], accountsData[j]] = [accountsData[j], accountsData[i]]
        }

        return accountsData
    } catch (error) {
        throw new Error(error as string)
    }
}

export function loadConfig(): Config {
    try {
        if (configCache) {
            return configCache
        }

        const root = getProjectRoot()
        const sharedConfigFile = path.join(root, 'src', 'config.json')

        if (!fs.existsSync(sharedConfigFile)) {
            throw new Error(`config.json not found - expected at ${sharedConfigFile}`)
        }

        const shared = JSON.parse(fs.readFileSync(sharedConfigFile, 'utf-8')) as any
        const webhook = shared.webhook ?? {}
        const sharedWorkers = shared.workers ?? {}
        const sharedSearch = shared.searchSettings ?? {}

        // Merge the shared config with the v2-only defaults it requires.
        const configData: Config = {
            baseURL: 'https://rewards.bing.com',
            sessionPath: shared.sessionPath ?? 'sessions',
            headless: shared.headless ?? true,
            clusters: shared.clusters ?? 1,
            errorDiagnostics: shared.errorDiagnostics ?? false,
            workers: {
                doDailySet: sharedWorkers.doDailySet ?? true,
                // Not present in the modern config; the stable fallback keeps these off
                // unless explicitly enabled.
                doSpecialPromotions: sharedWorkers.doSpecialPromotions ?? false,
                doMorePromotions: sharedWorkers.doMorePromotions ?? true,
                doPunchCards: sharedWorkers.doPunchCards ?? true,
                doAppPromotions: sharedWorkers.doAppPromotions ?? true,
                doDesktopSearch: sharedWorkers.doDesktopSearch ?? true,
                doMobileSearch: sharedWorkers.doMobileSearch ?? true,
                doDailyCheckIn: sharedWorkers.doDailyCheckIn ?? true,
                doReadToEarn: sharedWorkers.doReadToEarn ?? true,
                doQuests: sharedWorkers.doQuests ?? false
            },
            searchOnBingLocalQueries: shared.searchOnBingLocalQueries ?? false,
            globalTimeout: shared.globalTimeout ?? '30sec',
            searchSettings: {
                scrollRandomResults: sharedSearch.scrollRandomResults ?? true,
                clickRandomResults: sharedSearch.clickRandomResults ?? true,
                parallelSearching: sharedSearch.parallelSearching ?? false,
                queryEngines: Array.isArray(sharedSearch.queryEngines)
                    ? (sharedSearch.queryEngines.filter((e: string) =>
                            ['google', 'wikipedia', 'reddit', 'local'].includes(e)
                      ) as QueryEngine[])
                    : ['google', 'wikipedia', 'reddit', 'local'],
                searchResultVisitTime: sharedSearch.searchResultVisitTime ?? '15sec',
                searchDelay: sharedSearch.searchDelay ?? { min: '45sec', max: '90sec' },
                readDelay: sharedSearch.readDelay ?? { min: '45sec', max: '90sec' }
            },
            debugLogs: shared.debugLogs ?? false,
            proxy: { queryEngine: shared.proxy?.queryEngine ?? true },
            consoleLogFilter: shared.consoleLogFilter ?? {
                enabled: false,
                mode: 'whitelist',
                levels: [],
                keywords: [],
                regexPatterns: []
            },
            webhook: {
                discord:
                    webhook.discord && typeof webhook.discord.enabled === 'boolean'
                        ? { enabled: webhook.discord.enabled, url: webhook.discord.url ?? '' }
                        : undefined,
                ntfy: webhook.ntfy
                    ? {
                          enabled: webhook.ntfy.enabled,
                          url: webhook.ntfy.url ?? '',
                          topic: webhook.ntfy.topic,
                          token: webhook.ntfy.token,
                          title: webhook.ntfy.title,
                          tags: webhook.ntfy.tags,
                          priority: webhook.ntfy.priority
                      }
                    : undefined,
                webhookLogFilter: webhook.webhookLogFilter ?? {
                    enabled: false,
                    mode: 'whitelist',
                    levels: [],
                    keywords: [],
                    regexPatterns: []
                }
            }
        }

        validateConfig(configData)

        configCache = configData

        return configData
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function loadSessionData(
    sessionPath: string,
    email: string,
    saveFingerprint: ConfigSaveFingerprint,
    isMobile: boolean
) {
    try {
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'
        const cookieFile = path.join(__dirname, '../browser/', sessionPath, email, cookiesFileName)

        let cookies: Cookie[] = []
        if (fs.existsSync(cookieFile)) {
            const cookiesData = await fs.promises.readFile(cookieFile, 'utf-8')
            cookies = JSON.parse(cookiesData)

            const hasValidAuth = cookies.some(c => c.name === '_C_Auth' && c.value && c.value.length > 0)
            if (!hasValidAuth) {
                return { cookies: [], fingerprint: undefined }
            }
        } else {
            return { cookies: [], fingerprint: undefined }
        }

        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        const fingerprintFile = path.join(__dirname, '../browser/', sessionPath, email, fingerprintFileName)

        let fingerprint!: BrowserFingerprintWithHeaders
        const shouldLoadFingerprint = isMobile ? saveFingerprint.mobile : saveFingerprint.desktop
        if (shouldLoadFingerprint && fs.existsSync(fingerprintFile)) {
            const fingerprintData = await fs.promises.readFile(fingerprintFile, 'utf-8')
            fingerprint = JSON.parse(fingerprintData)
        }

        return {
            cookies: cookies,
            fingerprint: fingerprint
        }
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveSessionData(
    sessionPath: string,
    cookies: Cookie[],
    email: string,
    isMobile: boolean
): Promise<string> {
    try {
        const sessionDir = path.join(__dirname, '../browser/', sessionPath, email)
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await fs.promises.writeFile(path.join(sessionDir, cookiesFileName), JSON.stringify(cookies))

        return sessionDir
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveFingerprintData(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    fingerpint: BrowserFingerprintWithHeaders
): Promise<string> {
    try {
        const sessionDir = path.join(__dirname, '../browser/', sessionPath, email)
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'

        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        await fs.promises.writeFile(path.join(sessionDir, fingerprintFileName), JSON.stringify(fingerpint))

        return sessionDir
    } catch (error) {
        throw new Error(error as string)
    }
}

import playwright, { BrowserContext } from 'rebrowser-playwright'
import { newInjectedContext } from 'fingerprint-injector'
import { FingerprintGenerator } from 'fingerprint-generator'

import { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { updateFingerprintUserAgent } from '../util/UserAgent'
import { AccountProxy } from '../interface/Account'

/**
 * Browser.ts — revised to be MORE conservative by default so we avoid
 * the "No headers based on this input can be generated" error while
 * still providing relaxed attempts as a secondary option.
 *
 * Key strategy changes:
 *  - Prefer simple/deterministic fingerprints (OS/browser combos that are
 *    realistic for the device) on the first attempts.
 *  - Only broaden to wider/random combos when explicitly requested or when
 *    we've exhausted conservative attempts.
 *  - If fingerprint-injector reports header/consistency errors, try a single
 *    deterministic fallback fingerprint (the "old code" fingerprint) before
 *    abandoning injection entirely.
 */
class Browser {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(proxy: AccountProxy, email: string): Promise<BrowserContext> {
        if (process.env.AUTO_INSTALL_BROWSERS === '1') {
            try {
                const { execSync } = await import('child_process')
                execSync('npx playwright install chromium', { stdio: 'ignore' })
            } catch { /* ignore */ }
        }

        const cfgAny = this.bot.config as unknown as Record<string, unknown>

        try { await this.bot.utils.wait(this.bot.utils.randomNumber(200, 800)) } catch { /* ignore */ }

        // Launch with retries
        const maxLaunchAttempts = 3
        let launched: import('rebrowser-playwright').Browser | undefined
        let launchErr: unknown

        for (let attempt = 1; attempt <= maxLaunchAttempts; attempt++) {
            try {
                const envForceHeadless = process.env.FORCE_HEADLESS === '1'
                const headlessValue = envForceHeadless
                    ? true
                    : ((cfgAny['headless'] as boolean | undefined)
                        ?? (cfgAny['browser'] && (cfgAny['browser'] as Record<string, unknown>)['headless'] as boolean | undefined)
                        ?? false)
                const headless: boolean = Boolean(headlessValue)

                const slowMo = (this.bot.utils && typeof this.bot.utils.randomNumber === 'function')
                    ? this.bot.utils.randomNumber(50, 150)
                    : Math.floor(Math.random() * 100) + 50

                const launchOpts: any = {
                    headless,
                    slowMo,
                    args: [
                        '--no-sandbox',
                        '--mute-audio',
                        '--disable-setuid-sandbox',
                        '--ignore-certificate-errors',
                        '--disable-blink-features=AutomationControlled',
                        `--window-size=${1280 + Math.floor(Math.random() * 200)},${720 + Math.floor(Math.random() * 120)}`
                    ]
                }

                if (proxy && proxy.url) {
                    const server = proxy.port ? `${proxy.url}:${proxy.port}` : proxy.url
                    launchOpts.proxy = {
                        server,
                        username: proxy.username,
                        password: proxy.password
                    }
                    this.bot.log(this.bot.isMobile, 'BROWSER', `Using proxy for launch. Server=${server}`)
                }

                launched = await playwright.chromium.launch(launchOpts)
                launchErr = undefined
                break
            } catch (e: unknown) {
                launchErr = e
                const waitMs = Math.min(15000, Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 500))
                this.bot.log(this.bot.isMobile, 'BROWSER', `Launch attempt ${attempt} failed: ${(e instanceof Error) ? e.message : String(e)}. Retrying after ${waitMs}ms`, 'warn')
                try { await this.bot.utils.wait(waitMs) } catch { /* ignore */ }
            }
        }

        if (!launched) {
            const msg = (launchErr instanceof Error ? launchErr.message : String(launchErr))
            this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to launch browser after ${maxLaunchAttempts} attempts: ${msg}`, 'error')
            throw launchErr
        }

        const browser = launched as import('rebrowser-playwright').Browser

        // Normalize saveFingerprint config
        const rawFp = (cfgAny['saveFingerprint']
            ?? (cfgAny['fingerprinting'] as Record<string, unknown> | undefined)?.['saveFingerprint']) as unknown

        const saveFingerprintForLoad: { mobile: boolean; desktop: boolean } =
            typeof rawFp === 'boolean'
                ? { mobile: rawFp, desktop: rawFp }
                : {
                    mobile: !!(rawFp && (rawFp as Record<string, unknown>)['mobile']),
                    desktop: !!(rawFp && (rawFp as Record<string, unknown>)['desktop'])
                }

        // Load saved session + fingerprint if available
        const sessionData = await loadSessionData(
            this.bot.config.sessionPath,
            email,
            this.bot.isMobile,
            saveFingerprintForLoad
        )

        // Use persisted fingerprint if present, else generate (now conservative)
        let fingerprint = sessionData.fingerprint ?? undefined
        if (!fingerprint) {
            fingerprint = await this.generateFingerprint({ relax: false, attempts: 6 })
        }

        // Ensure UA reflects overrides
        let finalFingerprint = await updateFingerprintUserAgent(fingerprint, this.bot.isMobile)

        // Attempt to create injected context, but handle known header-generation failure gracefully
        let context: any | undefined
        const maxInjectAttempts = 2
        let injected = false
        let lastInjectionError: unknown = undefined

        for (let attempt = 1; attempt <= maxInjectAttempts; attempt++) {
            try {
                context = await newInjectedContext(
                    browser as unknown as import('playwright').Browser,
                    { fingerprint: finalFingerprint }
                )
                injected = true
                lastInjectionError = undefined
                break
            } catch (e: unknown) {
                lastInjectionError = e
                const msg = (e instanceof Error) ? e.message : String(e)
                this.bot.log(this.bot.isMobile, 'BROWSER', `newInjectedContext attempt ${attempt} failed: ${msg}`, 'warn')

                // If it's a headers-generation issue or something clearly fingerprint-related, try a deterministic fallback first
                if (typeof msg === 'string' && (/header/i.test(msg) || /No headers/.test(msg) || /cannot be generated/i.test(msg) || /consistent fingerprint/i.test(msg))) {
                    this.bot.log(this.bot.isMobile, 'BROWSER', `Detected headers-generation / consistency failure. Trying single deterministic (old-style) fingerprint fallback before giving up.`, 'warn')
                    try {
                        // deterministic "old code" fingerprint: windows/edge for desktop, android/edge for mobile
                        const deterministicFp = new FingerprintGenerator().getFingerprint({
                            devices: this.bot.isMobile ? ['mobile'] : ['desktop'],
                            operatingSystems: this.bot.isMobile ? ['android'] : ['windows'],
                            browsers: [{ name: 'edge' }]
                        })
                        finalFingerprint = await updateFingerprintUserAgent(deterministicFp, this.bot.isMobile)
                        // try injection once with deterministic fingerprint
                        try {
                            context = await newInjectedContext(
                                browser as unknown as import('playwright').Browser,
                                { fingerprint: finalFingerprint }
                            )
                            injected = true
                            lastInjectionError = undefined
                            break
                        } catch (e2: unknown) {
                            lastInjectionError = e2
                            this.bot.log(this.bot.isMobile, 'BROWSER', `Deterministic fallback injection failed: ${(e2 instanceof Error) ? e2.message : String(e2)}`, 'warn')
                            // fall through to broader fallback below
                        }
                    } catch (detErr) {
                        this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to generate deterministic fallback fingerprint: ${(detErr instanceof Error) ? detErr.message : String(detErr)}`, 'warn')
                        // fall through to broader fallback below
                    }

                    // If deterministic fallback didn't work, try a more relaxed generation before the final fallback
                    try {
                        finalFingerprint = await this.generateFingerprint({ relax: true, attempts: 4 })
                        try { await this.bot.utils.wait(this.bot.utils.randomNumber(150, 400)) } catch { }
                        continue
                    } catch (genErr) {
                        this.bot.log(this.bot.isMobile, 'BROWSER', `Relaxed fingerprint generation after header-failure also failed: ${(genErr instanceof Error) ? genErr.message : String(genErr)}`, 'warn')
                        break
                    }
                } else {
                    const waitMs = Math.min(8000, Math.pow(2, attempt) * 300)
                    try { await this.bot.utils.wait(waitMs) } catch { /* ignore */ }
                }
            }
        }

        // If injection ultimately failed, fall back to standard Playwright context to allow tasks to continue
        if (!injected) {
            this.bot.log(this.bot.isMobile, 'BROWSER', `Fingerprint injection failed after ${maxInjectAttempts} attempts: ${(lastInjectionError instanceof Error) ? lastInjectionError.message : String(lastInjectionError)}. Falling back to browser.newContext()`, 'warn')

            // prepare best-effort headers and context options
            const headers: Record<string, string> = {}
            headers['Accept-Language'] = (this.bot.config?.geoLocale?.locale) || 'en-US,en;q=0.9'
            headers['DNT'] = Math.random() < 0.8 ? '1' : '0'

            // try to extract a UA if available from finalFingerprint, but guard access
            let ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
            try {
                if (finalFingerprint && finalFingerprint.fingerprint && finalFingerprint.fingerprint.navigator && finalFingerprint.fingerprint.navigator.userAgent) {
                    ua = finalFingerprint.fingerprint.navigator.userAgent
                }
            } catch { /* ignore */ }

            // viewport + device emulation choices
            const viewport = this.bot.isMobile ? { width: 360, height: 800 } : { width: 1280, height: 800 }

            try {
                context = await (browser as any).newContext({
                    userAgent: ua,
                    viewport,
                    locale: (this.bot.config?.geoLocale?.locale) || undefined,
                    // Playwright accepts extraHTTPHeaders at context creation
                    extraHTTPHeaders: headers,
                })
            } catch (ctxErr) {
                this.bot.log(this.bot.isMobile, 'BROWSER', `Fallback browser.newContext() failed: ${(ctxErr instanceof Error) ? ctxErr.message : String(ctxErr)}`, 'error')
                throw ctxErr
            }
        }

        // set default timeout
        const globalTimeout = (cfgAny['globalTimeout'] as unknown)
            ?? ((cfgAny['browser'] as Record<string, unknown> | undefined)?.['globalTimeout'] as unknown)
            ?? 30000
        try {
            (context as any).setDefaultTimeout(this.bot.utils.stringToMs(globalTimeout as (number | string)))
        } catch { /* ignore */ }

        // Per-page initialization (viewport jitter, small init script, headers)
        context.on('page', async (page: any) => {
            try {
                const baseDesktopViewport = { width: 1280 + Math.floor(Math.random() * 200), height: 720 + Math.floor(Math.random() * 120) }
                const baseMobileViewport = { width: 360 + Math.floor(Math.random() * 60), height: 800 + Math.floor(Math.random() * 120) }
                const viewportBase = this.bot.isMobile ? baseMobileViewport : baseDesktopViewport
                const jitterViewport = {
                    width: Math.max(320, viewportBase.width + Math.floor((Math.random() - 0.5) * 100)),
                    height: Math.max(480, viewportBase.height + Math.floor((Math.random() - 0.5) * 100))
                }
                try { await page.setViewportSize(jitterViewport) } catch { /* ignore */ }

                await page.addInitScript(() => {
                    try {
                        const s = document.createElement('style')
                        s.id = '__mrs_variation_style'
                        const zoom = (0.85 + Math.random() * 0.25).toFixed(2)
                        s.textContent = `html { zoom: ${zoom} !important; } html, body { overscroll-behavior: contain; }`
                        document.documentElement.appendChild(s)
                        if (Math.random() < 0.1) {
                            setTimeout(() => { try { window.scrollBy(0, 40); setTimeout(() => window.scrollBy(0, -40), 250); } catch { } }, 200)
                        }
                    } catch { /* ignore */ }
                })

                // safe header setting per-page: use context.setExtraHTTPHeaders when possible
                try {
                    const headers: Record<string, string> = {}
                    headers['Accept-Language'] = (this.bot.config?.geoLocale?.locale) || 'en-US,en;q=0.9'
                    headers['DNT'] = Math.random() < 0.8 ? '1' : '0'
                    // don't call setExtraHTTPHeaders if headers object is empty
                    if (Object.keys(headers).length > 0) {
                        try { await page.context().setExtraHTTPHeaders(headers) } catch (e) { /* ignore */ }
                    }
                } catch { /* ignore */ }
            } catch (err) {
                this.bot.log(this.bot.isMobile, 'BROWSER', `page init handling failed: ${(err instanceof Error) ? err.message : String(err)}`, 'warn')
            }
        })

        // restore cookies if present
        try {
            await (context as any).addCookies(sessionData.cookies || [])
            try { await this.bot.utils.wait(this.bot.utils.randomNumber(200, 600)) } catch { }
        } catch (e) {
            this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to restore cookies: ${(e instanceof Error) ? e.message : String(e)}`, 'warn')
        }

        // Persist fingerprint if desired
        const shouldPersistFingerprint = this.bot.isMobile
            ? saveFingerprintForLoad.mobile
            : saveFingerprintForLoad.desktop

        if (shouldPersistFingerprint) {
            try {
                await saveFingerprintData(this.bot.config.sessionPath, email, this.bot.isMobile, finalFingerprint)
                try { await this.bot.utils.wait(this.bot.utils.randomNumber(100, 300)) } catch { }
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'BROWSER', `Failed to persist fingerprint: ${(e instanceof Error) ? e.message : String(e)}`, 'warn')
            }
        }

        this.bot.log(this.bot.isMobile, 'BROWSER', `Created browser context. User-Agent: "${(finalFingerprint && finalFingerprint.fingerprint && finalFingerprint.fingerprint.navigator && finalFingerprint.fingerprint.navigator.userAgent) ? finalFingerprint.fingerprint.navigator.userAgent : 'unknown'}"`)

        return context as unknown as BrowserContext
    }

    /**
     * Generate a fingerprint. This wrapper prefers conservative (realistic)
     * fingerprints by default. If relax=true we allow a wider set of combos.
     */
    async generateFingerprint(opts?: { relax?: boolean; attempts?: number }) {
        const relax = !!(opts && opts.relax)
        const attempts = (opts && opts.attempts) || 6

        // Try a small number of conservative attempts first
        for (let i = 0; i < attempts; i++) {
            try {
                const fp = await this._attemptGenerateFingerprint({ relax, conservative: !relax })
                // sanity check
                if (fp && fp.fingerprint && fp.fingerprint.navigator && fp.fingerprint.navigator.userAgent) {
                    return fp
                }
                throw new Error('Generated fingerprint missing userAgent')
            } catch (e) {
                this.bot.log(this.bot.isMobile, 'BROWSER', `generateFingerprint attempt ${i + 1}/${attempts} failed: ${(e instanceof Error) ? e.message : String(e)}`, 'warn')
                try { await this.bot.utils.wait(this.bot.utils.randomNumber(80, 300)) } catch { }
                // if last attempt, and we haven't returned, we'll fall through to throw
            }
        }

        // If all attempts fail, throw so caller can handle fallback
        throw new Error('Failed to generate a valid fingerprint after multiple attempts')
    }

    /**
     * Single attempt generator. When `conservative=true` it picks only the most
     * realistic combos (to avoid impossible headers).
     */
    private async _attemptGenerateFingerprint(opts?: { relax?: boolean; conservative?: boolean }) {
        const relax = !!(opts && opts.relax)
        const conservative = !!(opts && opts.conservative)

        let osOptions: Array<'android' | 'ios' | 'windows' | 'macos' | 'linux'>
        let browserOptions: Array<'edge' | 'chrome' | 'firefox' | 'safari'>

        if (this.bot.isMobile) {
            // conservative: prefer Android + Chrome/Edge; avoid iOS unless relax=true
            osOptions = conservative ? ['android'] : (relax ? ['android', 'ios'] : ['android', 'ios'])
            browserOptions = conservative ? ['chrome', 'edge'] : (relax ? ['chrome', 'edge', 'firefox', 'safari'] : ['chrome', 'edge'])
        } else {
            // desktop conservative: prefer Windows + Edge/Chrome
            osOptions = conservative ? ['windows'] : (relax ? ['windows', 'macos', 'linux'] : ['windows', 'macos', 'linux'])
            browserOptions = conservative ? ['edge', 'chrome'] : (relax ? ['edge', 'chrome', 'firefox', 'safari'] : ['edge', 'chrome', 'firefox'])
        }

        const screenOptions = this.bot.isMobile
            ? [{ width: 360, height: 780 }, { width: 375, height: 812 }, { width: 412, height: 915 }]
            : [{ width: 1280, height: 800 }, { width: 1366, height: 768 }, { width: 1536, height: 864 }]

        const osChoice = osOptions[Math.floor(Math.random() * osOptions.length)] ?? (this.bot.isMobile ? 'android' : 'windows')
        const browserChoice = browserOptions[Math.floor(Math.random() * browserOptions.length)] ?? 'edge'
        const screenChoice = screenOptions[Math.floor(Math.random() * screenOptions.length)] ?? screenOptions[0]

        const fg = new FingerprintGenerator()
        const screenRange = screenChoice ? {
            minWidth: screenChoice.width,
            maxWidth: screenChoice.width,
            minHeight: screenChoice.height,
            maxHeight: screenChoice.height
        } : undefined

        const fp = fg.getFingerprint({
            devices: this.bot.isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: [osChoice],
            browsers: [{ name: browserChoice }],
            screen: screenRange
        })

        try {
            const updated = await updateFingerprintUserAgent(fp, this.bot.isMobile)
            return updated
        } catch (e) {
            // bubble up so the caller can retry
            throw e
        }
    }
}

export default Browser

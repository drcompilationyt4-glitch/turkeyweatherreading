// src/browser/Browser.ts
import playwright, { BrowserContext } from 'rebrowser-playwright'

import { newInjectedContext } from 'fingerprint-injector'
import { FingerprintGenerator } from 'fingerprint-generator'

import { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { updateFingerprintUserAgent } from '../util/UserAgent'

import { AccountProxy } from '../interface/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

class Browser {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(proxy: AccountProxy, email: string): Promise<BrowserContext> {
        // Optional automatic browser installation (set AUTO_INSTALL_BROWSERS=1)
        if (process.env.AUTO_INSTALL_BROWSERS === '1') {
            try {
                const { execSync } = await import('child_process')
                execSync('npx playwright install chromium', { stdio: 'ignore' })
            } catch { /* silent */ }
        }

        let browser: import('rebrowser-playwright').Browser
        const cfgAny = this.bot.config as unknown as Record<string, unknown>

        try {
            // FORCE_HEADLESS env takes precedence
            const envForceHeadless = process.env.FORCE_HEADLESS === '1'
            const headlessValue =
                envForceHeadless
                    ? true
                    : ((cfgAny['headless'] as boolean | undefined)
                        ?? (cfgAny['browser'] && (cfgAny['browser'] as Record<string, unknown>)['headless'] as boolean | undefined)
                        ?? false)
            const headless: boolean = Boolean(headlessValue)

            browser = await playwright.chromium.launch({
                headless,
                ...(proxy.url && {
                    proxy: {
                        username: proxy.username,
                        password: proxy.password,
                        server: `${proxy.url}:${proxy.port}`
                    }
                }),
                args: [
                    '--no-sandbox',
                    '--mute-audio',
                    '--disable-setuid-sandbox',
                    '--ignore-certificate-errors',
                    '--ignore-certificate-errors-spki-list',
                    '--ignore-ssl-errors'
                ]
            })
        } catch (e: unknown) {
            const msg = (e instanceof Error ? e.message : String(e))
            if (/Executable doesn't exist/i.test(msg)) {
                this.bot.log(this.bot.isMobile, 'BROWSER',
                    'Chromium not installed for Playwright. Run: "npx playwright install chromium" (or set AUTO_INSTALL_BROWSERS=1).',
                    'error')
            } else {
                this.bot.log(this.bot.isMobile, 'BROWSER', 'Failed to launch browser: ' + msg, 'error')
            }
            throw e
        }

        // --- Normalize saveFingerprint config ---
        const rawFp = (cfgAny['saveFingerprint']
            ?? (cfgAny['fingerprinting'] as Record<string, unknown> | undefined)?.['saveFingerprint']) as unknown

        const saveFingerprintForLoad: { mobile: boolean; desktop: boolean } =
            typeof rawFp === 'boolean'
                ? { mobile: rawFp, desktop: rawFp }
                : {
                    mobile: !!(rawFp && (rawFp as Record<string, unknown>)['mobile']),
                    desktop: !!(rawFp && (rawFp as Record<string, unknown>)['desktop'])
                }

        // --- Load session with normalized config ---
        const sessionData = await loadSessionData(
            this.bot.config.sessionPath,
            email,
            this.bot.isMobile,
            saveFingerprintForLoad
        )

        const fingerprint = sessionData.fingerprint
            ? sessionData.fingerprint
            : await this.generateFingerprint()

        const context = await newInjectedContext(
            browser as unknown as import('playwright').Browser,
            { fingerprint }
        )

        // --- Timeout setup ---
        const globalTimeout = (cfgAny['globalTimeout'] as unknown)
            ?? ((cfgAny['browser'] as Record<string, unknown> | undefined)?.['globalTimeout'] as unknown)
            ?? 30000
        context.setDefaultTimeout(this.bot.utils.stringToMs(globalTimeout as (number | string)))

        // --- Viewport setup ---
        try {
            const desktopViewport = { width: 1280, height: 800 }
            const mobileViewport = { width: 390, height: 844 }

            context.on('page', async (page) => {
                try {
                    if (this.bot.isMobile) {
                        await page.setViewportSize(mobileViewport)
                    } else {
                        await page.setViewportSize(desktopViewport)
                    }

                    await page.addInitScript(() => {
                        try {
                            const style = document.createElement('style')
                            style.id = '__mrs_fit_style'
                            style.textContent = `
                          html, body { overscroll-behavior: contain; }
                          @media (min-width: 1000px) {
                            html { zoom: 0.9 !important; }
                          }
                        `
                            document.documentElement.appendChild(style)
                        } catch { /* ignore */ }
                    })
                } catch { /* ignore */ }
            })
        } catch { /* ignore */ }

        // --- Restore cookies ---
        await context.addCookies(sessionData.cookies)

        // --- Persist fingerprint if configured ---
        const shouldPersistFingerprint = this.bot.isMobile
            ? saveFingerprintForLoad.mobile
            : saveFingerprintForLoad.desktop

        if (shouldPersistFingerprint) {
            await saveFingerprintData(this.bot.config.sessionPath, email, this.bot.isMobile, fingerprint)
        }

        this.bot.log(this.bot.isMobile, 'BROWSER',
            `Created browser with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`)

        return context as BrowserContext
    }

    async generateFingerprint() {
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: this.bot.isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: this.bot.isMobile ? ['android'] : ['windows'],
            browsers: [{ name: 'edge' }]
        })

        const updatedFingerPrintData = await updateFingerprintUserAgent(fingerPrintData, this.bot.isMobile)

        return updatedFingerPrintData
    }
}

export default Browser

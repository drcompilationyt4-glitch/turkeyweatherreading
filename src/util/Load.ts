import { BrowserContext, Cookie } from 'rebrowser-playwright'
import { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import fs from 'fs'
import path from 'path'


import { Account } from '../interface/Account'
import { Config, ConfigSaveFingerprint } from '../interface/Config'

let configCache: Config

export function loadAccounts(): Account[] {
    try {
        let file = 'accounts.json'

        // If dev mode, use dev account(s)
        if (process.argv.includes('-dev')) {
            file = 'accounts.dev.json'
        }

        const accountDir = path.join(__dirname, '../', file)
        const accounts = fs.readFileSync(accountDir, 'utf-8')

        return JSON.parse(accounts)
    } catch (error) {
        throw new Error(error as string)
    }
}


export function loadConfig(): Config {
    try {
        if (configCache) {
            console.log('[DEBUG] Returning cached config');
            console.log('[DEBUG] cached clusters =', configCache.clusters);
            return configCache;
        }

        // 🔹 Always load from project root (or src folder) instead of dist
        // Assuming config.json is in the project root next to src/
        const configDir = path.resolve(__dirname, '../config.json');
        console.log('[DEBUG] loadConfig - looking for config at:', configDir);

        if (!fs.existsSync(configDir)) {
            throw new Error(`Config file not found at ${configDir}`);
        }

        const raw = fs.readFileSync(configDir, 'utf-8');
        console.log('[DEBUG] loadConfig - read file length:', raw.length);

        const configData = JSON.parse(raw);
        console.log('[DEBUG] loadConfig - top-level keys:', Object.keys(configData));

        // 🔍 Normalize and validate clusters
        const rawClusters =
            process.env.CLUSTERS ??
            configData?.execution?.clusters ??
            configData?.clusters;

        if (rawClusters !== undefined) {
            const n = Number(rawClusters);
            if (!Number.isNaN(n) && Number.isFinite(n) && n >= 1) {
                configData.clusters = Math.floor(n);
                console.log(
                    `[DEBUG] clusters resolved=${configData.clusters} (source=${
                        process.env.CLUSTERS
                            ? 'ENV'
                            : configData?.execution?.clusters !== undefined
                                ? 'execution.clusters'
                                : 'config.clusters'
                    })`
                );
            } else {
                console.warn(
                    '[WARN] clusters value invalid:',
                    rawClusters,
                    '— leaving as undefined'
                );
            }
        } else {
            console.warn('[WARN] clusters not found in config');
        }

        // ✅ Always print the final clusters value before caching
        console.log('[DEBUG] final clusters value =', configData.clusters);

        configCache = configData;
        return configData as Config;
    } catch (error) {
        console.error('[ERROR] loadConfig failed:', error);
        throw error;
    }
}

export async function loadSessionData(sessionPath: string, email: string, isMobile: boolean, saveFingerprint: ConfigSaveFingerprint) {
    try {
        // Fetch cookie file
        const cookieFile = path.join(__dirname, '../browser/', sessionPath, email, `${isMobile ? 'mobile_cookies' : 'desktop_cookies'}.json`)

        let cookies: Cookie[] = []
        if (fs.existsSync(cookieFile)) {
            const cookiesData = await fs.promises.readFile(cookieFile, 'utf-8')
            cookies = JSON.parse(cookiesData)
        }

        // Fetch fingerprint file
        const fingerprintFile = path.join(__dirname, '../browser/', sessionPath, email, `${isMobile ? 'mobile_fingerpint' : 'desktop_fingerpint'}.json`)

        let fingerprint!: BrowserFingerprintWithHeaders
        if (((saveFingerprint.desktop && !isMobile) || (saveFingerprint.mobile && isMobile)) && fs.existsSync(fingerprintFile)) {
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

export async function saveSessionData(sessionPath: string, browser: BrowserContext, email: string, isMobile: boolean): Promise<string> {
    try {
        const cookies = await browser.cookies()

        // Fetch path
        const sessionDir = path.join(__dirname, '../browser/', sessionPath, email)

        // Create session dir
        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        // Save cookies to a file
        await fs.promises.writeFile(path.join(sessionDir, `${isMobile ? 'mobile_cookies' : 'desktop_cookies'}.json`), JSON.stringify(cookies))

        return sessionDir
    } catch (error) {
        throw new Error(error as string)
    }
}

export async function saveFingerprintData(sessionPath: string, email: string, isMobile: boolean, fingerpint: BrowserFingerprintWithHeaders): Promise<string> {
    try {
        // Fetch path
        const sessionDir = path.join(__dirname, '../browser/', sessionPath, email)

        // Create session dir
        if (!fs.existsSync(sessionDir)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }

        // Save fingerprint to a file
        await fs.promises.writeFile(path.join(sessionDir, `${isMobile ? 'mobile_fingerpint' : 'desktop_fingerpint'}.json`), JSON.stringify(fingerpint))

        return sessionDir
    } catch (error) {
        throw new Error(error as string)
    }
}
import fs from 'fs'
import path from 'path'
import { randomInt } from 'crypto'
import type { Cookie } from 'patchright'

import type { Account } from '../interface/Account'
import type { Config } from '../interface/Config'
import { validateAccounts, validateConfig } from './Validator'

let configCache: Config
let envLoaded = false

// Loads a root/dist/src .env file into process.env if present (idempotent).
// This lets AI/LLM keys (OPENROUTER_API_KEY, OPENAI_API_KEY, ...) and account
// overrides be kept in a .env file for bare-metal runs.
function ensureEnvLoaded(): void {
    if (envLoaded) return
    envLoaded = true

    const envFile = resolveProjectFile('.env')
    if (!envFile) return

    const raw = fs.readFileSync(envFile, 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue

        const eq = trimmed.indexOf('=')
        if (eq === -1) continue

        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }

        if (process.env[key] === undefined) {
            process.env[key] = value
        }
    }
}

export async function saveSessionData(
    sessionPath: string,
    cookies: Cookie[],
    email: string,
    isMobile: boolean
): Promise<void> {
    const dir = path.resolve(process.cwd(), sessionPath)
    fs.mkdirSync(dir, { recursive: true })

    const file = path.join(dir, `${email.replace(/[@.]/g, '_')}_${isMobile ? 'mobile' : 'desktop'}.json`)
    const data = {
        cookies,
        savedAt: Date.now()
    }
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2))
}

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

// Check root -> dist -> src (not in dist, but root)
function resolveProjectFile(filename: string): string | undefined {
    const root = getProjectRoot()
    const candidates = [
        path.join(process.cwd(), filename),
        path.join(root, filename),
        path.join(root, 'dist', filename),
        path.join(root, 'src', filename)
    ]
    return candidates.find(p => fs.existsSync(p))
}

export function loadAccounts(): Account[] {
    try {
        ensureEnvLoaded()

        let file = 'accounts.json'

        if (process.argv.includes('-dev')) {
            file = 'accounts.dev.json'
        }

        const accountFile = resolveProjectFile(file)
        if (!accountFile) {
            throw new Error(
                `accounts.json not found - place it in the project root (dist/ and src/ are also searched as fallbacks)`
            )
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
        throw new Error(error instanceof Error ? error.message : String(error))
    }
}

export function loadConfig(): Config {
    try {
        ensureEnvLoaded()

        if (configCache) {
            return configCache
        }

        // Check root -> dist -> src (not in dist, but root)
        const configPath = resolveProjectFile('config.json')
        if (!configPath) {
            throw new Error(
                'config.json not found - place it in the project root (dist/ and src/ are also searched as fallbacks)'
            )
        }
        const config = fs.readFileSync(configPath, 'utf-8')

        const unverifiedConfig = JSON.parse(config)
        const configData = validateConfig(unverifiedConfig)

        configCache = configData

        return configData
    } catch (error) {
        throw new Error(error as string)
    }
}
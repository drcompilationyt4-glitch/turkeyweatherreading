import type { Page } from 'patchright'
import readline from 'readline'
import fs from 'fs'
import path from 'path'

export interface PromptOptions {
    question: string
    timeoutSeconds?: number
    validate?: (input: string) => boolean
    transform?: (input: string) => string
    // Shown to whoever answers the prompt (the account the code is for)
    label?: string
}

// When set, prompts are answered by writing a response file into this directory
// instead of reading the terminal - lets an orchestrator relay codes in headless/background mode.
const RELAY_DIR = process.env.MR_CODE_RELAY_DIR

export function canPromptForInput(): boolean {
    return process.stdin.isTTY === true || !!RELAY_DIR
}

// Reads the answer from <RELAY_DIR>/response.json ({ id, value }); writes the request to request.json.
// A value of "__SKIP__" resolves as null (same as a timeout) so the caller moves on.
function promptViaRelay(options: PromptOptions): Promise<string | null> {
    const dir = RELAY_DIR as string
    const { question, timeoutSeconds = 60, validate, transform, label } = options
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const requestPath = path.join(dir, 'request.json')
    const responsePath = path.join(dir, 'response.json')
    // Give a human time to fetch the code even if the caller asked for a short window
    const waitMs = Math.max(timeoutSeconds, 300) * 1000

    try {
        fs.mkdirSync(dir, { recursive: true })
        const tmp = requestPath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify({ id, label: label ?? null, question, ts: Date.now() }))
        fs.renameSync(tmp, requestPath)
    } catch {
        return Promise.resolve(null)
    }

    const deadline = Date.now() + waitMs

    return new Promise(resolve => {
        const finish = (result: string | null) => {
            clearInterval(timer)
            try {
                fs.rmSync(requestPath, { force: true })
            } catch {
                /* ignore */
            }
            resolve(result)
        }

        const timer = setInterval(() => {
            if (Date.now() > deadline) return finish(null)
            let raw: string
            try {
                if (!fs.existsSync(responsePath)) return
                raw = fs.readFileSync(responsePath, 'utf8')
            } catch {
                return
            }
            let parsed: { id?: string; value?: string }
            try {
                parsed = JSON.parse(raw)
            } catch {
                return // half-written file, try again next tick
            }
            if (!parsed || parsed.id !== id || typeof parsed.value !== 'string') return
            try {
                fs.rmSync(responsePath, { force: true })
            } catch {
                /* ignore */
            }

            if (parsed.value === '__SKIP__') return finish(null)
            let value = parsed.value.trim()
            if (transform) value = transform(value)
            if (validate && !validate(value)) return finish(null)
            finish(value)
        }, 1000)
    })
}

export function promptInput(options: PromptOptions): Promise<string | null> {
    if (RELAY_DIR) return promptViaRelay(options)
    if (!canPromptForInput()) return Promise.resolve(null)

    const { question, timeoutSeconds = 60, validate, transform } = options

    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        })

        let resolved = false

        const cleanup = (result: string | null) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            rl.close()
            resolve(result)
        }

        const timer = setTimeout(() => cleanup(null), timeoutSeconds * 1000)

        rl.question(question, answer => {
            let value = answer.trim()
            if (transform) value = transform(value)

            if (validate && !validate(value)) {
                cleanup(null)
                return
            }

            cleanup(value)
        })
    })
}

export async function getSubtitleMessage(page: Page): Promise<string | null> {
    const message = await page
        .waitForSelector('[data-testid="subtitle"], div#oneTimeCodeDescription, [data-testid="description"]', {
            state: 'visible',
            timeout: 1000
        })
        .catch(() => null)

    if (!message) return null

    const text = await message.innerText()
    return text.trim()
}

export async function getErrorMessage(page: Page): Promise<string | null> {
    const errorAlert = await page
        .waitForSelector('div[role="alert"]', { state: 'visible', timeout: 1000 })
        .catch(() => null)

    if (!errorAlert) return null

    const text = await errorAlert.innerText()
    return text.trim()
}

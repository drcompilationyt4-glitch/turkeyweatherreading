import axios from 'axios'
import chalk from 'chalk'

import { Ntfy } from './Ntfy'
import { loadConfig } from './Load'
import { DISCORD } from '../constants'

const DEFAULT_LIVE_LOG_USERNAME = 'MS Rewards - Live Logs'

type WebhookBuffer = {
    lines: string[]
    sending: boolean
    timer?: NodeJS.Timeout
    lastActivity?: number
}

const webhookBuffers = new Map<string, WebhookBuffer>()

// Periodic cleanup of old/idle webhook buffers to prevent memory leaks
setInterval(() => {
    const now = Date.now()
    const BUFFER_MAX_AGE_MS = 3600000 // 1 hour

    for (const [url, buf] of webhookBuffers.entries()) {
        if (!buf.sending && buf.lines.length === 0) {
            const lastActivity = buf.lastActivity || 0
            if (now - lastActivity > BUFFER_MAX_AGE_MS) {
                webhookBuffers.delete(url)
            }
        }
    }
}, 600000) // Check every 10 minutes

function getBuffer(url: string): WebhookBuffer {
    let buf = webhookBuffers.get(url)
    if (!buf) {
        buf = { lines: [], sending: false, lastActivity: Date.now() }
        webhookBuffers.set(url, buf)
    }
    buf.lastActivity = Date.now()
    return buf
}

async function sendBatch(url: string, buf: WebhookBuffer) {
    if (buf.sending) return
    buf.sending = true

    const configData = loadConfig()
    const webhookUsername = configData.webhook?.username || DEFAULT_LIVE_LOG_USERNAME
    const webhookAvatarUrl = configData.webhook?.avatarUrl || DISCORD.AVATAR_URL

    while (buf.lines.length > 0) {
        const chunk: string[] = []
        let currentLength = 0
        while (buf.lines.length > 0) {
            const next = buf.lines[0]!
            const projected = currentLength + next.length + (chunk.length > 0 ? 1 : 0)
            if (projected > DISCORD.MAX_EMBED_LENGTH && chunk.length > 0) break
            buf.lines.shift()
            chunk.push(next)
            currentLength = projected
        }

        const content = chunk.join('\n').slice(0, DISCORD.MAX_EMBED_LENGTH)
        if (!content) continue

        // Enhanced webhook payload with embed, username and avatar
        const payload = {
            username: webhookUsername,
            avatar_url: webhookAvatarUrl,
            embeds: [{
                description: `\`\`\`\n${content}\n\`\`\``,
                color: determineColorFromContent(content),
                timestamp: new Date().toISOString()
            }]
        }

        try {
            await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: DISCORD.WEBHOOK_TIMEOUT })
            // Respect a small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, DISCORD.RATE_LIMIT_DELAY))
        } catch (error) {
            // Re-queue failed batch at front and exit loop
            buf.lines = chunk.concat(buf.lines)
            console.error('[Webhook] live log delivery failed:', error)
            break
        }
    }

    buf.sending = false
}

function determineColorFromContent(content: string): number {
    const lower = content.toLowerCase()
    if (lower.includes('[banned]') || lower.includes('[security]') || lower.includes('suspended') || lower.includes('compromised')) {
        return DISCORD.COLOR_RED
    }
    if (lower.includes('[error]') || lower.includes('✗')) {
        return DISCORD.COLOR_CRIMSON
    }
    if (lower.includes('[warn]') || lower.includes('⚠')) {
        return DISCORD.COLOR_ORANGE
    }
    if (lower.includes('[ok]') || lower.includes('✓') || lower.includes('complet')) {
        return DISCORD.COLOR_GREEN
    }
    if (lower.includes('[main]')) {
        return DISCORD.COLOR_BLUE
    }
    return 0x95A5A6 // Gray
}

function enqueueWebhookLog(url: string, line: string) {
    const buf = getBuffer(url)
    buf.lines.push(line)
    // debounce sending to batch multiple short-lived logs
    if (!buf.timer) {
        buf.timer = setTimeout(() => {
            buf.timer = undefined
            void sendBatch(url, buf)
        }, DISCORD.DEBOUNCE_DELAY)
    }
}

/**
 * Synchronous logger that returns an Error when type === 'error' so callers can `throw log(...)` safely.
 *
 * isMobile: true | false | 'main' (main = overall runner)
 * title: short title/category of the log (used for exclusion checks)
 * message: full human-readable message
 * type: 'log' | 'warn' | 'error'
 * color: optional chalk color key
 */
export function log(
    isMobile: boolean | 'main',
    title: string,
    message: string,
    type: 'log' | 'warn' | 'error' = 'log',
    color?: keyof typeof chalk
): Error | void {
    const configData = loadConfig()

    // Backwards-compatible ways projects may have stored logging excludes
    const configAny = configData as unknown as Record<string, unknown>
    const loggingAny = (configAny.logging ?? {}) as Record<string, unknown>

    // log exclude candidates: logging.excludeFunc | logging.logExcludeFunc | config.logExcludeFunc
    const logExcludeFunc: string[] = Array.isArray(loggingAny.excludeFunc) ? (loggingAny.excludeFunc as string[])
        : Array.isArray(loggingAny.logExcludeFunc) ? (loggingAny.logExcludeFunc as string[])
            : Array.isArray((configData as any).logExcludeFunc) ? (configData as any).logExcludeFunc
                : []

    if (Array.isArray(logExcludeFunc) && logExcludeFunc.some((x: string) => x.toLowerCase() === title.toLowerCase())) {
        return
    }

    const currentTime = new Date().toLocaleString()
    const platformText = isMobile === 'main' ? 'MAIN' : isMobile ? 'MOBILE' : 'DESKTOP'

    // redact emails: support logging.redactEmails and logging.live?.redactEmails
    type LiveCfg = { enabled?: boolean; redactEmails?: boolean; url?: string }
    type LoggingCfg = { excludeFunc?: string[]; webhookExcludeFunc?: string[]; live?: LiveCfg; redactEmails?: boolean; liveWebhookUrl?: string }
    const loggingCfg = (configAny.logging || {}) as LoggingCfg
    const shouldRedact = !!(loggingCfg.live?.redactEmails || loggingCfg.redactEmails)
    const redact = (s: string) => shouldRedact ? s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, (m) => {
        const [u, d] = m.split('@'); return `${(u || '').slice(0, 2)}***@${d || ''}`
    }) : s
    const cleanStr = redact(`[${currentTime}] [PID: ${process.pid}] [${type.toUpperCase()}] ${platformText} [${title}] ${message}`)

    // NTFY conditions - check substrings against message (case-insensitive)
    const msgLower = message.toLowerCase()
    const ntfyConditions: Record<'log' | 'warn' | 'error', string[]> = {
        log: ['started tasks for account', 'press the number', 'no points to earn'],
        warn: ['aborting', "didn't gain"],
        error: []
    }
    try {
        const arr = ntfyConditions[type] ?? []
        if (arr.some(substr => msgLower.includes(substr))) {
            // Fire-and-forget
            Promise.resolve(Ntfy(cleanStr, type)).catch(() => { /* ignore ntfy errors */ })
        }
    } catch { /* ignore */ }

    // Console formatting & icons
    const typeIndicator = type === 'error' ? '✗' : type === 'warn' ? '⚠' : '✓'
    const platformColor = isMobile === 'main' ? chalk.cyan : isMobile ? chalk.blue : chalk.magenta
    const typeColor = type === 'error' ? chalk.red : type === 'warn' ? chalk.yellow : chalk.green

    const titleLower = title.toLowerCase()
    // ASCII-safe icon map for PowerShell compatibility
    const iconMap: Array<[RegExp, string]> = [
        [/security|compromised/i, '[SECURITY]'],
        [/ban|suspend/i, '[BANNED]'],
        [/error/i, '[ERROR]'],
        [/warn/i, '[WARN]'],
        [/success|complet/i, '[OK]'],
        [/login/i, '[LOGIN]'],
        [/point/i, '[POINTS]'],
        [/search/i, '[SEARCH]'],
        [/activity|quiz|poll/i, '[ACTIVITY]'],
        [/browser/i, '[BROWSER]'],
        [/main/i, '[MAIN]']
    ]

    let icon = ''
    for (const [pattern, symbol] of iconMap) {
        if (pattern.test(titleLower) || pattern.test(msgLower)) {
            icon = chalk.dim(symbol)
            break
        }
    }
    const iconPart = icon ? icon + ' ' : ''

    const formattedStr = [
        chalk.gray(`[${currentTime}]`),
        chalk.gray(`[${process.pid}]`),
        typeColor(`${typeIndicator}`),
        platformColor(`[${platformText}]`),
        chalk.bold(`[${title}]`),
        iconPart + redact(message)
    ].join(' ')

    const applyChalk = color && typeof (chalk as any)[color] === 'function' ? (chalk as any)[color] as (msg: string) => string : null

    switch (type) {
        case 'warn':
            applyChalk ? console.warn(applyChalk(formattedStr)) : console.warn(formattedStr)
            break
        case 'error':
            applyChalk ? console.error(applyChalk(formattedStr)) : console.error(formattedStr)
            break
        default:
            applyChalk ? console.log(applyChalk(formattedStr)) : console.log(formattedStr)
            break
    }

    // Live webhook streaming (batched)
    try {
        const webhookCfg = configData.webhook || {}
        // support explicit logging.liveWebhookUrl override or nested logging.live.url, or fallback to config webhook
        const liveUrlRaw = typeof loggingCfg.liveWebhookUrl === 'string' ? loggingCfg.liveWebhookUrl.trim() : ''
        const nestedLiveUrl = typeof loggingCfg.live?.url === 'string' ? (loggingCfg.live!.url as string).trim() : ''
        const liveUrl = liveUrlRaw || nestedLiveUrl || (webhookCfg.enabled && webhookCfg.url ? webhookCfg.url : '')

        // compute webhook exclusion list (support logging.webhookExcludeFunc, loggingCfg.webhookExcludeFunc, config.webhookLogExcludeFunc)
        const webhookExclude: string[] = Array.isArray(loggingCfg.webhookExcludeFunc) ? loggingCfg.webhookExcludeFunc
            : Array.isArray((configData as any).webhookLogExcludeFunc) ? (configData as any).webhookLogExcludeFunc
                : []

        const webhookExcluded = Array.isArray(webhookExclude) && webhookExclude.some((x: string) => x.toLowerCase() === title.toLowerCase())

        if (liveUrl && !webhookExcluded) {
            enqueueWebhookLog(liveUrl, cleanStr)
        }
    } catch (error) {
        console.error('[Logger] Failed to enqueue webhook log:', error)
    }

    // Optionally send immediate live JSON payload (backwards-compatible simple webhook) - best effort and non-blocking
    try {
        const liveCfg = loggingCfg.live || {}
        const liveWebhookUrl = (loggingCfg as any).liveWebhookUrl || liveCfg.url || ''
        const webhookCfg = (configData as any).webhook || {}
        const targetUrl = (typeof liveWebhookUrl === 'string' && liveWebhookUrl) ? liveWebhookUrl : (webhookCfg.enabled && webhookCfg.url ? webhookCfg.url : '')
        const liveEnabled = !!liveCfg.enabled && !!webhookCfg.enabled && typeof targetUrl === 'string' && !!targetUrl
        if (liveEnabled) {
            const exclude = Array.isArray(loggingCfg.webhookExcludeFunc) ? loggingCfg.webhookExcludeFunc : []
            if (!exclude.some((x: string) => String(x).toLowerCase() === String(title).toLowerCase())) {
                const payload = { content: cleanStr }
                axios.post(targetUrl as string, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }).catch(() => { /* ignore */ })
            }
        }
    } catch { /* ignore live log errors */ }

    // Return an Error when logging an error so callers can `throw log(...)`
    if (type === 'error') {
        return new Error(cleanStr)
    }
}

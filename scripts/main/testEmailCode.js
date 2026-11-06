// Checks that the bot can read Microsoft code emails for an account.
// Usage: node scripts/main/testEmailCode.js [email] [--wait]
//   no flag : shows the newest Microsoft code from the last 3 days
//   --wait  : waits up to 3 minutes for a NEW code (trigger "send code" on Microsoft while it runs)
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const { EmailCodeFetcher } = require(path.join(root, 'dist', 'util', 'EmailCodeFetcher.js'))

const args = process.argv.slice(2)
const wait = args.includes('--wait')
const email = args.find(a => !a.startsWith('--'))

const accountsFile = ['accounts.json', 'dist/accounts.json', 'src/accounts.json']
    .map(f => path.join(root, f))
    .find(f => fs.existsSync(f))
const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf-8'))
const account = email ? accounts.find(a => a.email.toLowerCase() === email.toLowerCase()) : accounts[0]
if (!account) {
    console.error(`Account ${email} not found in ${accountsFile}`)
    process.exit(1)
}

const fetcher = new EmailCodeFetcher({
    user: account.emailCode?.user || account.email,
    passwords: [account.emailCode?.appPassword, account.password].filter(Boolean),
    host: account.emailCode?.imapHost,
    port: account.emailCode?.imapPort,
    targetHint: account.email,
    log: (level, message) => console.log(`[${level}] ${message}`)
})

try {
    const found = wait
        ? await fetcher.waitForCode({ notBefore: Date.now(), timeoutMs: 180_000 })
        : await fetcher.findLatestCode(Date.now() - 3 * 24 * 60 * 60 * 1000)
    console.log(found ? `[result] code=${found.code} received=${found.receivedAt.toISOString()} in "${found.mailbox}"` : '[result] no code email found')
} catch (error) {
    console.error(`[error] ${error.message}`)
    process.exitCode = 1
} finally {
    await fetcher.close()
}

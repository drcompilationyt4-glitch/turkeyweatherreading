import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { AccountProxy } from '../interface/Account'

class AxiosClient {
    private instance: AxiosInstance
    private account: AccountProxy

    constructor(account: AccountProxy) {
        this.account = account
        this.instance = axios.create()

        // when using custom agents, disable axios built-in proxy handling
        // otherwise axios's proxy config may conflict with the agent (and sometimes expects username/password).
        this.instance.defaults.proxy = false

        // If a proxy configuration is provided, set up the agent
        if (this.account.url && this.account.proxyAxios) {
            const agent = this.getAgentForProxy(this.account)
            this.instance.defaults.httpAgent = agent
            this.instance.defaults.httpsAgent = agent
        }
    }

    /**
     * Build an appropriate agent for the provided proxy configuration.
     * Returns an agent instance (http(s) or socks). Uses a robust parse/normalize approach:
     *  - accepts scheme-less host (assumes http)
     *  - normalizes socks5h:// -> socks5://
     *  - encodes username/password into the proxy URL
     */
    // use `any` here for simplicity — the agent constructors/types differ by package
    private getAgentForProxy(proxyConfig: AccountProxy): any {
        let { url, port, username, password } = proxyConfig
        let urlStr = String(url || '')

        // If user provided only host/IP without scheme, assume http
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlStr)) {
            urlStr = `http://${urlStr}`
        }

        // Normalize: many tools/libraries (and Chromium) understand `socks5://` but not `socks5h://`
        urlStr = urlStr.replace(/^socks5h:\/\//i, 'socks5://')

        const parsed = new URL(urlStr)

        // override port if given separately
        if (port) parsed.port = String(port)

        // set username/password on parsed URL if provided
        if (username && username.length) {
            parsed.username = username
            parsed.password = password || ''
        }

        // build a normalized proxy URL without pathname/search/hash and with encoded credentials
        const cred =
            parsed.username && parsed.username.length
                ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password || '')}@`
                : ''

        const hostPort = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
        // parsed.protocol includes trailing ":" (e.g. "http:")
        const proxyUrl = `${parsed.protocol}//${cred}${hostPort}` // e.g. "socks5://user:pass@127.0.0.1:1080"

        // Choose agent by scheme
        if (parsed.protocol.startsWith('http')) {
            return new HttpProxyAgent(proxyUrl)
        } else if (parsed.protocol === 'https:') {
            return new HttpsProxyAgent(proxyUrl)
        } else if (parsed.protocol.startsWith('socks')) {
            // socks-proxy-agent accepts a URL like "socks5://host:port"
            return new SocksProxyAgent(proxyUrl)
        } else {
            throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
        }
    }

    // Generic method to make any Axios request
    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (bypassProxy) {
            const bypassInstance = axios.create()
            // ensure axios doesn't try to use its own proxy system when we explicitly bypass
            bypassInstance.defaults.proxy = false
            return bypassInstance.request(config)
        }

        let lastError: unknown
        const maxAttempts = 2

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await this.instance.request(config)
            } catch (err: unknown) {
                lastError = err
                const axiosErr = err as AxiosError | undefined

                // If server responded with 407 Proxy Authentication Required => try bypassing proxy
                if (axiosErr && axiosErr.response && axiosErr.response.status === 407) {
                    const bypassInstance = axios.create()
                    bypassInstance.defaults.proxy = false
                    return bypassInstance.request(config)
                }

                // Detect common network/proxy errors and optionally retry with exponential backoff
                const e = err as { code?: string; cause?: { code?: string }; message?: string } | undefined
                const code = e?.code || e?.cause?.code
                const isNetErr =
                    code === 'ECONNREFUSED' ||
                    code === 'ETIMEDOUT' ||
                    code === 'ECONNRESET' ||
                    code === 'ENOTFOUND'

                const msg = String(e?.message || '')
                const looksLikeProxyIssue = /proxy|tunnel|socks|agent/i.test(msg)

                if (isNetErr || looksLikeProxyIssue) {
                    if (attempt < maxAttempts) {
                        // Exponential backoff: 1s, 2s, 4s, ...
                        const delayMs = 1000 * Math.pow(2, attempt - 1)
                        await this.sleep(delayMs)
                        continue
                    }
                    // Last attempt failed -> try without proxy as a fallback
                    const bypassInstance = axios.create()
                    bypassInstance.defaults.proxy = false
                    return bypassInstance.request(config)
                }

                // Non-retryable error -> rethrow
                throw err
            }
        }

        // Shouldn't reach here, but keep for type-safety
        throw lastError
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

export default AxiosClient

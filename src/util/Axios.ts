import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
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

  // use `any` here for simplicity — the agent types differ by package
  private getAgentForProxy(proxyConfig: AccountProxy): any {
    let { url, port, username, password } = proxyConfig

    // ensure url is a string
    url = String(url || '')

    // If user provided only host/IP without scheme, assume http
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
      url = `http://${url}`
    }

    // build auth if provided
    let authPart = ''
    if (username && username.length) {
      // encode credentials safely
      const u = encodeURIComponent(username)
      const p = encodeURIComponent(password || '')
      authPart = `${u}:${p}@`
    }

    // Use URL to build a normalized proxy URL
    const parsed = new URL(url)
    // If port is explicitly provided separately, overwrite/assign it
    if (port) parsed.port = String(port)
    // inject auth if needed
    if (authPart) parsed.username = username || ''
    // Note: URL.username & URL.password are the proper fields for credentials
    if (username && username.length) {
      parsed.username = username
      parsed.password = password || ''
    }

    const proxyUrl = parsed.toString() // e.g. "http://user:pass@151.145.36.194:3128/"

    // Choose agent by scheme
    if (parsed.protocol.startsWith('http')) {
      // HttpProxyAgent accepts a URL string like `http://host:port`
      return new HttpProxyAgent(proxyUrl)
    } else if (parsed.protocol === 'https:') {
      return new HttpsProxyAgent(proxyUrl)
    } else if (parsed.protocol.startsWith('socks')) {
      // socks-proxy-agent expects e.g. "socks5://host:port"
      return new SocksProxyAgent(proxyUrl)
    } else {
      throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
    }
  }

  public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
    if (bypassProxy) {
      const bypassInstance = axios.create()
      bypassInstance.defaults.proxy = false
      return bypassInstance.request(config)
    }

    try {
      return await this.instance.request(config)
    } catch (err: unknown) {
      const e = err as { code?: string; cause?: { code?: string }; message?: string } | undefined
      const code = e?.code || e?.cause?.code
      const isNetErr = code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND'
      const msg = String(e?.message || '')
      const looksLikeProxyIssue = /proxy|tunnel|socks|agent/i.test(msg)
      if (!bypassProxy && (isNetErr || looksLikeProxyIssue)) {
        const bypassInstance = axios.create()
        bypassInstance.defaults.proxy = false
        return bypassInstance.request(config)
      }
      throw err
    }
  }
}

export default AxiosClient

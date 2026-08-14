/**
 * 加密保险库：在 Harness 存储域内以 AES-256-GCM 加密保存敏感值（API Key）。
 *
 * 设计说明（安全模型，详见 README「安全与隐私」）：
 * - 主密钥在首次使用时随机生成，保存在同一存储域的 vault-meta 表；
 *   存储后端（json/sqlite）位于 Harness home 的插件沙箱内，不出本机。
 * - 敏感值永远以密文落盘（vault 表），读取时解密，绝不写入日志。
 * - 若部署同时启用了 credentials seam，成本模块会优先经
 *   `ctx.credentials` 解析 DEEPSEEK_API_KEY（值由凭据提供者持有）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage'
import { decryptAes256Gcm, encryptAes256Gcm, generateMasterKey } from './crypto.js'

interface VaultMetaRecord {
  masterKeyB64: string
  createdAt: number
}

interface SecretRecord {
  payload: string
  updatedAt: number
}

/** 存储域内的加密键值保险库。 */
export class SecretVault {
  private readonly meta
  private readonly secrets
  /**
   * 实例级主密钥 promise 缓存：并发的首次访问共享同一次生成/读取，
   * 避免 check-then-act 竞态下生成两把主密钥互相覆盖（密文永久无法解密）。
   */
  private keyPromise?: Promise<Uint8Array>

  constructor(domain: Domain) {
    this.meta = domain.table<VaultMetaRecord>('vault-meta')
    this.secrets = domain.table<SecretRecord>('vault')
  }

  /** 写入（或覆盖）一个加密秘密。 */
  async setSecret(name: string, value: string): Promise<void> {
    const key = await this.masterKey()
    await this.secrets.put(name, {
      payload: encryptAes256Gcm(value, key),
      updatedAt: Date.now(),
    })
  }

  /** 读取并解密一个秘密；不存在或解密失败返回 undefined。 */
  async getSecret(name: string): Promise<string | undefined> {
    const record = this.secrets.get(name)
    if (!record) return undefined
    try {
      const key = await this.masterKey()
      return decryptAes256Gcm(record.payload, key)
    } catch {
      // 主密钥损坏或载荷被篡改：按“未配置”处理，避免抛出内部细节。
      return undefined
    }
  }

  /** 秘密是否已配置。 */
  hasSecret(name: string): boolean {
    return this.secrets.get(name) !== undefined
  }

  /** 删除一个秘密。 */
  async deleteSecret(name: string): Promise<void> {
    await this.secrets.delete(name)
  }

  /** 获取主密钥（memoized：全实例只生成/读取一次）。 */
  private masterKey(): Promise<Uint8Array> {
    if (!this.keyPromise) {
      const current = this.loadOrCreateMasterKey()
      current.catch(() => {
        // 初始化失败（如存储后端瞬时错误）不缓存，允许后续访问重试；
        // 成功路径的 promise 永久缓存，保证密钥只生成一次。
        if (this.keyPromise === current) this.keyPromise = undefined
      })
      this.keyPromise = current
    }
    return this.keyPromise
  }

  /** 实际执行主密钥的读取或首次生成（仅经 masterKey 的缓存调用）。 */
  private async loadOrCreateMasterKey(): Promise<Uint8Array> {
    let record = this.meta.get('master')
    if (!record) {
      record = {
        masterKeyB64: Buffer.from(generateMasterKey()).toString('base64'),
        createdAt: Date.now(),
      }
      await this.meta.put('master', record)
    }
    return Uint8Array.from(Buffer.from(record.masterKeyB64, 'base64'))
  }
}

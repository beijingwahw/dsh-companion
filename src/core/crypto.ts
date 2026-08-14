/**
 * AES-256-GCM 对称加密原语（Node crypto 实现）。
 *
 * 载荷格式：`v1.<iv base64>.<authTag base64>.<ciphertext base64>`。
 * 用于 API Key 等敏感值的落盘加密（需求：AES-256 强加密存储）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const CIPHER_ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const PAYLOAD_VERSION = 'v1'

/** 生成 256 位主密钥（首次初始化保险库时调用）。 */
export function generateMasterKey(): Uint8Array {
  return randomBytes(32)
}

/**
 * 使用 AES-256-GCM 加密明文。
 * @param plaintext 明文字符串。
 * @param key 32 字节密钥。
 * @returns 自描述的 base64 载荷字符串。
 */
export function encryptAes256Gcm(plaintext: string, key: Uint8Array): string {
  assertKeyLength(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    PAYLOAD_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    data.toString('base64'),
  ].join('.')
}

/**
 * 解密 encryptAes256Gcm 产出的载荷。
 * @param payload 载荷字符串。
 * @param key 32 字节密钥。
 * @returns 明文字符串。
 * @throws 载荷格式非法或认证标签校验失败时抛出。
 */
export function decryptAes256Gcm(payload: string, key: Uint8Array): string {
  assertKeyLength(key)
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error('invalid encrypted payload: unrecognized format')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64!, 'base64')
  const authTag = Buffer.from(tagB64!, 'base64')
  // 解码后先校验结构（IV 12 字节、认证标签 16 字节），给出统一的格式错误，
  // 避免非法 base64 解码出任意长度后才在 crypto 内部抛出晦涩异常。
  if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error('invalid encrypted payload: bad iv or auth tag length')
  }
  const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64!, 'base64')),
    decipher.final(),
  ])
  return plain.toString('utf8')
}

function assertKeyLength(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new Error(`AES-256 key must be 32 bytes, got ${key.byteLength}`)
  }
}

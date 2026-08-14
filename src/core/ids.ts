/**
 * 品牌类型构造器：跨边界的不透明 id 统一经此铸造，禁止裸 string 直传。
 */
import type {
  CredentialRef as CredentialRefId,
  ScopeKey as ScopeKeyId,
  SessionId as SessionIdId,
} from '../types/harness.js'

export type SessionId = SessionIdId
export type CredentialRef = CredentialRefId
export type ScopeKey = ScopeKeyId

/** 将字符串铸造为 SessionId。 */
export function SessionId(value: string): SessionId {
  return value as SessionId
}

/** 将字符串铸造为 CredentialRef。 */
export function CredentialRef(value: string): CredentialRef {
  return value as CredentialRef
}

/** 将字符串铸造为 ScopeKey。 */
export function ScopeKey(value: string): ScopeKey {
  return value as ScopeKey
}

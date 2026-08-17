/**
 * 品牌类型构造器：跨边界的不透明 id 统一经此铸造，禁止裸 string 直传。
 */
import type { CredentialRef as CredentialRefId, ScopeKey as ScopeKeyId, SessionId as SessionIdId } from '../types/harness.js';
export type SessionId = SessionIdId;
export type CredentialRef = CredentialRefId;
export type ScopeKey = ScopeKeyId;
/** 将字符串铸造为 SessionId。 */
export declare function SessionId(value: string): SessionId;
/** 将字符串铸造为 CredentialRef。 */
export declare function CredentialRef(value: string): CredentialRef;
/** 将字符串铸造为 ScopeKey。 */
export declare function ScopeKey(value: string): ScopeKey;

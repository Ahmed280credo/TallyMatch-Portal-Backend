import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { Injectable, InternalServerErrorException } from "@nestjs/common";

// Encrypts/decrypts ERP connection passwords at rest (Supabase column
// erp_connections.password_encrypted). Not part of the global env.validation.ts
// schema — like the rest of the ERP integration, this is optional prep work
// and the app must still boot without it configured; it only throws when
// something actually tries to save/read a connection's password.
//
// Deliberately NOT relying on Supabase pgcrypto/Vault — there's no existing
// per-org secret storage pattern in this codebase to follow (everything else
// is env-var secrets), so this keeps encryption entirely in the backend with
// a single env-held key, matching the app's existing "secrets live in env
// vars, never in committed code" posture as closely as a per-org secret can.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function deriveKey(): Buffer {
  const secret = process.env.ERP_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) {
    throw new InternalServerErrorException(
      "ERP_CREDENTIALS_ENCRYPTION_KEY is not set — cannot encrypt/decrypt ERP connection credentials"
    );
  }
  // scrypt with a fixed salt is fine here: the secret itself is the actual
  // entropy source (an env var only the backend has), this just shapes it
  // into a valid 32-byte AES-256 key.
  return scryptSync(secret, "erp-connections-salt", 32);
}

@Injectable()
export class ErpCredentialsCryptoService {
  encrypt(plaintext: string): string {
    const key = deriveKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // iv (12 bytes) + authTag (16 bytes) + ciphertext, base64-packed together
    // so the column stores one opaque string.
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  }

  decrypt(packed: string): string {
    const key = deriveKey();
    const buf = Buffer.from(packed, "base64");
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = buf.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }
}

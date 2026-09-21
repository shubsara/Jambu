/**
 * Supabase clients (decision D2).
 *
 * Two clients, deliberately separate:
 *
 *   admin — service-role key. Bypasses RLS. Server-side only, never logged,
 *           never returned in a response, never shipped to the extension.
 *   auth  — anon key. Used only to exchange credentials for tokens, so that
 *           password verification stays entirely inside Supabase Auth
 *           (CLAUDE.md §24).
 */
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config.js';

export interface SupabaseClients {
  /** Service-role client. Bypasses RLS — every query must filter by user id. */
  readonly admin: SupabaseClient;
  /** Anon client, used for credential exchange only. */
  readonly auth: SupabaseClient;
}

export function createSupabaseClients(config: AppConfig): SupabaseClients {
  const shared = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  };

  return {
    admin: createClient(config.supabaseUrl, config.supabaseServiceRoleKey, shared),
    auth: createClient(config.supabaseUrl, config.supabaseAnonKey, shared),
  };
}

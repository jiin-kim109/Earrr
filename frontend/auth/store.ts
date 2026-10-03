import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import type { PublicAuthConfig, UserProfile } from '../../shared/types/user.js';

export type AuthView =
  | 'login'
  | 'signup'
  | 'verify'
  | 'forgot-password'
  | 'verify-recovery'
  | 'new-password';
export interface AuthState {
  view: AuthView | null;
  config: PublicAuthConfig | null;
  session: Session | null;
  profile: UserProfile | null;
  profileError: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  pendingEmail: string;
}

export const useAuth = create<AuthState>(() => ({
  view: null,
  config: null,
  session: null,
  profile: null,
  profileError: null,
  busy: false,
  error: null,
  notice: null,
  pendingEmail: '',
}));

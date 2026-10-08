import { useCallback, useState } from 'react';

import { login as loginRequest } from '@/features/auth/services/authApi';
import { useAuth } from '@/store/authStore';

export function useLogin() {
  const { login } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setError(null);
      setIsSubmitting(true);
      try {
        const result = await loginRequest(email, password);
        login(result.token, result.user, result.refreshToken);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [login]
  );

  return { submit, isSubmitting, error };
}

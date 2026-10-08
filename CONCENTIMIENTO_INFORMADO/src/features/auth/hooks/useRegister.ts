import { useCallback, useState } from 'react';

import { register as registerRequest } from '@/features/auth/services/authApi';
import { useAuth } from '@/store/authStore';

export function useRegister() {
  const { login } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (name: string, email: string, password: string): Promise<boolean> => {
      setError(null);
      setIsSubmitting(true);
      try {
        const result = await registerRequest(email, password, name);
        // Registration logs the user straight in, same as a successful login.
        login(result.token, result.user, result.refreshToken);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo crear la cuenta');
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [login]
  );

  return { submit, isSubmitting, error };
}
